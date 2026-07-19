import path from 'path';
import fs from 'fs';
import { interviewConfig } from '../config.js';

export function getSessionUploadDir(sessionToken) {
  const dir = path.join(interviewConfig.uploadsRoot, sessionToken);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSessionRecordingDir(sessionToken) {
  const dir = path.join(interviewConfig.recordingsRoot, sessionToken);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Storage key relative to uploads root — never expose absolute paths to clients */
export function toStorageKey(absolutePath) {
  const rel = path.relative(interviewConfig.uploadsRoot, absolutePath);
  if (rel.startsWith('..')) {
    const relRec = path.relative(interviewConfig.recordingsRoot, absolutePath);
    return `recordings/${relRec.replace(/\\/g, '/')}`;
  }
  return rel.replace(/\\/g, '/');
}

export function resolveStorageKey(storageKey) {
  if (storageKey.startsWith('recordings/')) {
    return path.join(interviewConfig.recordingsRoot, storageKey.replace(/^recordings\//, ''));
  }
  return path.join(interviewConfig.uploadsRoot, storageKey);
}

export function assertPathWithinRoot(filePath, root) {
  const resolved = path.resolve(filePath);
  const rootResolved = path.resolve(root);
  if (!resolved.startsWith(rootResolved)) {
    throw new Error('Invalid storage path');
  }
  return resolved;
}
