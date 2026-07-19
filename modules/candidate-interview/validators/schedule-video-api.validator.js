import moment from 'moment-timezone';
import { INTERVIEW_TYPES } from '../constants.js';
import { SESSION_TYPES } from '../lib/session-labels.js';
import { sanitizeString } from '../utils/sanitize.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_NAIVE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidIanaTimezone(tz) {
  try {
    if (!moment.tz.zone(tz)) return false;
    return true;
  } catch {
    return false;
  }
}

export function validateScheduleVideoInterviewPayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['Request body must be a JSON object'] };
  }

  const candidateName = sanitizeString(body.candidate_name, 255);
  if (!candidateName) errors.push('candidate_name is required');

  const emailRaw = sanitizeString(body.email, 255).toLowerCase();
  if (!emailRaw) errors.push('email is required');
  else if (!EMAIL_RE.test(emailRaw)) errors.push('email is not a valid email address');

  const interviewType = sanitizeString(body.interview_type, 64);
  if (!interviewType) errors.push('interview_type is required');
  else if (!Object.values(INTERVIEW_TYPES).includes(interviewType)) {
    errors.push(
      `interview_type must be one of: ${Object.values(INTERVIEW_TYPES).join(', ')}`
    );
  }

  const sessionTypeRaw = sanitizeString(body.type, 64);
  let sessionType = SESSION_TYPES.SKILL_ASSESSMENT;
  if (sessionTypeRaw) {
    if (!Object.values(SESSION_TYPES).includes(sessionTypeRaw)) {
      errors.push(`type must be one of: ${Object.values(SESSION_TYPES).join(', ')}`);
    } else {
      sessionType = sessionTypeRaw;
    }
  }

  const timezone = sanitizeString(body.timezone, 64) || '';
  if (!timezone) errors.push('timezone is required');
  else if (!isValidIanaTimezone(timezone)) errors.push('timezone must be a valid IANA timezone string');

  let scheduledAt = null;
  const scheduledRaw = sanitizeString(body.scheduled_at, 32);
  if (!scheduledRaw) {
    errors.push('scheduled_at is required');
  } else if (!ISO_NAIVE_RE.test(scheduledRaw)) {
    errors.push('scheduled_at must be ISO 8601 datetime without timezone offset (e.g. 2026-05-25T10:30:00)');
  } else if (!timezone || !isValidIanaTimezone(timezone)) {
    // timezone error already recorded
  } else {
    const m = moment.tz(scheduledRaw, timezone);
    if (!m.isValid()) {
      errors.push('scheduled_at is not a valid datetime in the given timezone');
    } else if (!m.isAfter(moment())) {
      errors.push('scheduled_at must be a future datetime');
    } else {
      scheduledAt = m.format('YYYY-MM-DD HH:mm:ss');
    }
  }

  if (body.send_email_invite_immediately === undefined || body.send_email_invite_immediately === null) {
    errors.push('send_email_invite_immediately is required');
  } else if (typeof body.send_email_invite_immediately !== 'boolean') {
    errors.push('send_email_invite_immediately must be a boolean');
  }

  const questions = body.interview?.questions;
  if (!Array.isArray(questions) || questions.length < 1) {
    errors.push('interview.questions is required and must contain at least one item');
  } else {
    const seenIds = new Set();
    questions.forEach((q, idx) => {
      const prefix = `interview.questions[${idx}]`;
      if (!q || typeof q !== 'object') {
        errors.push(`${prefix} must be an object`);
        return;
      }
      const qid = q.question_id;
      if (!Number.isInteger(qid)) {
        errors.push(`${prefix}.question_id is required and must be an integer`);
      } else if (seenIds.has(qid)) {
        errors.push(`${prefix}.question_id must be unique within the array`);
      } else {
        seenIds.add(qid);
      }
      if (!sanitizeString(q.question, 4000)) {
        errors.push(`${prefix}.question is required`);
      }
      if (!sanitizeString(q.skill, 255)) {
        errors.push(`${prefix}.skill is required`);
      }
    });
  }

  const callback = body.callback;
  if (!callback || typeof callback !== 'object') {
    errors.push('callback is required');
  } else {
    const webhookUrl = sanitizeString(callback.webhook_url, 2048);
    if (!webhookUrl) errors.push('callback.webhook_url is required');
    else if (!isValidUrl(webhookUrl)) errors.push('callback.webhook_url must be a valid http or https URL');

    const webhookSecret = sanitizeString(callback.webhook_secret, 512);
    if (!webhookSecret) errors.push('callback.webhook_secret is required');

    const eventsWebhookUrl = sanitizeString(callback.events_webhook_url, 2048);
    if (eventsWebhookUrl && !isValidUrl(eventsWebhookUrl)) {
      errors.push('callback.events_webhook_url must be a valid http or https URL');
    }
  }

  if (errors.length) {
    return { ok: false, errors };
  }

  const normalizedQuestions = questions.map((q, i) => ({
    question_id: q.question_id,
    question: sanitizeString(q.question, 4000),
    skill: sanitizeString(q.skill, 255),
    order: i + 1,
  }));

  return {
    ok: true,
    data: {
      candidate_name: candidateName,
      candidate_email: emailRaw,
      interview_type: interviewType,
      session_type: sessionType,
      scheduled_at: scheduledAt,
      scheduled_at_iso: scheduledRaw,
      timezone,
      send_email_invite_immediately: body.send_email_invite_immediately,
      interview_questions: normalizedQuestions,
      callback: {
        webhook_url: sanitizeString(body.callback.webhook_url, 2048),
        webhook_secret: sanitizeString(body.callback.webhook_secret, 512),
        events_webhook_url: sanitizeString(body.callback.events_webhook_url, 2048) || null,
        events_webhook_secret: sanitizeString(body.callback.events_webhook_secret, 512) || null,
      },
    },
  };
}
