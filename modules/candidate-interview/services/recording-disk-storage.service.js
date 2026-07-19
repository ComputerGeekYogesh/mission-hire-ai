import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { interviewConfig } from '../config.js';

export function getRecordingsBasePath() {
  return interviewConfig.recordingsBasePath;
}

/** Session folder: {RECORDINGS_BASE_PATH}/session_{session_id}/ */
export function getSessionRecordingDir(sessionId) {
  const dir = path.join(getRecordingsBasePath(), `session_${sessionId}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function chunkFilename(chunkIndex) {
  return `chunk_${String(chunkIndex).padStart(3, '0')}.webm`;
}

export function getChunkPath(sessionId, chunkIndex) {
  return path.join(getSessionRecordingDir(sessionId), chunkFilename(chunkIndex));
}

export function getMergedRecordingPath(sessionId) {
  return path.join(getSessionRecordingDir(sessionId), 'full_recording.webm');
}

export function getPartialRecordingPath(sessionId) {
  return path.join(getSessionRecordingDir(sessionId), 'partial_recording.webm');
}

export function getManifestPath(sessionId) {
  return path.join(getSessionRecordingDir(sessionId), 'manifest.json');
}

export function assertPathWithinRecordingsRoot(filePath) {
  const resolved = path.resolve(filePath);
  const rootResolved = path.resolve(getRecordingsBasePath());
  if (!resolved.startsWith(rootResolved)) {
    throw new Error('Invalid recording storage path');
  }
  return resolved;
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function listChunkFilesOnDisk(sessionId) {
  const dir = getSessionRecordingDir(sessionId);
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((name) => /^chunk_\d{3}\.webm$/.test(name))
    .map((name) => {
      const match = name.match(/^chunk_(\d{3})\.webm$/);
      const chunkIndex = Number(match[1]);
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      return { chunkIndex, filename: name, path: fullPath, size: stat.size };
    })
    .sort((a, b) => a.chunkIndex - b.chunkIndex);

  return files;
}

export function relativePathFromBase(absolutePath) {
  const rel = path.relative(getRecordingsBasePath(), absolutePath);
  return rel.replace(/\\/g, '/');
}

const CHUNK_FILE_PATTERN = /^chunk_\d{3}\.webm$/;
const MERGE_INTERMEDIATE_FILES = new Set(['partial_recording.webm', 'full_recording_fixed.webm']);

export function verifyMergedRecordingFile(filePath, minBytes = 200) {
  if (!filePath) return false;
  try {
    assertPathWithinRecordingsRoot(filePath);
    if (!fs.existsSync(filePath)) return false;
    return fs.statSync(filePath).size >= minBytes;
  } catch {
    return false;
  }
}

/**
 * Remove temporary chunk and intermediate merge files after a verified final recording exists.
 * Failures are logged and never thrown — cleanup must not break the merge pipeline.
 */
export function cleanupSessionRecordingChunks(sessionId, { mergedFilePath, keepManifest = true } = {}) {
  const dir = path.join(getRecordingsBasePath(), `session_${sessionId}`);
  if (!fs.existsSync(dir)) {
    return { deleted: 0, skipped: true, reason: 'no_session_dir' };
  }

  const resolvedMerged = mergedFilePath ? path.resolve(mergedFilePath) : null;
  let deleted = 0;
  const errors = [];

  for (const name of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const resolved = path.resolve(fullPath);

    if (resolvedMerged && resolved === resolvedMerged) continue;
    if (keepManifest && name === 'manifest.json') continue;

    const isChunk = CHUNK_FILE_PATTERN.test(name);
    const isIntermediate = MERGE_INTERMEDIATE_FILES.has(name);
    if (!isChunk && !isIntermediate) continue;

    try {
      assertPathWithinRecordingsRoot(fullPath);
      fs.unlinkSync(fullPath);
      deleted += 1;
    } catch (err) {
      errors.push({ file: name, error: err.message });
    }
  }

  return { deleted, errors, skipped: false };
}
