/**
 * Structured console logging for assessment feedback email debugging.
 * Search production logs for: [feedback-email-debug]
 */
export function feedbackEmailDebug(step, meta = {}, level = 'info') {
  try {
    const payload = {
      step,
      ts: new Date().toISOString(),
      host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
      pid: process.pid,
      ...meta,
    };
    const line = `[feedback-email-debug] ${JSON.stringify(payload)}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } catch (e) {
    const fallback = `[feedback-email-debug] ${step} ${JSON.stringify(meta)} log_error=${e?.message || e}`;
    if (level === 'error') console.error(fallback);
    else console.warn(fallback);
  }
}

export function feedbackEmailDebugError(step, err, meta = {}) {
  feedbackEmailDebug(
    step,
    {
      ...meta,
      error: err?.message || String(err),
      error_name: err?.name || 'Error',
      stack: err?.stack ? String(err.stack).slice(0, 1200) : null,
      brevo_body: err?.response?.body ?? err?.response?.text ?? null,
      brevo_status: err?.response?.statusCode ?? err?.statusCode ?? null,
    },
    'error'
  );
}
