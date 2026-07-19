import fs from 'fs';
import { interviewConfig } from '../config.js';
import { recordingDebug } from './recording-debug.service.js';
import { getChunkPath } from './recording-disk-storage.service.js';
import {
  readManifest,
  getMissingChunkIndexes,
  recordChunkInManifest,
} from './recording-manifest.service.js';

const MIN_CHUNK_BYTES = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reconcile disk chunk files that landed before manifest was updated. */
function reconcileDiskChunksIntoManifest(sessionId) {
  const manifest = readManifest(sessionId);
  const missing = getMissingChunkIndexes(manifest);
  if (!missing.length) return missing;

  let healed = 0;
  for (const index of missing) {
    const chunkPath = getChunkPath(sessionId, index);
    if (!fs.existsSync(chunkPath)) continue;
    const size = fs.statSync(chunkPath).size;
    if (size < MIN_CHUNK_BYTES) continue;
    recordChunkInManifest(sessionId, index, chunkPath);
    healed += 1;
    console.log(`[recording-chunk-wait] Session ${sessionId} reconciled chunk ${index} from disk (${size} bytes)`);
  }

  if (healed > 0) {
    recordingDebug('chunk_reconcile_disk', { session_id: sessionId, healed_count: healed });
  }

  return getMissingChunkIndexes(readManifest(sessionId));
}

/**
 * Poll until the client signals total_chunks_expected via POST /recording/end.
 * Without this, merge can run with only early chunks and no expected count.
 */
export async function waitForRecordingExpectation(
  sessionId,
  {
    maxWaitMs = interviewConfig.recordingExpectationWaitMs,
    pollMs = interviewConfig.recordingChunkPollMs,
  } = {}
) {
  const started = Date.now();

  console.log(
    `[recording-chunk-wait] Session ${sessionId} waiting for total_chunks_expected (max ${maxWaitMs}ms)`
  );

  while (Date.now() - started < maxWaitMs) {
    const manifest = readManifest(sessionId);
    const expected = Number(manifest.total_chunks_expected);
    if (Number.isFinite(expected) && expected > 0) {
      console.log(
        `[recording-chunk-wait] Session ${sessionId} expectation set: ${expected} chunks (waited ${Date.now() - started}ms)`
      );
      recordingDebug('chunk_expectation_ready', {
        session_id: sessionId,
        total_chunks_expected: expected,
        waited_ms: Date.now() - started,
      });
      return { ready: true, expected, waitedMs: Date.now() - started };
    }
    await sleep(pollMs);
  }

  const manifest = readManifest(sessionId);
  const expected = Number(manifest.total_chunks_expected);
  const ready = Number.isFinite(expected) && expected > 0;
  console.warn(
    `[recording-chunk-wait] Session ${sessionId} expectation ${ready ? 'set late' : 'NOT set'} after ${Date.now() - started}ms`
  );
  recordingDebug('chunk_expectation_timeout', {
    session_id: sessionId,
    ready,
    total_chunks_expected: ready ? expected : null,
    waited_ms: Date.now() - started,
  });
  return {
    ready,
    expected: ready ? expected : null,
    waitedMs: Date.now() - started,
  };
}

/**
 * Poll until all expected chunks are in the manifest or timeout.
 */
export async function waitForRecordingChunks(
  sessionId,
  {
    maxWaitMs = interviewConfig.recordingChunkWaitMs,
    pollMs = interviewConfig.recordingChunkPollMs,
    requireExpectation = true,
    expectationWaitMs = interviewConfig.recordingExpectationWaitMs,
  } = {}
) {
  const started = Date.now();
  let lastMissing = [];
  let expected = null;

  if (requireExpectation) {
    const expWait = await waitForRecordingExpectation(sessionId, {
      maxWaitMs: Math.min(expectationWaitMs, maxWaitMs),
      pollMs,
    });
    expected = expWait.expected;
    if (!expWait.ready) {
      console.warn(
        `[recording-chunk-wait] Session ${sessionId} proceeding without total_chunks_expected — merge may be incomplete`
      );
    }
  }

  const chunkWaitBudget = Math.max(0, maxWaitMs - (Date.now() - started));
  console.log(
    `[recording-chunk-wait] Session ${sessionId} waiting for chunks (budget ${chunkWaitBudget}ms, poll ${pollMs}ms, expected=${expected ?? 'unknown'})`
  );

  while (Date.now() - started < maxWaitMs) {
    lastMissing = reconcileDiskChunksIntoManifest(sessionId);
    const manifest = readManifest(sessionId);
    expected = expected ?? (Number(manifest.total_chunks_expected) || null);

    if (lastMissing.length === 0) {
      const received = (manifest.chunks_received || []).length;
      console.log(
        `[recording-chunk-wait] Session ${sessionId} all chunks ready (${received} received, expected=${expected ?? 'unknown'})`
      );
      recordingDebug('chunk_wait_ready', {
        session_id: sessionId,
        received,
        expected,
        waited_ms: Date.now() - started,
      });
      return {
        ready: true,
        missing: [],
        expected,
        received,
        waitedMs: Date.now() - started,
      };
    }

    recordingDebug('chunk_wait_poll', {
      session_id: sessionId,
      missing_indexes: lastMissing,
      expected,
      received: (manifest.chunks_received || []).length,
      elapsed_ms: Date.now() - started,
    });
    await sleep(pollMs);
  }

  lastMissing = reconcileDiskChunksIntoManifest(sessionId);
  const manifest = readManifest(sessionId);
  const received = (manifest.chunks_received || []).length;
  expected = expected ?? (Number(manifest.total_chunks_expected) || null);

  console.warn(
    `[recording-chunk-wait] Session ${sessionId} timeout — received ${received}, expected ${expected ?? '?'}, still missing: ${lastMissing.join(', ') || 'none'}`
  );
  recordingDebug('chunk_wait_timeout', {
    session_id: sessionId,
    missing_indexes: lastMissing,
    expected,
    received,
    waited_ms: Date.now() - started,
  });

  return {
    ready: lastMissing.length === 0,
    missing: lastMissing,
    expected,
    received,
    waitedMs: Date.now() - started,
  };
}
