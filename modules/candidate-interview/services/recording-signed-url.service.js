import crypto from 'crypto';
import { interviewConfig } from '../config.js';
import { getBackendBaseUrl } from './webhook-media-url.service.js';
import { relativePathFromBase } from './recording-disk-storage.service.js';

function signingSecret() {
  return interviewConfig.recordingSignedUrlSecret || interviewConfig.tokenSecret;
}

function signPayload(sessionId, relativeFile, exp) {
  const payload = `${sessionId}:${relativeFile}:${exp}`;
  return crypto.createHmac('sha256', signingSecret()).update(payload).digest('hex');
}

export function signRecordingFileAccess(sessionId, relativeFile, expMs = null) {
  const exp =
    expMs ??
    Date.now() + Number(interviewConfig.recordingSignedUrlExpirySeconds || 86400) * 1000;
  const sig = signPayload(sessionId, relativeFile, exp);
  return `${exp}.${sig}`;
}

export function verifyRecordingFileAccess(sessionId, relativeFile, token) {
  if (!token || !sessionId || !relativeFile) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  const sig = parts[1];
  if (!Number.isFinite(exp) || Date.now() > exp || !sig) return false;
  const expected = signPayload(sessionId, relativeFile, exp);
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function buildSignedRecordingUrl(sessionId, absoluteOrRelativePath) {
  const base = getBackendBaseUrl();
  if (!base) return null;

  const relativeFile = absoluteOrRelativePath.includes('session_')
    ? absoluteOrRelativePath.replace(/^.*session_\d+[\\/]/, '').replace(/\\/g, '/')
    : String(absoluteOrRelativePath).replace(/\\/g, '/');

  const token = signRecordingFileAccess(sessionId, relativeFile);
  const fileParam = encodeURIComponent(relativeFile);
  return `${base}/interview/recording-media/session/${sessionId}?file=${fileParam}&t=${encodeURIComponent(token)}`;
}

export function buildSignedRecordingUrlFromAbsolute(sessionId, absolutePath) {
  const relative = relativePathFromBase(absolutePath);
  return buildSignedRecordingUrl(sessionId, relative);
}
