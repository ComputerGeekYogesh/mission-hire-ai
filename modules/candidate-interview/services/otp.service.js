import crypto from 'crypto';
import { interviewConfig } from '../config.js';

export function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function hashOtp(otp) {
  return crypto.createHmac('sha256', interviewConfig.tokenSecret).update(String(otp)).digest('hex');
}

export function verifyOtp(otp, hash) {
  if (!otp || !hash) return false;
  const candidate = hashOtp(otp);
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
  } catch {
    return false;
  }
}
