import { FLAG_SEVERITY, FLAG_TYPES, SESSION_STATUS } from '../constants.js';
import { interviewConfig } from '../config.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { flagRepository } from '../repositories/flag.repository.js';
import { integrityAuditService, integrityLog, integrityDebug } from './integrity-audit.service.js';
import { integrityRiskEngine, INTEGRITY_RISK_LEVEL } from './integrity-risk-engine.service.js';
import { proctoringViolationService } from './proctoring-violation.service.js';
import { proctorDebugFlow, proctorLogActivityDetected } from './proctoring-debug.service.js';
import { canonicalFlagType } from '../lib/proctoring-flag-naming.js';

const escalationCooldownMs = 25_000;
const recentEscalations = new Map();

function parseMeta(session) {
  return integrityAuditService.parseMeta(session);
}

async function persistMeta(sessionId, meta) {
  await sessionRepository.update(sessionId, { metadata_json: meta });
  return meta;
}

function parseSignature(sig) {
  if (!sig || typeof sig !== 'string') return null;
  const arr = sig
    .split(',')
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  return arr.length >= 4 ? arr : null;
}

function signatureDistance(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / a.length);
}

const VIRTUAL_CAMERA_PATTERNS = [
  /obs virtual/i,
  /obs-camera/i,
  /snap camera/i,
  /manycam/i,
  /droidcam/i,
  /camo studio/i,
  /epoccam/i,
  /iriun/i,
  /xsplit/i,
  /virtual cam/i,
  /mmhmm/i,
  /nvidia broadcast/i,
  /logitech capture/i,
];

export const integrityService = {
  async processHeartbeat(session, payload = {}) {
    if (!session?.id) return { ok: false };

    const fresh = await sessionRepository.findById(session.id);
    if (!fresh || fresh.status !== SESSION_STATUS.IN_PROGRESS) {
      return { ok: true, skipped: true };
    }

    let meta = integrityRiskEngine.recordHeartbeat(parseMeta(fresh), {
      receivedAtMs: Date.now(),
    });

    integrityLog('Heartbeat received', {
      session_id: session.id,
      detail: `camera=${payload.camera_active !== false}, mic=${payload.mic_active !== false}, focus=${payload.focus !== false}`,
    });

    const signalQueue = [];

    if (meta.integrity?.consecutive_heartbeat_misses >= interviewConfig.integrityHeartbeatMissThreshold) {
      signalQueue.push({
        subType: 'heartbeat_miss',
        confidence: Math.min(95, 50 + meta.integrity.consecutive_heartbeat_misses * 12),
        payload: { misses: meta.integrity.consecutive_heartbeat_misses, source: 'heartbeat' },
      });
    }

    if (payload.camera_active === false) {
      signalQueue.push({ subType: 'camera_interrupt', confidence: 85, payload: { source: 'heartbeat' } });
    }
    if (payload.mic_active === false) {
      signalQueue.push({ subType: 'mic_interrupt', confidence: 70, payload: { source: 'heartbeat' } });
    }
    if (payload.frame_stall === true) {
      signalQueue.push({
        subType: 'frame_stall',
        confidence: payload.frame_stall_confidence || 72,
        payload: { source: 'heartbeat' },
      });
    }
    if (payload.recording_stalled === true) {
      signalQueue.push({
        subType: 'recording_gap',
        confidence: payload.recording_stall_confidence || 75,
        payload: { source: 'heartbeat' },
      });
    }

    const deviceLabel = String(payload.video_device_label || '');
    if (deviceLabel && VIRTUAL_CAMERA_PATTERNS.some((re) => re.test(deviceLabel))) {
      signalQueue.push({
        subType: 'virtual_camera',
        confidence: payload.virtual_camera_confidence || 88,
        payload: { device_label: deviceLabel, source: 'heartbeat' },
      });
    }

    const baselineSig = parseSignature(meta?.verified_face_signature);
    const liveSig = parseSignature(payload?.face_signature);
    if (baselineSig && liveSig) {
      const dist = signatureDistance(baselineSig, liveSig);
      if (dist != null && dist > 0.1) {
        signalQueue.push({
          subType: dist > 0.18 ? 'face_change' : 'identity_drift',
          confidence: Math.min(98, Math.round(((dist - 0.1) / 0.25) * 100)),
          payload: { distance: Number(dist.toFixed(4)), source: 'heartbeat' },
        });
      }
    }

    if (interviewConfig.livenessDetectionEnabled && Array.isArray(payload.liveness_alerts)) {
      for (const alert of payload.liveness_alerts) {
        if (alert?.sub_type) {
          signalQueue.push({
            subType: alert.sub_type,
            confidence: alert.confidence || 0,
            payload: { ...alert, source: 'heartbeat' },
          });
        }
      }
    }

    if (Array.isArray(payload.voice_alerts)) {
      for (const alert of payload.voice_alerts) {
        if (alert?.sub_type) {
          signalQueue.push({
            subType: alert.sub_type,
            confidence: alert.confidence || 0,
            payload: { ...alert, source: 'heartbeat' },
          });
        }
      }
    }

    const pendingEscalations = [];
    for (const sig of signalQueue) {
      const recorded = integrityRiskEngine.recordSignal(meta, {
        eventType: 'integrity_signal',
        subType: sig.subType,
        confidence: sig.confidence,
        sessionState: payload,
        payload: { ...sig.payload, session_id: session.id },
        silent: true,
      });
      meta = recorded.meta;
      if (recorded.evaluation?.shouldEscalate) {
        pendingEscalations.push({ evaluation: recorded.evaluation, payload: sig.payload });
      }
    }

    await persistMeta(session.id, meta);

    const escalations = [];
    for (const item of pendingEscalations) {
      const result = await this.escalate(fresh, item.evaluation, item.payload);
      if (result.escalated) escalations.push(result);
    }

    const integrity = integrityRiskEngine.getState(meta);
    let proctoring = null;
    let proctoringAction = 'none';
    for (const e of escalations) {
      if (e.proctoring) proctoring = e.proctoring;
      if (e.proctoring_action === 'terminate') {
        proctoringAction = 'terminate';
        break;
      }
      if (e.proctoring_action === 'final_warning') proctoringAction = 'final_warning';
      else if (e.proctoring_action === 'warning' && proctoringAction !== 'final_warning') {
        proctoringAction = 'warning';
      }
    }

    return {
      ok: true,
      integrity_score: integrity.integrity_score,
      risk_level: integrity.risk_level,
      identity_confidence: integrity.identity_confidence,
      liveness_confidence: integrity.liveness_confidence,
      verification_challenge_active: integrity.verification_challenge_active === true,
      proctoring,
      proctoring_action: proctoringAction,
      terminate: proctoringAction === 'terminate',
      escalations: escalations.map((e) => ({
        flag_type: e.flag_type,
        action: e.proctoring_action,
      })),
    };
  },

  async ingestSignal(session, {
    subType,
    confidence = 0,
    payload = {},
    sessionState = null,
    screenshotRef = null,
    audioRef = null,
    forceEscalate = false,
  } = {}) {
    const fresh = await sessionRepository.findById(session.id);
    if (!fresh) return { ok: false };

    let meta = parseMeta(fresh);
    const { meta: updatedMeta, evaluation } = integrityRiskEngine.recordSignal(meta, {
      eventType: 'integrity_signal',
      subType,
      confidence,
      sessionState,
      screenshotRef,
      audioRef,
      payload: { ...payload, session_id: session.id },
      silent: !forceEscalate,
    });

    meta = updatedMeta;
    await persistMeta(session.id, meta);

    if (!evaluation.shouldEscalate && !forceEscalate) {
      integrityDebug('signal_silent', {
        session_id: session.id,
        sub_type: subType,
        confidence,
        integrity_score: meta.integrity?.integrity_score,
      });
      return { ok: true, escalated: false, meta, evaluation };
    }

    return this.escalate(fresh, { ...evaluation, shouldEscalate: true }, payload);
  },

  async ingestSignals(session, signals = []) {
    const results = [];
    for (const sig of signals) {
      if (!sig?.sub_type) continue;
      results.push(
        await this.ingestSignal(session, {
          subType: sig.sub_type,
          confidence: sig.confidence,
          payload: sig.payload || sig,
          sessionState: sig.session_state,
          screenshotRef: sig.screenshot_ref,
          audioRef: sig.audio_ref,
        })
      );
    }
    return results;
  },

  async escalate(session, evaluation, payload = {}) {
    const flagType = evaluation.flagType || FLAG_TYPES.INTEGRITY_ANOMALY;
    const canonical = canonicalFlagType(flagType);
    const cooldownKey = `${session.id}:${canonical}:${evaluation.subType}`;
    const last = recentEscalations.get(cooldownKey);
    if (last && Date.now() - last < escalationCooldownMs) {
      integrityLog('Escalation suppressed (cooldown)', {
        session_id: session.id,
        event_type: evaluation.subType,
        detail: `flag=${canonical}`,
      });
      return { ok: true, escalated: false, deduped: true, evaluation };
    }
    recentEscalations.set(cooldownKey, Date.now());

    const severity =
      evaluation.critical || evaluation.riskLevel === INTEGRITY_RISK_LEVEL.CRITICAL
        ? FLAG_SEVERITY.HIGH
        : FLAG_SEVERITY.MEDIUM;

    const message = evaluation.message || `Integrity violation: ${evaluation.subType}`;
    const flagId = await flagRepository.create({
      session_id: session.id,
      flag_type: canonical,
      severity,
      message,
      payload_json: {
        ...payload,
        integrity_sub_type: evaluation.subType,
        confidence: evaluation.confidence,
        integrity_score: evaluation.integrityScore,
        risk_level: evaluation.riskLevel,
        streak: evaluation.streak,
        source: payload.source || 'integrity_engine',
        at: new Date().toISOString(),
      },
    });

    let meta = parseMeta(session);
    meta = integrityAuditService.appendEvent(meta, {
      event_type: 'integrity_escalation',
      sub_type: evaluation.subType,
      confidence: evaluation.confidence,
      risk_contribution: evaluation.integrityScore,
      risk_level: evaluation.riskLevel,
      flag_type: canonical,
      escalated: true,
      payload,
    });
    if (meta.integrity) {
      meta.integrity.escalated_at = {
        ...(meta.integrity.escalated_at || {}),
        [evaluation.subType]: new Date().toISOString(),
      };
    }
    await persistMeta(session.id, meta);

    proctorLogActivityDetected(session, canonical, {
      flag_id: flagId,
      source: 'integrity_engine',
    });

    integrityLog('Escalation triggered', {
      session_id: session.id,
      event_type: evaluation.subType,
      confidence: evaluation.confidence,
      integrity_score: evaluation.integrityScore,
      risk_level: evaluation.riskLevel,
      detail: `flag=${canonical}, flag_id=${flagId}`,
    });

    proctorDebugFlow('integrity_escalation', {
      session_id: session.id,
      flag_type: canonical,
      sub_type: evaluation.subType,
      flag_id: flagId,
      confidence: evaluation.confidence,
      integrity_score: evaluation.integrityScore,
    });

    const escalation = await proctoringViolationService.processViolation(session, canonical, {
      flagId,
      message,
      source: 'integrity_engine',
      payload: {
        ...payload,
        integrity_sub_type: evaluation.subType,
        confidence: evaluation.confidence,
      },
    });

    return {
      ok: true,
      escalated: true,
      flag_id: flagId,
      flag_type: canonical,
      message,
      evaluation,
      meta,
      proctoring: escalation.proctoring,
      proctoring_action: escalation.action,
      terminate: escalation.action === 'terminate',
      trigger_flag_type: escalation.trigger_flag_type || canonical,
    };
  },

  async recordExistingViolation(session, flagType, confidence = 50) {
    return this.ingestSignal(session, {
      subType: 'existing_violation',
      confidence,
      payload: { linked_flag: flagType },
      forceEscalate: false,
    });
  },

  async escalateRepeatQuestionAbuse(session, { questionId, repeatCount } = {}) {
    return this.ingestSignal(session, {
      subType: 'repeat_question_abuse',
      confidence: Math.min(90, 55 + repeatCount * 8),
      payload: { question_id: questionId, repeat_count: repeatCount },
      forceEscalate: true,
    });
  },

  async evaluateVerificationAnswer(session, { questionId, priorAnswer, newAnswer, delayMs = 0 } = {}) {
    const prior = String(priorAnswer || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const next = String(newAnswer || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!prior || !next || prior.length < 20 || next.length < 10) {
      return { ok: true, checked: false };
    }

    const priorTokens = new Set(prior.split(' ').filter((w) => w.length > 3));
    const nextTokens = new Set(next.split(' ').filter((w) => w.length > 3));
    let overlap = 0;
    for (const t of priorTokens) {
      if (nextTokens.has(t)) overlap += 1;
    }
    const overlapRatio = priorTokens.size ? overlap / priorTokens.size : 0;
    const contradiction = overlapRatio < 0.15 && next.length > 30;
    const majorMismatch = overlapRatio < 0.08 && next.length > 40;

    if (!contradiction && !majorMismatch) {
      return { ok: true, checked: true, overlap_ratio: overlapRatio };
    }

    const confidence = majorMismatch ? 82 : 68;
    const result = await this.ingestSignal(session, {
      subType: 'verification_mismatch',
      confidence,
      payload: {
        question_id: questionId,
        overlap_ratio: Number(overlapRatio.toFixed(3)),
        response_delay_ms: delayMs,
      },
      forceEscalate: majorMismatch,
    });

    return { ok: true, checked: true, overlap_ratio: overlapRatio, escalation: result };
  },

  getTimeline(session) {
    const meta = parseMeta(session);
    return integrityRiskEngine.buildEnterpriseReport(session, meta);
  },

  buildReport(session) {
    const meta = parseMeta(session);
    return integrityRiskEngine.buildEnterpriseReport(session, meta);
  },
};
