import db from '../../../config/db.js';

let errorsTableReady = null;

function isErrorLogEnabled() {
  return process.env.VOICE_ERROR_LOG_ENABLED !== '0';
}

async function ensureVoicePlatformErrorsTable() {
  if (!errorsTableReady) {
    errorsTableReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS voice_platform_errors (
          id INT AUTO_INCREMENT PRIMARY KEY,
          severity VARCHAR(32) DEFAULT 'error',
          call_kind VARCHAR(64) DEFAULT NULL,
          twilio_call_sid VARCHAR(128) DEFAULT NULL,
          job_id VARCHAR(128) DEFAULT NULL,
          source_file VARCHAR(255) DEFAULT NULL,
          source_tag VARCHAR(128) DEFAULT NULL,
          message TEXT,
          stack_trace TEXT,
          context_json TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_vpe_job (job_id(191))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    })().catch((e) => {
      errorsTableReady = null;
      throw e;
    });
  }
  return errorsTableReady;
}

async function logPlatformError({
  severity = 'error',
  callKind = null,
  twilioCallSid = null,
  jobId = null,
  sourceFile = null,
  sourceTag = null,
  message,
  err = null,
  context = null,
} = {}) {
  const msg = String(message || err?.message || 'Unknown error').slice(0, 65000);
  const stack = err?.stack ? String(err.stack).slice(0, 65000) : null;
  const ctx =
    context != null
      ? JSON.stringify(context).slice(0, 65000)
      : err?.response?.data
        ? JSON.stringify(err.response.data).slice(0, 65000)
        : null;

  console.error(
    `[InterviewError][${severity}]${sourceTag ? `[${sourceTag}]` : ''} ${msg}`,
    stack ? '\n' + stack : ''
  );

  if (!isErrorLogEnabled()) return null;

  try {
    await ensureVoicePlatformErrorsTable();
    const [r] = await db.query(
      `INSERT INTO voice_platform_errors
        (severity, call_kind, twilio_call_sid, job_id, source_file, source_tag, message, stack_trace, context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [severity, callKind, twilioCallSid, jobId, sourceFile, sourceTag, msg, stack, ctx]
    );
    return r?.insertId ?? null;
  } catch (e) {
    console.error('[InterviewError] failed to write voice_platform_errors:', e?.message || e);
    return null;
  }
}

/**
 * Interview Management errors → voice_platform_errors admin log.
 */
export async function logInterviewError({
  severity = 'error',
  sessionId = null,
  sessionToken = null,
  sourceTag = 'interview_management',
  sourceFile = null,
  message,
  err = null,
  context = null,
} = {}) {
  const ctx = {
    module: 'candidate_interview',
    session_id: sessionId,
    session_token: sessionToken,
    ...(context && typeof context === 'object' ? context : {}),
  };

  return logPlatformError({
    severity,
    callKind: 'interview_management',
    twilioCallSid: sessionToken || (sessionId != null ? `sess_${sessionId}` : null),
    jobId: sessionId != null ? String(sessionId) : null,
    sourceFile,
    sourceTag,
    message,
    err,
    context: ctx,
  });
}
