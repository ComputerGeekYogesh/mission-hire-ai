/**
 * Structured console logging for recording persistence debugging.
 */
export function recordingDebug(step, meta = {}) {
  try {
    const payload = {
      step,
      ts: new Date().toISOString(),
      host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
      pid: process.pid,
      ...meta,
    };
    console.log('[recording-persist]', JSON.stringify(payload));
  } catch (e) {
    console.log('[recording-persist]', step, meta, e?.message || e);
  }
}
