import fs from 'fs';
import path from 'path';
import { interviewConfig } from '../config.js';
import { resolveStorageKey } from './storage.service.js';
import { buildSignedRecordingUrlFromAbsolute } from './recording-signed-url.service.js';
import { getRecordingsBasePath } from './recording-disk-storage.service.js';

/** Public base URL for webhook media links — uses `HOST_URL` (same as invites / Twilio). */
export function getBackendBaseUrl() {
  const raw = process.env.HOST_URL?.trim() || '';
  return raw.replace(/\/+$/, '');
}

/**
 * Snapshot storage_key is relative to interview-gate root, e.g. `{token}/snap_123.jpg`.
 */
export function publicSnapshotUrl(storageKey) {
  const base = getBackendBaseUrl();
  if (!base || !storageKey) return null;
  const key = String(storageKey).replace(/\\/g, '/').replace(/^\/+/, '');
  return `${base}/uploads/interview-gate/${key}`;
}

/**
 * Public signed URL for session video on disk.
 * @param {string|{ storage_key: string, id: number, session_id: number, file_size_bytes?: number }} recordingOrKey
 */
export function publicRecordingUrl(recordingOrKey) {
  const base = getBackendBaseUrl();
  if (!base) return null;

  const rec =
    recordingOrKey && typeof recordingOrKey === 'object'
      ? recordingOrKey
      : { storage_key: recordingOrKey };

  if (!rec?.storage_key || !rec?.session_id) return null;

  const storageKey = String(rec.storage_key).replace(/\\/g, '/').replace(/^\/+/, '');

  if (storageKey.startsWith('recordings/session_')) {
    const absolute = path.join(
      getRecordingsBasePath(),
      storageKey.replace(/^recordings\//, '')
    );
    if (fs.existsSync(absolute)) {
      return buildSignedRecordingUrlFromAbsolute(rec.session_id, absolute);
    }
  }

  const absoluteFromKey = resolveStorageKey(storageKey);
  if (fs.existsSync(absoluteFromKey) && rec.session_id) {
    return buildSignedRecordingUrlFromAbsolute(rec.session_id, absoluteFromKey);
  }

  const key = storageKey.replace(/^recordings\//, '');
  return `${base}/uploads/interview-recordings/${key}`;
}

export function mediaFileExists(recordingOrKey) {
  const storageKey =
    recordingOrKey && typeof recordingOrKey === 'object'
      ? recordingOrKey.storage_key
      : recordingOrKey;

  if (!storageKey) return false;

  try {
    if (String(storageKey).includes('session_')) {
      const full = resolveStorageKey(storageKey);
      return fs.existsSync(full);
    }
    const full = resolveStorageKey(storageKey);
    const root = storageKey.startsWith('recordings/')
      ? interviewConfig.recordingsRoot
      : interviewConfig.uploadsRoot;
    return fs.existsSync(full) && full.startsWith(path.resolve(root));
  } catch {
    return false;
  }
}

export function snapshotFilename(storageKey) {
  if (!storageKey) return null;
  return path.basename(String(storageKey).replace(/\\/g, '/'));
}
