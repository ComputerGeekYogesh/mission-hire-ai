import os from 'os';
import { interviewConfig } from '../config.js';

const MAX_AUDIT_EVENTS = 500;

function parseMeta(session) {
  try {
    return typeof session.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session.metadata_json || {};
  } catch {
    return {};
  }
}

/**
 * Human-readable integrity logs for backend debugging.
 * Grep: [INTEGRITY]
 */
export function integrityLog(message, meta = {}) {
  console.log(`[INTEGRITY] ${message}`);
  if (meta.session_id != null) {
    console.log(`[INTEGRITY] Session ID: ${meta.session_id}`);
  }
  if (meta.event_type != null) {
    console.log(`[INTEGRITY] Event: ${meta.event_type}`);
  }
  if (meta.confidence != null) {
    console.log(`[INTEGRITY] Confidence: ${meta.confidence}`);
  }
  if (meta.risk_contribution != null) {
    console.log(`[INTEGRITY] Risk contribution: ${meta.risk_contribution}`);
  }
  if (meta.integrity_score != null) {
    console.log(`[INTEGRITY] Integrity score: ${meta.integrity_score}`);
  }
  if (meta.risk_level != null) {
    console.log(`[INTEGRITY] Risk level: ${meta.risk_level}`);
  }
  if (meta.detail != null) {
    console.log(`[INTEGRITY] ${meta.detail}`);
  }
}

export function integrityDebug(step, meta = {}) {
  console.log(
    '[integrity-debug]',
    JSON.stringify({
      step,
      ts: new Date().toISOString(),
      host: os.hostname(),
      pid: process.pid,
      ...meta,
    })
  );
}

export const integrityAuditService = {
  getAuditEvents(meta) {
    return meta?.integrity?.audit_events || [];
  },

  /**
   * Append an audit event to session metadata (in-memory); caller persists.
   */
  appendEvent(meta, event) {
    const integrity = { ...(meta.integrity || {}) };
    const events = [...(integrity.audit_events || [])];
    const entry = {
      id: `${Date.now()}_${events.length}`,
      at: new Date().toISOString(),
      ...event,
    };
    events.push(entry);
    if (events.length > MAX_AUDIT_EVENTS) {
      events.splice(0, events.length - MAX_AUDIT_EVENTS);
    }
    integrity.audit_events = events;
    integrity.audit_event_count = events.length;
    return { ...meta, integrity };
  },

  buildTimeline(meta) {
    const events = meta?.integrity?.audit_events || [];
    return events.map((e) => ({
      at: e.at,
      event_type: e.event_type,
      sub_type: e.sub_type || null,
      confidence: e.confidence ?? null,
      risk_contribution: e.risk_contribution ?? null,
      risk_level: e.risk_level || null,
      session_state: e.session_state || null,
      screenshot_ref: e.screenshot_ref || null,
      audio_ref: e.audio_ref || null,
      flag_type: e.flag_type || null,
      escalated: e.escalated === true,
      payload: e.payload || null,
    }));
  },

  buildSuspiciousSummary(meta) {
    const events = meta?.integrity?.audit_events || [];
    const byType = {};
    for (const e of events) {
      const key = e.event_type || 'unknown';
      if (!byType[key]) {
        byType[key] = { count: 0, max_confidence: 0, total_risk: 0 };
      }
      byType[key].count += 1;
      byType[key].max_confidence = Math.max(byType[key].max_confidence, Number(e.confidence) || 0);
      byType[key].total_risk += Number(e.risk_contribution) || 0;
    }
    return byType;
  },

  parseMeta,
};
