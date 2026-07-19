import fs from 'fs';
import path from 'path';
import { recordingMetadataRepository } from '../repositories/recording-metadata.repository.js';
import { recordingDebug } from './recording-debug.service.js';
import { ensureRecordingMetadataTable } from './recording-metadata-migration.service.js';
import {
  getChunkPath,
  assertPathWithinRecordingsRoot,
  sha256File,
} from './recording-disk-storage.service.js';
import { recordChunkInManifest } from './recording-manifest.service.js';

const MIN_CHUNK_BYTES = 200;

export const recordingChunkService = {
  async saveChunkToDisk(session, file, { chunkIndex = 0, totalChunksExpected = null, mimeType = 'video/webm' } = {}) {
    await ensureRecordingMetadataTable();
    if (!file?.path) throw new Error('No recording chunk file on disk');

    const stat = fs.statSync(file.path);
    if (stat.size < MIN_CHUNK_BYTES) {
      try {
        fs.unlinkSync(file.path);
      } catch (_) {}
      recordingDebug('chunk_rejected_too_small', {
        session_id: session.id,
        chunk_index: chunkIndex,
        bytes: stat.size,
      });
      return { skipped: true, reason: 'chunk_too_small', bytes: stat.size };
    }

    const dest = getChunkPath(session.id, chunkIndex);
    assertPathWithinRecordingsRoot(dest);

    const src = path.resolve(file.path);
    const dst = path.resolve(dest);
    if (src !== dst) {
      if (fs.existsSync(dst)) fs.unlinkSync(dst);
      fs.renameSync(src, dst);
    }

    const finalStat = fs.statSync(dest);
    const manifest = recordChunkInManifest(session.id, chunkIndex, dest, { totalChunksExpected });

    let checksum = null;
    try {
      checksum = sha256File(dest);
    } catch (_) {}

    await recordingMetadataRepository.upsertForSession(session.id, {
      total_chunks_expected: manifest.total_chunks_expected ?? totalChunksExpected ?? null,
      chunks_received: (manifest.chunks_received || []).length,
      merge_status: 'pending',
    });

    recordingDebug('chunk_saved_disk', {
      session_id: session.id,
      chunk_index: chunkIndex,
      bytes: finalStat.size,
      sha256: checksum ? checksum.slice(0, 12) : null,
      total_chunks_on_disk: (manifest.chunks_received || []).length,
    });
    console.log(
      `[recording-chunk] upload completed session=${session.id} chunk=${chunkIndex} bytes=${finalStat.size} total=${(manifest.chunks_received || []).length}`
    );

    return {
      chunkIndex: Number(chunkIndex),
      bytes: finalStat.size,
      stored: 'disk',
      path: dest,
      ack: true,
    };
  },

  async getSessionChunkStats(sessionId) {
    const metadata = await recordingMetadataRepository.findBySessionId(sessionId);
    const { readManifest, getMissingChunkIndexes } = await import('./recording-manifest.service.js');
    const manifest = readManifest(sessionId);
    const missing = getMissingChunkIndexes(manifest);
    const indices = (manifest.chunks_received || []).map(Number).sort((a, b) => a - b);

    return {
      chunkCount: indices.length,
      totalBytes: Object.values(manifest.chunk_sizes || {}).reduce(
        (sum, n) => sum + Number(n || 0),
        0
      ),
      maxIndex: indices.length ? indices[indices.length - 1] : -1,
      gapCount: missing.length,
      partial: missing.length > 0,
      totalChunksExpected: metadata?.total_chunks_expected ?? manifest.total_chunks_expected ?? null,
    };
  },
};
