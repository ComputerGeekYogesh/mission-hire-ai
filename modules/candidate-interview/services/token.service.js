import crypto from 'crypto';
import { interviewConfig } from '../config.js';

export function generateSessionToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const sig = crypto
    .createHmac('sha256', interviewConfig.tokenSecret)
    .update(raw)
    .digest('hex')
    .slice(0, 16);
  return `${raw}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [raw, sig] = parts;
  const expected = crypto
    .createHmac('sha256', interviewConfig.tokenSecret)
    .update(raw)
    .digest('hex')
    .slice(0, 16);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}
