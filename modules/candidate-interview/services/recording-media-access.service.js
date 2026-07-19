import crypto from 'crypto';
import { interviewConfig } from '../config.js';
import { getRecordingSignedUrlSecret } from '../../../config/env.js';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function mediaSecret() {
  return getRecordingSignedUrlSecret() || interviewConfig.tokenSecret;
}

function signPayload(recordingId, sessionId, exp) {
  const payload = `${recordingId}:${sessionId}:${exp}`;
  return crypto.createHmac('sha256', mediaSecret()).update(payload).digest('hex');
}

export function signRecordingMediaAccess(recordingId, sessionId) {
  const exp = Date.now() + TOKEN_TTL_MS;
  return `${exp}.${signPayload(recordingId, sessionId, exp)}`;
}

export function verifyRecordingMediaAccess(recordingId, sessionId, token) {
  if (!token || !recordingId || !sessionId) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  const sig = parts[1];
  if (!Number.isFinite(exp) || Date.now() > exp || !sig) return false;
  const expected = signPayload(recordingId, sessionId, exp);
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
