import { interviewConfig } from '../config.js';

const buckets = new Map();

export function interviewRateLimit(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || now - bucket.start > interviewConfig.rateLimitWindowMs) {
    bucket = { start: now, count: 0 };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  if (bucket.count > interviewConfig.rateLimitMax) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  next();
}
