import crypto from 'crypto';
import fs from 'fs';
import { RECORDING_STORAGE_KEY_MYSQL_BLOB } from '../constants.js';
import { recordingBlobRepository } from '../repositories/recording-blob.repository.js';
import { recordingRepository } from '../repositories/recording.repository.js';
import { interviewConfig, isMysqlBlobRecordingStorage } from '../config.js';

export function isMysqlBlobRecording(rec) {
  return rec?.storage_key === RECORDING_STORAGE_KEY_MYSQL_BLOB;
}

export function assertMysqlBlobMode() {
  if (!isMysqlBlobRecordingStorage()) {
    throw new Error('MySQL blob recording storage is not enabled');
  }
}

/**
 * Persist final session WebM buffer into MySQL.
 */
export async function saveFinalSessionVideoBuffer(session, buffer, extraMeta = {}) {
  assertMysqlBlobMode();
  if (!buffer?.length) throw new Error('Empty recording buffer');

  const max = interviewConfig.maxRecordingBlobBytes;
  if (buffer.length > max) {
    const err = new Error(
      `Session recording exceeds maximum size (${Math.round(max / 1024 / 1024)} MB)`
    );
    err.status = 413;
    throw err;
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const prior = await recordingRepository.findMergedBySession(session.id);
  if (prior) {
    await recordingBlobRepository.deleteByRecordingId(prior.id);
    await recordingRepository.deleteById(prior.id);
  }

  const recordingId = await recordingRepository.create({
    session_id: session.id,
    recording_type: 'video',
    storage_key: RECORDING_STORAGE_KEY_MYSQL_BLOB,
    mime_type: 'video/webm',
    file_size_bytes: buffer.length,
    metadata_json: {
      merged: true,
      is_session_full: true,
      storage_backend: 'mysql_blob',
      source: extraMeta.source || 'browser_assembled',
      sha256,
      ...extraMeta,
    },
  });

  await recordingBlobRepository.upsert(recordingId, buffer, sha256);

  console.log(
    `[recording-blob] Saved session ${session.id} recording ${recordingId} (${Math.round(
      buffer.length / 1024
    )} KB) source=${extraMeta.source || 'buffer'}`
  );

  return {
    id: recordingId,
    recordingId,
    storageKey: RECORDING_STORAGE_KEY_MYSQL_BLOB,
    bytes: buffer.length,
    merged: true,
    storage_backend: 'mysql_blob',
    partial: !!extraMeta.partial,
  };
}

/**
 * Persist final session WebM from multer temp file into MySQL.
 */
export async function saveFinalSessionVideoBlob(session, file) {
  try {
    assertMysqlBlobMode();
    if (!file?.path) throw new Error('No recording file on disk');

    const stat = fs.statSync(file.path);
    const max = interviewConfig.maxRecordingBlobBytes;
    if (stat.size > max) {
      try {
        fs.unlinkSync(file.path);
      } catch (_) {}
      const err = new Error(
        `Session recording exceeds maximum size (${Math.round(max / 1024 / 1024)} MB)`
      );
      err.status = 413;
      throw err;
    }

    const buffer = fs.readFileSync(file.path);
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    return saveFinalSessionVideoBuffer(session, buffer, {
      source: 'browser_assembled',
      sha256,
    });
  } catch (e) {
    console.error('[recording-blob] Failed to save mysql_blob:', {
      session_id: session?.id || null,
      recording_mode: interviewConfig.recordingStorage,
      error: e?.message || String(e),
      code: e?.code || null,
      status: e?.status || null,
    });
    throw e;
  }
}

export async function loadBlobBuffer(recordingId) {
  const row = await recordingBlobRepository.findByRecordingId(recordingId);
  if (!row?.content) return null;
  return Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
}

/**
 * Stream or send full blob with optional HTTP Range support.
 */
export function sendBlobToResponse(rec, buffer, req, res, { attachment = false } = {}) {
  const mime = rec.mime_type || 'video/webm';
  const size = buffer.length;
  const range = req.headers.range;

  if (attachment) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="interview_${rec.session_id}_${rec.id}.webm"`
    );
  }

  if (range) {
    const parts = String(range).replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
    if (start >= size || end >= size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    const chunk = buffer.subarray(start, end + 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', chunk.length);
    res.setHeader('Content-Type', mime);
    return res.end(chunk);
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Type', mime);
  return res.end(buffer);
}
