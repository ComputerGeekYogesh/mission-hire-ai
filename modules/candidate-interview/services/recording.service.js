import path from 'path';
import fs from 'fs';
import moment from 'moment-timezone';
import { recordingRepository } from '../repositories/recording.repository.js';
import {
  getSessionRecordingDir,
  toStorageKey,
  assertPathWithinRoot,
  resolveStorageKey,
} from './storage.service.js';
import { interviewConfig } from '../config.js';
import { mergeSessionRecording } from './recording-merge.service.js';
import { recordingChunkService } from './recording-chunk.service.js';
import { recordingDebug } from './recording-debug.service.js';
import { recordingMetadataRepository } from '../repositories/recording-metadata.repository.js';
import { waitForRecordingChunks } from './recording-chunk-wait.service.js';
import {
  scheduleRecordingMerge,
  getPendingRecordingMerge,
  awaitRecordingMerge,
  runImmediateRecordingMerge,
} from './recording-merge-scheduler.service.js';
import { finalizeManifestExpectation } from './recording-manifest.service.js';
import { ensureRecordingMetadataTable } from './recording-metadata-migration.service.js';

const MIN_ANSWER_BYTES = 2000;

export const recordingService = {
  async saveChunk(session, file, { chunkIndex = 0, totalChunksExpected = null, mimeType = 'video/webm' } = {}) {
    return recordingChunkService.saveChunkToDisk(session, file, {
      chunkIndex,
      totalChunksExpected,
      mimeType: mimeType || file.mimetype || 'video/webm',
    });
  },

  async saveAnswerRecording(session, file, questionId) {
    if (!file?.path) throw new Error('No answer audio file');

    const stat = fs.statSync(file.path);
    if (stat.size < MIN_ANSWER_BYTES) {
      const err = new Error(
        `Answer audio too small (${stat.size} bytes). Speak for several seconds before submitting.`
      );
      err.status = 400;
      throw err;
    }

    const dir = getSessionRecordingDir(session.session_token);
    const base = path.basename(file.path);
    let dest = path.join(dir, base);
    if (!base.startsWith('answer_q')) {
      dest = path.join(dir, `answer_q${questionId}_${Date.now()}.webm`);
      if (path.resolve(file.path) !== path.resolve(dest)) {
        fs.renameSync(file.path, dest);
      }
    }

    assertPathWithinRoot(dest, interviewConfig.recordingsRoot);
    const finalStat = fs.statSync(dest);
    const storageKey = toStorageKey(dest);

    const id = await recordingRepository.create({
      session_id: session.id,
      recording_type: 'audio',
      storage_key: storageKey,
      mime_type: file.mimetype || 'audio/webm',
      file_size_bytes: finalStat.size,
      metadata_json: {
        question_id: Number(questionId),
        is_answer: true,
      },
    });

    return { id, storageKey, bytes: finalStat.size };
  },

  async endSessionRecording(sessionId, { totalChunksSent = null } = {}) {
    await ensureRecordingMetadataTable();
    if (totalChunksSent != null) {
      finalizeManifestExpectation(sessionId, totalChunksSent);
      await recordingMetadataRepository.upsertForSession(sessionId, {
        total_chunks_expected: Number(totalChunksSent),
      });
    }

    const mergePromise = scheduleRecordingMerge(sessionId, async () => {
      const wait = await waitForRecordingChunks(sessionId, { requireExpectation: true });
      if (!wait.ready) {
        recordingDebug('merge_proceeding_with_missing_chunks', {
          session_id: sessionId,
          missing_indexes: wait.missing,
          expected: wait.expected,
          received: wait.received,
          waited_ms: wait.waitedMs,
        });
        console.warn(
          `[recording] Session ${sessionId} proceeding with merge despite missing chunks: ${wait.missing.join(', ')} (${wait.received}/${wait.expected ?? '?'} received)`
        );
      }
      return mergeSessionRecording(sessionId, { totalChunksExpected: totalChunksSent });
    });

    recordingDebug('recording_end_scheduled', {
      session_id: sessionId,
      total_chunks_sent: totalChunksSent,
    });

    return { ok: true, merge_started: true, mergePromise };
  },

  async finalizeSessionRecording(sessionId, { immediate = false, clientTotalChunks = null } = {}) {
    await ensureRecordingMetadataTable();

    if (clientTotalChunks != null && Number(clientTotalChunks) > 0) {
      finalizeManifestExpectation(sessionId, Number(clientTotalChunks));
      recordingDebug('finalize_client_chunk_hint', {
        session_id: sessionId,
        total_chunks: Number(clientTotalChunks),
      });
    }

    if (immediate) {
      try {
        const wait = await waitForRecordingChunks(sessionId, { requireExpectation: true });
        if (!wait.ready && wait.expected > 0) {
          const missingRatio = wait.missing.length / wait.expected;
          recordingDebug('finalize_missing_chunks', {
            session_id: sessionId,
            expected: wait.expected,
            received: wait.received,
            missing_indexes: wait.missing,
            missing_ratio: missingRatio,
            waited_ms: wait.waitedMs,
          });
          console.error(
            `[recording] Session ${sessionId} missing ${wait.missing.length}/${wait.expected} chunks after ${wait.waitedMs}ms wait — missing: ${wait.missing.join(', ')}`
          );

          if (missingRatio > interviewConfig.recordingMaxMissingMergeRatio) {
            scheduleRecordingMerge(sessionId, async () => {
              const retryWait = await waitForRecordingChunks(sessionId, {
                requireExpectation: false,
                maxWaitMs: interviewConfig.recordingDeferredMergeWaitMs,
              });
              recordingDebug('deferred_merge_retry', {
                session_id: sessionId,
                ready: retryWait.ready,
                missing: retryWait.missing,
                expected: retryWait.expected,
                received: retryWait.received,
              });
              if (!retryWait.ready && retryWait.expected > 0) {
                const retryRatio = retryWait.missing.length / retryWait.expected;
                if (retryRatio > interviewConfig.recordingMaxMissingMergeRatio) {
                  console.error(
                    `[recording] Session ${sessionId} deferred merge aborted — still missing ${retryWait.missing.length}/${retryWait.expected} chunks`
                  );
                  await recordingMetadataRepository.upsertForSession(sessionId, {
                    merge_status: 'failed',
                    recording_status: 'partial',
                  });
                  return {
                    error: `Missing ${retryWait.missing.length} of ${retryWait.expected} chunks`,
                    partial: true,
                    missingChunks: retryWait.missing,
                    mergePending: true,
                  };
                }
              }
              return mergeSessionRecording(sessionId);
            });
            await recordingMetadataRepository.upsertForSession(sessionId, {
              merge_status: 'pending',
              recording_status: 'partial',
              total_chunks_expected: wait.expected,
              chunks_received: wait.received,
            });
            return {
              error: `Missing ${wait.missing.length} of ${wait.expected} chunks — deferred merge scheduled`,
              partial: true,
              missingChunks: wait.missing,
              mergePending: true,
              expected: wait.expected,
              received: wait.received,
            };
          }
          console.warn(
            `[recording] Session ${sessionId} finalizing merge with minor gaps (${wait.missing.length}/${wait.expected} missing)`
          );
        } else if (!wait.ready) {
          recordingDebug('finalize_proceeding_with_missing_chunks', {
            session_id: sessionId,
            missing_indexes: wait.missing,
            waited_ms: wait.waitedMs,
          });
          console.warn(
            `[recording] Session ${sessionId} finalizing merge with missing chunks: ${wait.missing.join(', ')}`
          );
        }
        const result = await runImmediateRecordingMerge(sessionId, () =>
          mergeSessionRecording(sessionId)
        );
        recordingDebug('finalize_immediate_merge', {
          session_id: sessionId,
          recording_id: result.recordingId || null,
          partial: !!result.partial,
          missing_chunks: result.missingChunks?.length ?? null,
          chunk_count: result.chunkCount ?? null,
        });
        return result;
      } catch (err) {
        console.error(`[recording] Immediate merge failed for session ${sessionId}:`, err.message);
        recordingDebug('finalize_immediate_merge_failed', {
          session_id: sessionId,
          error: err.message,
        });
        return { error: err.message, partial: true };
      }
    }

    const pending = getPendingRecordingMerge(sessionId);
    if (pending) {
      try {
        const result = await awaitRecordingMerge(sessionId);
        if (result) return result;
      } catch (err) {
        console.error(`[recording] Pending merge failed for session ${sessionId}:`, err.message);
        recordingDebug('finalize_pending_merge_failed', {
          session_id: sessionId,
          error: err.message,
        });
      }
    }

    const metadata = await recordingMetadataRepository.findBySessionId(sessionId);
    if (
      metadata &&
      ['completed', 'partial'].includes(metadata.merge_status) &&
      metadata.merged_file_path &&
      fs.existsSync(metadata.merged_file_path)
    ) {
      const merged = await recordingRepository.findMergedBySession(sessionId);
      return {
        recordingId: merged?.id || null,
        storageKey: merged?.storage_key || null,
        alreadyMerged: true,
        recordingStatus: metadata.recording_status,
        signedUrl: metadata.signed_url,
        partial: metadata.recording_status === 'partial',
        availableChunks: metadata.chunks_received,
        totalChunksExpected: metadata.total_chunks_expected,
      };
    }

    try {
      const result = await mergeSessionRecording(sessionId);
      recordingDebug('finalize_disk_merge', {
        session_id: sessionId,
        recording_id: result.recordingId || null,
        partial: !!result.partial,
      });
      return result;
    } catch (err) {
      console.error(`[recording] merge failed for session ${sessionId}:`, err.message);
      recordingDebug('finalize_disk_merge_failed', {
        session_id: sessionId,
        error: err.message,
      });
      return { error: err.message, partial: true };
    }
  },

  async remergeSessionRecording(sessionId) {
    const { remergeSessionRecording } = await import('./recording-merge.service.js');
    return remergeSessionRecording(sessionId);
  },

  async saveTranscript(sessionId, text) {
    const storageKey = `recordings/transcripts/${sessionId}_${Date.now()}.txt`;
    const fullPath = resolveStorageKey(storageKey);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, text, 'utf8');

    return recordingRepository.create({
      session_id: sessionId,
      recording_type: 'transcript',
      storage_key: storageKey,
      transcript_text: text,
      metadata_json: { saved_at: moment().toISOString() },
    });
  },

  resolveFilePath(storageKey) {
    return resolveStorageKey(storageKey);
  },

  async streamRecordingForRequest(rec, req, res, { attachment = false } = {}) {
    if (!rec) throw new Error('Recording not found');
    const filePath = this.resolveFilePath(rec.storage_key);
    if (attachment) {
      return new Promise((resolve, reject) => {
        res.download(filePath, `interview_${rec.session_id}_${rec.id}.webm`, (err) =>
          err ? reject(err) : resolve({ streamed: true, backend: 'disk' })
        );
      });
    }
    return new Promise((resolve, reject) => {
      res.sendFile(
        filePath,
        { headers: { 'Content-Type': rec.mime_type || 'video/webm' } },
        (err) => (err ? reject(err) : resolve({ streamed: true, backend: 'disk' }))
      );
    });
  },

  async streamSessionRecordingFile(sessionId, relativeFile, req, res) {
    const { getRecordingsBasePath } = await import('./recording-disk-storage.service.js');
    const { verifyRecordingFileAccess } = await import('./recording-signed-url.service.js');
    const token = req.query.t;
    if (!verifyRecordingFileAccess(sessionId, relativeFile, token)) {
      const err = new Error('Invalid or expired access token');
      err.status = 403;
      throw err;
    }

    const fullPath = path.join(getRecordingsBasePath(), `session_${sessionId}`, relativeFile);
    const { assertPathWithinRecordingsRoot } = await import('./recording-disk-storage.service.js');
    assertPathWithinRecordingsRoot(fullPath);
    if (!fs.existsSync(fullPath)) {
      const err = new Error('Recording file not found');
      err.status = 404;
      throw err;
    }

    return new Promise((resolve, reject) => {
      res.sendFile(fullPath, { headers: { 'Content-Type': 'video/webm' } }, (err) =>
        err ? reject(err) : resolve({ streamed: true, backend: 'disk_signed' })
      );
    });
  },

  async getPlaybackRecording(sessionId) {
    const merged = await recordingRepository.findMergedBySession(sessionId);
    if (merged) return merged;
    const metadata = await recordingMetadataRepository.findBySessionId(sessionId);
    if (metadata?.merged_file_path && fs.existsSync(metadata.merged_file_path)) {
      return recordingRepository.findMergedBySession(sessionId);
    }
    return null;
  },

  async getRecordingMetadata(sessionId) {
    return recordingMetadataRepository.findBySessionId(sessionId);
  },
};
