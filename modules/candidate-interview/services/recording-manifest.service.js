import fs from 'fs';
import {
  getManifestPath,
  getSessionRecordingDir,
  sha256File,
  chunkFilename,
} from './recording-disk-storage.service.js';
import { recordingDebug } from './recording-debug.service.js';

function defaultManifest(sessionId) {
  const now = new Date().toISOString();
  return {
    session_id: Number(sessionId),
    total_chunks_expected: null,
    chunks_received: [],
    chunk_sizes: {},
    chunk_checksums: {},
    merge_status: 'pending',
    created_at: now,
    updated_at: now,
  };
}

export function readManifest(sessionId) {
  const manifestPath = getManifestPath(sessionId);
  if (!fs.existsSync(manifestPath)) {
    return defaultManifest(sessionId);
  }
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaultManifest(sessionId),
      ...parsed,
      session_id: Number(sessionId),
      chunks_received: Array.isArray(parsed.chunks_received)
        ? [...new Set(parsed.chunks_received.map(Number))].sort((a, b) => a - b)
        : [],
      chunk_sizes: parsed.chunk_sizes || {},
      chunk_checksums: parsed.chunk_checksums || {},
    };
  } catch (err) {
    recordingDebug('manifest_read_failed', { session_id: sessionId, error: err.message });
    return defaultManifest(sessionId);
  }
}

export function writeManifest(sessionId, manifest) {
  getSessionRecordingDir(sessionId);
  const manifestPath = getManifestPath(sessionId);
  const payload = {
    ...manifest,
    session_id: Number(sessionId),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

export function recordChunkInManifest(sessionId, chunkIndex, filePath, { totalChunksExpected = null } = {}) {
  const manifest = readManifest(sessionId);
  const index = Number(chunkIndex);
  const size = fs.statSync(filePath).size;
  let checksum = null;
  try {
    checksum = sha256File(filePath);
  } catch (err) {
    recordingDebug('manifest_checksum_failed', {
      session_id: sessionId,
      chunk_index: index,
      error: err.message,
    });
  }

  if (!manifest.chunks_received.includes(index)) {
    manifest.chunks_received.push(index);
    manifest.chunks_received.sort((a, b) => a - b);
  }
  manifest.chunk_sizes[String(index)] = size;
  if (checksum) manifest.chunk_checksums[String(index)] = checksum;

  if (totalChunksExpected != null) {
    manifest.total_chunks_expected = Math.max(
      Number(manifest.total_chunks_expected || 0),
      Number(totalChunksExpected)
    );
  }

  return writeManifest(sessionId, manifest);
}

export function finalizeManifestExpectation(sessionId, totalChunksSent) {
  const manifest = readManifest(sessionId);
  manifest.total_chunks_expected = Number(totalChunksSent);
  manifest.end_received_at = new Date().toISOString();
  return writeManifest(sessionId, manifest);
}

export function setManifestMergeStatus(sessionId, mergeStatus, extra = {}) {
  const manifest = readManifest(sessionId);
  manifest.merge_status = mergeStatus;
  Object.assign(manifest, extra);
  return writeManifest(sessionId, manifest);
}

export function getMissingChunkIndexes(manifest) {
  const expected = Number(manifest.total_chunks_expected);
  if (!Number.isFinite(expected) || expected <= 0) return [];

  const received = new Set((manifest.chunks_received || []).map(Number));
  const missing = [];
  for (let i = 0; i < expected; i += 1) {
    if (!received.has(i)) missing.push(i);
  }
  return missing;
}

/** Largest contiguous chunk sequence starting at index 0. */
export function getLargestContiguousSequence(manifest) {
  const indices = [...(manifest.chunks_received || [])].map(Number).sort((a, b) => a - b);
  if (!indices.length) return [];

  const sequence = [];
  for (let i = 0; i < indices.length; i += 1) {
    if (i === 0 && indices[0] !== 0) break;
    if (i > 0 && indices[i] !== indices[i - 1] + 1) break;
    sequence.push(indices[i]);
  }
  return sequence;
}

export function getChunkPathsForIndexes(sessionId, indexes) {
  return indexes.map((index) => {
    const filename = chunkFilename(index);
    return {
      index,
      path: `${getSessionRecordingDir(sessionId)}/${filename}`.replace(/\\/g, '/'),
      filename,
    };
  });
}

export function sumChunkSizes(manifest, indexes) {
  return indexes.reduce((sum, idx) => sum + Number(manifest.chunk_sizes[String(idx)] || 0), 0);
}
