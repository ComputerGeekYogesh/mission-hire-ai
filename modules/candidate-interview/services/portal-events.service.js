import axios from 'axios';
import { mockCallBridge } from './mock-call-bridge.service.js';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

function measurePayloadBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return 0;
  }
}

export const PORTAL_EVENTS = Object.freeze({
  INVITE_SENT: 'invite_sent',
  OTP_SENT: 'otp_sent',
  OTP_VERIFIED: 'otp_verified',
  CALL_STARTED: 'call_started',
  CALL_ENDED: 'call_ended',
});

function parseMetadata(session) {
  try {
    return typeof session?.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session?.metadata_json || {};
  } catch {
    return {};
  }
}

export function getPortalEventsWebhookConfig(session) {
  const meta = parseMetadata(session);
  const callback = meta.callback || {};
  const url = String(callback.events_webhook_url || '').trim();
  const secret = String(callback.events_webhook_secret || callback.webhook_secret || '').trim();
  return {
    url: url || null,
    secret: secret || null,
    source: meta.source || null,
    timezone: meta.timezone || null,
    scheduled_at_iso: meta.scheduled_at_iso || null,
  };
}

export function hasPortalEventsWebhook(session) {
  const { url, secret, source } = getPortalEventsWebhookConfig(session);
  return source === 'api' && Boolean(url && secret);
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString();
}

/** Omit null/undefined keys so receivers don't choke on explicit nulls in upserts. */
function compactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function summarizeResponseBody(data) {
  if (data == null) return null;
  if (typeof data === 'string') return data.slice(0, 800);
  try {
    return JSON.stringify(data).slice(0, 800);
  } catch {
    return String(data).slice(0, 800);
  }
}

export function buildPortalEventPayload(session, event, eventData = {}) {
  const meta = parseMetadata(session);
  const occurredAt = eventData.occurred_at || new Date().toISOString();
  const { occurred_at: _drop, ...eventDataRest } = eventData;

  const timestamps = compactObject({
    invite_sent_at: toIso(session?.invite_sent_at),
    otp_verified_at: toIso(session?.otp_verified_at),
    preflight_completed_at: toIso(session?.preflight_completed_at),
    started_at: toIso(session?.started_at),
    ended_at: toIso(session?.ended_at),
  });

  const mockCallId =
    meta.mock_call_id || (session?.id != null ? mockCallBridge.buildCallId(session.id) : null);

  return compactObject({
    type: 'assessment_portal_event',
    event,
    occurred_at: occurredAt,
    session_id: session?.id ?? null,
    session_token: session?.session_token ?? null,
    mock_call_id: mockCallId,
    call_sid: meta.call_sid || null,
    email: session?.candidate_email ?? null,
    candidate_name: session?.candidate_name ?? null,
    candidate_phone: session?.candidate_phone ?? null,
    scheduled_at: toIso(session?.scheduled_at) || session?.scheduled_at || null,
    timezone: meta.timezone || null,
    source: meta.source || 'api',
    session_status: session?.status ?? null,
    interview_type: session?.interview_type ?? null,
    interview_link: eventDataRest.interview_link || null,
    ...(Object.keys(timestamps).length ? { timestamps } : {}),
    event_data: compactObject(eventDataRest),
  });
}

async function postAttempt(url, secret, payload, attempt) {
  const started = Date.now();
  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': secret,
        'X-Portal-Event': payload.event,
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
    const elapsed = Date.now() - started;
    const ok = response.status >= 200 && response.status < 300;
    const responsePreview = summarizeResponseBody(response.data);

    if (ok) {
      console.log(
        `[portal-events] event=${payload.event} session=${payload.session_id} attempt=${attempt}/${MAX_ATTEMPTS} status=${response.status} elapsed=${elapsed}ms url=${url}`
      );
    } else {
      console.error(
        `[portal-events] event=${payload.event} session=${payload.session_id} attempt=${attempt}/${MAX_ATTEMPTS} status=${response.status} elapsed=${elapsed}ms url=${url} response=${responsePreview}`
      );
    }

    return {
      ok,
      status: response.status,
      response_body: responsePreview,
      url,
    };
  } catch (err) {
    const elapsed = Date.now() - started;
    const responsePreview = summarizeResponseBody(err.response?.data);
    console.error(
      `[portal-events] event=${payload?.event} session=${payload?.session_id} attempt=${attempt} network_error elapsed=${elapsed}ms url=${url} message=${err.message} status=${err.response?.status || 0} response=${responsePreview}`
    );
    return {
      ok: false,
      status: err.response?.status || 0,
      error: err.message,
      response_body: responsePreview,
      url,
    };
  }
}

/**
 * POST lifecycle event to portal events webhook (non-blocking caller should void this).
 */
export async function deliverPortalEvent(session, event, eventData = {}) {
  const { url, secret } = getPortalEventsWebhookConfig(session);
  if (!url || !secret) {
    return { delivered: false, reason: 'no_events_webhook' };
  }

  const payload = buildPortalEventPayload(session, event, eventData);
  const payloadBytes = measurePayloadBytes(payload);

  console.log(
    `[portal-events] Dispatching event=${event} session=${session?.id} email=${payload.email} url=${url} payload_bytes=${payloadBytes}`
  );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await postAttempt(url, secret, payload, attempt);
    if (result.ok) {
      return { delivered: true, attempts: attempt, status: result.status, event };
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  console.error(
    `[portal-events] Delivery failed after ${MAX_ATTEMPTS} attempts event=${event} session=${session?.id} url=${url} payload_bytes=${payloadBytes} — check receiver logs (HTTP 500 often means DB/tables missing on receiver)`
  );
  return { delivered: false, attempts: MAX_ATTEMPTS, event, url, payloadBytes };
}

/** Fire-and-forget portal event for API-scheduled sessions. */
export function emitPortalEvent(session, event, eventData = {}) {
  if (!hasPortalEventsWebhook(session)) {
    const cfg = getPortalEventsWebhookConfig(session);
    console.log(
      `[portal-events] Skipping event=${event} session=${session?.id} source=${cfg.source || 'unknown'} has_events_url=${Boolean(cfg.url)} has_secret=${Boolean(cfg.secret)}`
    );
    return;
  }
  void deliverPortalEvent(session, event, eventData).catch((err) => {
    console.error(`[portal-events] Unhandled error event=${event} session=${session?.id}:`, err.message);
  });
}
