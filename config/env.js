/**
 * Central env accessors — no real secrets hardcoded in source.
 */
import dotenv from 'dotenv';

dotenv.config();

function trimEnv(name) {
  return String(process.env[name] ?? '').trim();
}

export function getSessionSecret() {
  const secret = trimEnv('SESSION_SECRET') || trimEnv('INTERVIEW_TOKEN_SECRET');
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Set SESSION_SECRET or INTERVIEW_TOKEN_SECRET in .env before running in production.');
  }
  console.warn('[env] SESSION_SECRET not set — using insecure dev default. Set it in .env.');
  return 'dev-insecure-session-secret-change-me';
}

export function getInterviewTokenSecret() {
  const secret = trimEnv('INTERVIEW_TOKEN_SECRET') || trimEnv('SESSION_SECRET');
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Set INTERVIEW_TOKEN_SECRET in .env before running in production.');
  }
  console.warn('[env] INTERVIEW_TOKEN_SECRET not set — using insecure dev default. Set it in .env.');
  return 'dev-insecure-interview-token-secret-change-me';
}

export function getRecordingSignedUrlSecret() {
  return (
    trimEnv('RECORDING_SIGNED_URL_SECRET') ||
    trimEnv('INTERVIEW_RECORDING_MEDIA_SECRET') ||
    getInterviewTokenSecret()
  );
}

/** Bearer tokens accepted for external interview API routes. */
export function resolveApiBearerKeys() {
  const keys = new Set();
  const apiKey = trimEnv('API_KEY');
  const mockKey = trimEnv('MOCK_INTERVIEW_API_KEY');
  if (apiKey) keys.add(apiKey);
  if (mockKey) keys.add(mockKey);
  return keys;
}

export function isValidApiBearerToken(token) {
  const keys = resolveApiBearerKeys();
  if (!keys.size) return false;
  return keys.has(String(token || '').trim());
}

export function requireApiBearerKeysConfigured() {
  if (resolveApiBearerKeys().size === 0) {
    throw new Error('Set API_KEY or MOCK_INTERVIEW_API_KEY in .env for API bearer authentication.');
  }
}

export function getFeedbackCcEmail() {
  return trimEnv('FEEDBACK_CC_EMAIL') || null;
}

export function getApiFeedbackAdminEmail() {
  return trimEnv('API_FEEDBACK_ADMIN_EMAIL') || trimEnv('TO_EMAIL') || null;
}

/** Judge/demo admin login — skip SMTP OTP when enabled (set JUDGE_DEMO_LOGIN=true on demo hosts only). */
export function isJudgeDemoLoginEnabled() {
  const v = trimEnv('JUDGE_DEMO_LOGIN').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function getJudgeDemoLoginEmail() {
  return (trimEnv('JUDGE_DEMO_LOGIN_EMAIL') || 'yogeshsainihere@gmail.com').toLowerCase();
}

export function getJudgeDemoLoginOtp() {
  return trimEnv('JUDGE_DEMO_LOGIN_OTP') || '1111';
}

export function isJudgeDemoLoginEmail(email) {
  if (!isJudgeDemoLoginEnabled()) return false;
  return String(email || '').trim().toLowerCase() === getJudgeDemoLoginEmail();
}
