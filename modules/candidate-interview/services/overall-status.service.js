/**
 * Dashboard overall_status records for completed browser video interviews.
 */
import db from '../../../config/db.js';
import { ensureCallEndSchema } from '../../../Helpers/callEndSchema.js';
import { questionRepository } from '../repositories/question.repository.js';

const FALLBACK_API_USER_ID = Number(process.env.MOCK_INTERVIEW_DEFAULT_USER_ID || 1);

function toNullableInt(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw || raw === 'null' || raw === 'undefined' || raw === 'nan') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export async function getAdminEmailById(loggedin_user) {
  try {
    const [rows] = await db.query('SELECT email FROM admins WHERE id = ?', [loggedin_user]);
    if (Array.isArray(rows) && rows.length > 0) return rows[0].email;
    return null;
  } catch (error) {
    console.error('❌ Error fetching admin email:', error.message || error);
    return null;
  }
}

async function saveOverallStatus({
  job_id,
  contact,
  sid,
  result_status,
  feedback_status,
  eval_error_summary = null,
  total_questions,
  answered_questions,
  total_score,
  call_status,
  created_by,
  is_super_admin,
  admin_id,
}) {
  const safeResultStatus = String(result_status || '').slice(0, 50);
  const safeFeedbackStatus = String(feedback_status || '').slice(0, 255);
  const safeEvalSummary = eval_error_summary ? String(eval_error_summary).slice(0, 65000) : null;

  const tryInsert = async (audio) => {
    await db.query(
      `INSERT INTO overall_status
       (job_id, contact, sid, result_status, feedback_status, eval_error_summary,
        total_questions, answered_questions, total_score, percentile,
        call_status, chat_loop_audio, created_by, created_at, is_super_admin, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NOW(), ?, ?)`,
      [
        job_id,
        contact,
        sid,
        safeResultStatus,
        safeFeedbackStatus,
        safeEvalSummary,
        total_questions,
        answered_questions,
        total_score ?? 0,
        call_status,
        audio,
        created_by,
        is_super_admin,
        admin_id,
      ]
    );
  };

  try {
    await tryInsert(null);
  } catch (err) {
    console.error(`❌ Failed to save overall_status for ${sid}:`, err.message);
    throw err;
  }
}

/** Write dashboard overall_status from browser interview assessment (no telephony re-eval). */
export async function recordBrowserInterviewOverallStatus({
  session,
  mockCallId,
  callSid,
  assessment,
  proctoringTerminated,
}) {
  await ensureCallEndSchema();

  const normalizedUserId = toNullableInt(session.recruiter_id) ?? FALLBACK_API_USER_ID;
  const normalizedAccountId = toNullableInt(session.company_id);

  const qaRows = await questionRepository.listWithResponses(session.id);
  const answered = qaRows.filter((r) => r.response_id).length;
  const totalQuestions = assessment?.total_questions ?? answered;
  const callStatus = proctoringTerminated ? 'failed' : 'completed';

  await saveOverallStatus({
    job_id: mockCallId,
    contact: session.candidate_phone || session.candidate_email,
    sid: callSid,
    result_status: assessment?.result_status || (answered ? 'Incomplete' : 'Incomplete'),
    feedback_status: assessment?.feedback_status || '',
    total_questions: totalQuestions,
    answered_questions: answered,
    total_score: assessment?.total_score ?? 0,
    call_status: callStatus,
    created_by: normalizedUserId,
    is_super_admin: 0,
    admin_id: normalizedAccountId,
  });
}
