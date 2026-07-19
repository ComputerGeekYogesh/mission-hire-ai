import { interviewConfig } from '../config.js';
import { recordingDebug } from './recording-debug.service.js';

const pendingMerges = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Schedule merge after RECORDING_MERGE_DELAY_MS (default 15s) to allow in-flight uploads to land.
 */
export function scheduleRecordingMerge(sessionId, mergeFn) {
  const key = Number(sessionId);
  if (pendingMerges.has(key)) {
    return pendingMerges.get(key);
  }

  const promise = (async () => {
    recordingDebug('merge_scheduled', {
      session_id: key,
      delay_ms: interviewConfig.recordingMergeDelayMs,
    });
    await sleep(interviewConfig.recordingMergeDelayMs);
    return mergeFn();
  })();

  pendingMerges.set(key, promise);
  promise.finally(() => {
    if (pendingMerges.get(key) === promise) {
      pendingMerges.delete(key);
    }
  });

  return promise;
}

export function getPendingRecordingMerge(sessionId) {
  return pendingMerges.get(Number(sessionId)) || null;
}

export async function awaitRecordingMerge(sessionId, { timeoutMs = 120_000 } = {}) {
  const pending = getPendingRecordingMerge(sessionId);
  if (!pending) return null;

  return Promise.race([
    pending,
    sleep(timeoutMs).then(() => {
      throw new Error(`Recording merge timed out after ${timeoutMs}ms for session ${sessionId}`);
    }),
  ]);
}

export function clearPendingRecordingMerge(sessionId) {
  pendingMerges.delete(Number(sessionId));
}

/**
 * Run merge immediately — skips scheduled delay (used when session completion is finalized).
 */
export async function runImmediateRecordingMerge(sessionId, mergeFn) {
  const key = Number(sessionId);
  clearPendingRecordingMerge(key);
  return mergeFn();
}
