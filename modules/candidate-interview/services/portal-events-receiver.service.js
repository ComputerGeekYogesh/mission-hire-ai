import moment from 'moment-timezone';
import db from '../../../config/db.js';
import { ensurePortalEventsTables } from './portal-events-receiver-migration.service.js';

function toMysqlDatetime(value) {
  if (!value) return moment().format('YYYY-MM-DD HH:mm:ss.SSS');
  const m = moment(value);
  if (!m.isValid()) return moment().format('YYYY-MM-DD HH:mm:ss.SSS');
  return m.format('YYYY-MM-DD HH:mm:ss.SSS');
}

function timelineColumnForEvent(event) {
  switch (event) {
    case 'invite_sent':
      return 'invite_sent_at';
    case 'otp_sent':
      return 'otp_sent_at';
    case 'otp_verified':
      return 'otp_verified_at';
    case 'call_started':
      return 'call_started_at';
    case 'call_ended':
      return 'call_ended_at';
    default:
      return null;
  }
}

export function validatePortalEventsSecret(req) {
  const headerSecret = String(req.get('X-Webhook-Secret') || '').trim();
  const expected = String(process.env.MISSIONAI_EVENTS_WEBHOOK_SECRET || '').trim();
  if (!expected) {
    console.warn('[portal-events-receiver] MISSIONAI_EVENTS_WEBHOOK_SECRET is not set — rejecting request');
    return false;
  }
  return headerSecret.length > 0 && headerSecret === expected;
}

export async function persistPortalEvent(payload) {
  await ensurePortalEventsTables();

  const sessionId = Number(payload.session_id);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    const err = new Error('session_id is required');
    err.status = 400;
    throw err;
  }

  const event = String(payload.event || '').trim();
  if (!event) {
    const err = new Error('event is required');
    err.status = 400;
    throw err;
  }

  const occurredAt = toMysqlDatetime(payload.occurred_at);
  const eventData = payload.event_data && typeof payload.event_data === 'object' ? payload.event_data : {};

  let payloadJson;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (err) {
    const wrap = new Error(`Invalid payload JSON: ${err.message}`);
    wrap.status = 400;
    throw wrap;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO assessment_portal_events
        (session_id, session_token, mock_call_id, event, occurred_at, email, candidate_name, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        payload.session_token ?? null,
        payload.mock_call_id ?? null,
        event,
        occurredAt,
        payload.email ?? null,
        payload.candidate_name ?? null,
        payloadJson,
      ]
    );

    const timelineCol = timelineColumnForEvent(event);
    const timelineFields = {
      session_id: sessionId,
      session_token: payload.session_token ?? null,
      mock_call_id: payload.mock_call_id ?? null,
      email: payload.email ?? null,
      candidate_name: payload.candidate_name ?? null,
      last_event: event,
      last_event_at: occurredAt,
      interview_link: eventData.interview_link ?? payload.interview_link ?? null,
    };

    if (event === 'call_ended') {
      timelineFields.proctoring_terminated =
        eventData.proctoring_terminated === true || eventData.assessment_termination === true ? 1 : 0;
    }

    if (timelineCol) {
      timelineFields[timelineCol] = occurredAt;
    }

    const columns = Object.keys(timelineFields);
    const placeholders = columns.map(() => '?').join(', ');
    const updates = columns
      .filter((c) => c !== 'session_id')
      .map((c) => `${c} = VALUES(${c})`)
      .join(', ');

    await conn.query(
      `INSERT INTO assessment_portal_timeline (${columns.join(', ')})
       VALUES (${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      columns.map((c) => timelineFields[c])
    );

    await conn.commit();
    console.log(
      `[portal-events-receiver] Persisted event=${event} session=${sessionId} occurred_at=${occurredAt}`
    );
    return { ok: true, session_id: sessionId, event };
  } catch (err) {
    await conn.rollback();
    console.error(
      `[portal-events-receiver] Persist failed event=${event} session=${sessionId}:`,
      err.message,
      err.code || '',
      err.sqlMessage || ''
    );
    const wrap = new Error(`Failed to persist portal event: ${err.sqlMessage || err.message}`);
    wrap.status = 500;
    wrap.cause = err;
    throw wrap;
  } finally {
    conn.release();
  }
}
