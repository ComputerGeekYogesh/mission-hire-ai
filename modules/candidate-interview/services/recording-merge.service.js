import fs, { createWriteStream, createReadStream } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { recordingMetadataRepository } from '../repositories/recording-metadata.repository.js';
import { recordingRepository } from '../repositories/recording.repository.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { interviewConfig } from '../config.js';
import { recordingDebug } from './recording-debug.service.js';
import {
  getMergedRecordingPath,
  getPartialRecordingPath,
  getChunkPath,
  listChunkFilesOnDisk,
  assertPathWithinRecordingsRoot,
  relativePathFromBase,
  verifyMergedRecordingFile,
  cleanupSessionRecordingChunks,
} from './recording-disk-storage.service.js';
import {
  readManifest,
  getMissingChunkIndexes,
  getLargestContiguousSequence,
  sumChunkSizes,
  setManifestMergeStatus,
  finalizeManifestExpectation,
} from './recording-manifest.service.js';
import {
  buildSignedRecordingUrlFromAbsolute,
} from './recording-signed-url.service.js';

const MIN_CHUNK_BYTES = 200;

export class MergeMissingChunksError extends Error {
  constructor(sessionId, missingIndexes = []) {
    super(`Missing chunk indexes: ${missingIndexes.join(', ')}`);
    this.name = 'MergeMissingChunksError';
    this.code = 'MERGE_MISSING_CHUNKS';
    this.sessionId = sessionId;
    this.missingIndexes = missingIndexes;
  }
}

/** Sorted chunk indexes that exist on disk and meet minimum size. */
function resolveAvailableMergeIndexes(sessionId, manifest) {
  const manifestIndexes = (manifest.chunks_received || []).map(Number);
  const diskIndexes = listChunkFilesOnDisk(sessionId).map((c) => c.chunkIndex);
  const candidateIndexes = [...new Set([...manifestIndexes, ...diskIndexes])].sort((a, b) => a - b);

  return candidateIndexes.filter((index) => {
    const chunkPath = getChunkPath(sessionId, index);
    return fs.existsSync(chunkPath) && fs.statSync(chunkPath).size >= MIN_CHUNK_BYTES;
  });
}

async function finalizeSuccessfulMerge(sessionId, {
  outputPath,
  outputBytes,
  mergeIndexes,
  missing,
  manifest,
  recordingStatus,
  mergeStatus,
  mergeMeta = {},
}) {
  const signedUrl = buildSignedRecordingUrlFromAbsolute(sessionId, outputPath);
  const row = await upsertInterviewRecordingRow(sessionId, outputPath, {
    chunk_count: mergeIndexes.length,
    partial: recordingStatus === 'partial',
    missing_chunk_count: missing.length,
    missing_chunk_indexes: missing.length ? missing : undefined,
    merge_method: 'binary_concat',
    ...mergeMeta,
  });

  await updateMetadata(sessionId, {
    total_chunks_expected: manifest.total_chunks_expected ?? mergeIndexes.length,
    chunks_received: mergeIndexes.length,
    merge_status: mergeStatus,
    merged_file_path: outputPath,
    merged_file_size_bytes: outputBytes,
    signed_url: signedUrl,
    recording_status: recordingStatus,
  });

  setManifestMergeStatus(sessionId, mergeStatus, {
    merged_file: path.basename(outputPath),
    merged_bytes: outputBytes,
    missing_chunk_indexes: missing,
    merged_chunk_indexes: mergeIndexes,
  });

  if (process.env.RECORDING_FFMPEG_TIMESTAMP_FIX === 'true') {
    const fixedPath = path.join(path.dirname(outputPath), 'full_recording_fixed.webm');
    const fixed = await runFfmpegFixTimestamps(outputPath, fixedPath);
    if (fixed && fs.existsSync(fixedPath)) {
      recordingDebug('merge_ffmpeg_timestamp_fix', { session_id: sessionId, ok: true });
    }
  }

  let cleanupResult = null;
  if (interviewConfig.recordingCleanupChunksAfterMerge !== false) {
    if (verifyMergedRecordingFile(outputPath, MIN_CHUNK_BYTES)) {
      try {
        cleanupResult = cleanupSessionRecordingChunks(sessionId, { mergedFilePath: outputPath });
        recordingDebug('merge_chunk_cleanup', {
          session_id: sessionId,
          deleted: cleanupResult.deleted,
          errors: cleanupResult.errors?.length || 0,
        });
        if (cleanupResult.errors?.length) {
          console.warn(
            `[recording-merge] Session ${sessionId} chunk cleanup partial failure:`,
            cleanupResult.errors.map((e) => e.file).join(', ')
          );
        } else if (cleanupResult.deleted > 0) {
          console.log(
            `[recording-merge] Session ${sessionId} deleted ${cleanupResult.deleted} temporary chunk file(s) after merge`
          );
        }
      } catch (cleanupErr) {
        console.warn(
          `[recording-merge] Session ${sessionId} chunk cleanup failed — merge result kept:`,
          cleanupErr.message
        );
        recordingDebug('merge_chunk_cleanup_failed', {
          session_id: sessionId,
          error: cleanupErr.message,
        });
      }
    } else {
      console.warn(
        `[recording-merge] Session ${sessionId} skipping chunk cleanup — merged file failed verification`
      );
    }
  }

  return {
    recordingId: row.recordingId,
    storageKey: row.storageKey,
    bytes: outputBytes,
    chunkCount: mergeIndexes.length,
    recordingStatus,
    mergeStatus,
    signedUrl,
    partial: recordingStatus === 'partial',
    missingChunks: missing,
    cleanup: cleanupResult,
  };
}

function runFfmpegFixTimestamps(inputPath, outputPath) {
  if (!ffmpegPath || !process.env.RECORDING_FFMPEG_TIMESTAMP_FIX) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpegPath,
      ['-y', '-i', inputPath, '-c', 'copy', outputPath],
      { windowsHide: true }
    );
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function streamConcatFiles(inputPaths, outputPath) {
  assertPathWithinRecordingsRoot(outputPath);
  const writeStream = createWriteStream(outputPath);

  for (const inputPath of inputPaths) {
    assertPathWithinRecordingsRoot(inputPath);
    if (!fs.existsSync(inputPath)) {
      writeStream.destroy();
      throw new Error(`Missing chunk file: ${inputPath}`);
    }
    await new Promise((resolve, reject) => {
      const readStream = createReadStream(inputPath);
      readStream.on('error', (err) => {
        writeStream.destroy();
        reject(err);
      });
      readStream.on('end', resolve);
      readStream.pipe(writeStream, { end: false });
    });
  }

  await new Promise((resolve, reject) => {
    writeStream.on('error', reject);
    writeStream.end(resolve);
  });
}

function resolveExistingChunkPaths(sessionId, indexes) {
  return indexes
    .map((index) => {
      const chunkPath = getChunkPath(sessionId, index);
      return fs.existsSync(chunkPath) && fs.statSync(chunkPath).size >= MIN_CHUNK_BYTES
        ? chunkPath
        : null;
    })
    .filter(Boolean);
}

async function updateMetadata(sessionId, fields) {
  await recordingMetadataRepository.upsertForSession(sessionId, fields);
}

async function upsertInterviewRecordingRow(sessionId, outputPath, meta = {}) {
  const stat = fs.statSync(outputPath);
  const storageKey = `recordings/${relativePathFromBase(outputPath)}`;
  const prior = await recordingRepository.findMergedBySession(sessionId);
  if (prior) {
    await recordingRepository.deleteById(prior.id);
  }

  const recordingId = await recordingRepository.create({
    session_id: sessionId,
    recording_type: 'video',
    storage_key: storageKey,
    mime_type: 'video/webm',
    file_size_bytes: stat.size,
    metadata_json: {
      merged: true,
      storage_backend: 'disk',
      ...meta,
    },
  });

  return { recordingId, storageKey, bytes: stat.size };
}

async function performBinaryMerge(sessionId, indexes, outputPath) {
  const paths = resolveExistingChunkPaths(sessionId, indexes);
  if (!paths.length) {
    throw new Error('No chunk files available to merge');
  }

  if (paths.length === 1) {
    fs.copyFileSync(paths[0], outputPath);
  } else {
    await streamConcatFiles(paths, outputPath);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error('Merged output file was not created');
  }

  return fs.statSync(outputPath).size;
}

function evaluateMergeSize(outputBytes, expectedBytes) {
  if (!expectedBytes) return { ok: true, ratio: 1 };
  const ratio = outputBytes / expectedBytes;
  const minRatio = Number(interviewConfig.recordingMinMergeSizeRatio || 0.8);
  return { ok: ratio >= minRatio, ratio, minRatio };
}

/**
 * Merge session recording from on-disk chunks using binary concatenation.
 */
export async function mergeSessionRecording(sessionId, { force = false, totalChunksExpected = null } = {}) {
  const session = await sessionRepository.findById(sessionId);
  if (!session) throw new Error('Session not found');

  if (totalChunksExpected != null) {
    finalizeManifestExpectation(sessionId, totalChunksExpected);
  }

  const manifest = readManifest(sessionId);
  const missing = getMissingChunkIndexes(manifest);
  if (missing.length) {
    console.warn(
      `[recording-merge] Session ${sessionId} missing ${missing.length} chunk(s) — merging available chunks: ${missing.join(', ')}`
    );
    recordingDebug('merge_missing_chunks', { session_id: sessionId, missing_indexes: missing });
  }

  const metadata = await recordingMetadataRepository.findBySessionId(sessionId);
  if (
    metadata &&
    !force &&
    ['completed', 'partial'].includes(metadata.merge_status) &&
    metadata.merged_file_path &&
    fs.existsSync(metadata.merged_file_path)
  ) {
    return {
      recordingId: (await recordingRepository.findMergedBySession(sessionId))?.id || null,
      storageKey: relativePathFromBase(metadata.merged_file_path),
      alreadyMerged: true,
      recordingStatus: metadata.recording_status,
      signedUrl: metadata.signed_url,
    };
  }

  await updateMetadata(sessionId, { merge_status: 'in_progress' });
  setManifestMergeStatus(sessionId, 'in_progress');

  const mergeIndexes = resolveAvailableMergeIndexes(sessionId, manifest);
  if (!mergeIndexes.length) {
    throw new Error('No chunk files available to merge');
  }

  const mergedPath = getMergedRecordingPath(sessionId);
  const expectedBytes = sumChunkSizes(manifest, mergeIndexes);
  const hasMissingChunks = missing.length > 0;

  recordingDebug('merge_start', {
    session_id: sessionId,
    chunk_count: mergeIndexes.length,
    expected_chunks: manifest.total_chunks_expected ?? null,
    expected_bytes: expectedBytes,
    missing_count: missing.length,
    missing_indexes: missing,
    merge_indexes: mergeIndexes,
  });

  console.log(
    `[recording-merge] Session ${sessionId} merging ${mergeIndexes.length} chunk(s)` +
      (manifest.total_chunks_expected
        ? ` (expected ${manifest.total_chunks_expected}, missing ${missing.length})`
        : '')
  );

  let recordingStatus = hasMissingChunks ? 'partial' : 'full';
  let mergeStatus = hasMissingChunks ? 'partial' : 'completed';

  try {
    const outputBytes = await performBinaryMerge(sessionId, mergeIndexes, mergedPath);

    if (!verifyMergedRecordingFile(mergedPath, MIN_CHUNK_BYTES)) {
      throw new Error('Merged output file is missing or too small');
    }

    const sizeCheck = evaluateMergeSize(outputBytes, expectedBytes);

    if (!sizeCheck.ok) {
      console.warn(
        `[recording-merge] Session ${sessionId} merged size ${outputBytes} bytes is below ${Math.round(
          sizeCheck.minRatio * 100
        )}% of expected ${expectedBytes} bytes (ratio=${sizeCheck.ratio.toFixed(3)})`
      );
      recordingDebug('merge_size_warning', {
        session_id: sessionId,
        output_bytes: outputBytes,
        expected_bytes: expectedBytes,
        ratio: sizeCheck.ratio,
      });
      recordingStatus = 'partial';
      mergeStatus = 'partial';
    }

    console.log(
      `[recording-merge] Session ${sessionId} merge complete — ${outputBytes} bytes, ${mergeIndexes.length} chunks, status=${recordingStatus}` +
        (manifest.total_chunks_expected
          ? ` (expected ${manifest.total_chunks_expected}, missing ${missing.length})`
          : '')
    );
    recordingDebug('merge_complete', {
      session_id: sessionId,
      output_bytes: outputBytes,
      chunk_count: mergeIndexes.length,
      expected_chunks: manifest.total_chunks_expected ?? null,
      missing_count: missing.length,
      recording_status: recordingStatus,
      merge_status: mergeStatus,
    });

    return finalizeSuccessfulMerge(sessionId, {
      outputPath: mergedPath,
      outputBytes,
      mergeIndexes,
      missing,
      manifest,
      recordingStatus,
      mergeStatus,
    });
  } catch (err) {
    console.error(`[recording-merge] Binary merge failed for session ${sessionId}:`, err.message);
    recordingDebug('merge_failed', { session_id: sessionId, error: err.message });

    const fallback = await buildPartialFallback(sessionId, manifest);
    if (fallback) {
      return fallback;
    }

    await updateMetadata(sessionId, { merge_status: 'failed', recording_status: 'partial' });
    setManifestMergeStatus(sessionId, 'failed', { error: err.message });
    throw err;
  }
}

async function buildPartialFallback(sessionId, manifest) {
  const contiguous = getLargestContiguousSequence(manifest);
  const candidates = [];

  if (contiguous.length > 1) {
    candidates.push({ indexes: contiguous, output: getPartialRecordingPath(sessionId), label: 'partial_recording.webm' });
  }

  const diskChunks = listChunkFilesOnDisk(sessionId);
  if (diskChunks.length) {
    const largest = diskChunks.reduce((best, cur) => (cur.size > best.size ? cur : best));
    candidates.push({
      indexes: [largest.chunkIndex],
      output: largest.path,
      label: largest.filename,
      singleChunk: true,
    });
  }

  for (const candidate of candidates) {
    try {
      let outputPath = candidate.output;
      if (!candidate.singleChunk) {
        await performBinaryMerge(sessionId, candidate.indexes, outputPath);
      }

      if (!fs.existsSync(outputPath)) continue;
      const bytes = fs.statSync(outputPath).size;
      if (bytes < MIN_CHUNK_BYTES) continue;
      if (!verifyMergedRecordingFile(outputPath, MIN_CHUNK_BYTES)) continue;

      const missing = getMissingChunkIndexes(manifest);

      recordingDebug('merge_partial_fallback', {
        session_id: sessionId,
        available_chunks: candidate.indexes.length,
        bytes,
        fallback: candidate.label,
      });

      return finalizeSuccessfulMerge(sessionId, {
        outputPath,
        outputBytes: bytes,
        mergeIndexes: candidate.indexes,
        missing,
        manifest,
        recordingStatus: 'partial',
        mergeStatus: 'partial',
        mergeMeta: {
          fallback: true,
          fallback_label: candidate.label,
          merge_method: candidate.singleChunk ? 'single_chunk_fallback' : 'partial_binary_concat',
        },
      });
    } catch (err) {
      recordingDebug('merge_partial_fallback_failed', {
        session_id: sessionId,
        fallback: candidate.label,
        error: err.message,
      });
    }
  }

  return null;
}

export async function remergeSessionRecording(sessionId) {
  const manifest = readManifest(sessionId);
  const available = resolveAvailableMergeIndexes(sessionId, manifest);

  if (!available.length) {
    const metadata = await recordingMetadataRepository.findBySessionId(sessionId);
    const mergedPath = metadata?.merged_file_path || getMergedRecordingPath(sessionId);
    if (verifyMergedRecordingFile(mergedPath)) {
      const signedUrl = buildSignedRecordingUrlFromAbsolute(sessionId, mergedPath);
      const merged = await recordingRepository.findMergedBySession(sessionId);
      await updateMetadata(sessionId, {
        signed_url: signedUrl,
        merge_status: metadata?.merge_status || 'completed',
        merged_file_path: mergedPath,
      });
      recordingDebug('remerge_existing_file', { session_id: sessionId, path: mergedPath });
      return {
        recordingId: merged?.id || null,
        storageKey: merged?.storage_key || relativePathFromBase(mergedPath),
        alreadyMerged: true,
        recordingStatus: metadata?.recording_status || 'partial',
        signedUrl,
        partial: metadata?.recording_status === 'partial',
        remergeFromExisting: true,
      };
    }
    throw new Error('No chunk files or merged recording available to remerge');
  }

  return mergeSessionRecording(sessionId, { force: true });
}
