import { INTERVIEW_TYPES } from '../constants.js';

export function validateSchedulePayload(body) {
  const errors = [];
  if (!body.candidate_name?.trim()) errors.push('Candidate name is required');
  if (!body.candidate_email?.trim()) errors.push('Candidate email is required');
  if (!body.scheduled_at) errors.push('Scheduled date/time is required');

  const type = body.interview_type || INTERVIEW_TYPES.BROWSER_VIDEO;
  if (!Object.values(INTERVIEW_TYPES).includes(type)) {
    errors.push('Invalid interview type');
  }

  if (
    (type === INTERVIEW_TYPES.VOICE_CALL || type === INTERVIEW_TYPES.AI_INTERVIEW) &&
    !body.candidate_phone?.trim()
  ) {
    errors.push('Phone number is required for voice/AI interview types');
  }

  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    err.errors = errors;
    throw err;
  }

  return {
    candidate_id: body.candidate_id ? Number(body.candidate_id) : null,
    candidate_name: body.candidate_name.trim(),
    candidate_email: body.candidate_email.trim().toLowerCase(),
    candidate_phone: body.candidate_phone?.trim() || null,
    job_id: body.job_id ? Number(body.job_id) : null,
    job_title: body.job_title?.trim() || null,
    interview_type: type,
    scheduled_at: body.scheduled_at,
    timezone: body.timezone || 'Asia/Kolkata',
    notes: body.notes?.trim() || null,
    send_invite: body.send_invite !== 'false' && body.send_invite !== false,
    send_sms: body.send_sms === true || body.send_sms === 'true',
    question_count:
      body.question_count != null && body.question_count !== ''
        ? Math.min(15, Math.max(3, Number(body.question_count)))
        : null,
  };
}
