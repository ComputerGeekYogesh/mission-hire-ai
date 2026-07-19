import moment from 'moment-timezone';
import { telemetryRepository } from '../repositories/telemetry.repository.js';
import { suspiciousService } from './suspicious.service.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { proctorDebugFlow } from './proctoring-debug.service.js';

function parseMeta(session) {
  try {
    return typeof session.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session.metadata_json || {};
  } catch {
    return {};
  }
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

export const telemetryService = {
  async ingest(session, payload) {
    const recordedAt = payload.timestamp
      ? moment(payload.timestamp).format('YYYY-MM-DD HH:mm:ss')
      : moment().format('YYYY-MM-DD HH:mm:ss');

    const movementScore =
      payload.movement_score ??
      (Math.abs(payload.yaw || 0) + Math.abs(payload.pitch || 0)) / 2;

    let suspiciousFlag = false;
    const preFlags = await suspiciousService.evaluateTelemetry(session, {
      ...payload,
      movement_score: movementScore,
    });
    const raised = preFlags.filter(Boolean);
    if (payload.face_absent_seconds) {
      const absentFlag = await suspiciousService.evaluateFaceAbsent(session, payload.face_absent_seconds);
      if (absentFlag) raised.push(absentFlag);
    }

    const meta = parseMeta(session);
    const baselineSig = parseSignature(meta?.verified_face_signature);
    const liveSig = parseSignature(payload?.face_signature);
    if (baselineSig && liveSig) {
      const dist = signatureDistance(baselineSig, liveSig);
      if (dist != null) {
        const mismatch = dist > 0.12;
        const confidence = mismatch ? Math.min(1, Math.max(0, (dist - 0.12) / 0.2)) : 0;
        const idFlag = await suspiciousService.evaluateIdentityMismatch(session, {
          mismatch,
          confidence,
          distance: Number(dist.toFixed(4)),
          payload: { face_signature: payload.face_signature },
        });
        if (idFlag) raised.push(idFlag);
      }
    }

    if (payload.speech_transcript && payload.current_question_text) {
      const speechFlag = await suspiciousService.evaluateQuestionRepetitionFromSpeech(session, {
        questionText: payload.current_question_text,
        speechText: payload.speech_transcript,
        questionId: payload.current_question_id ?? null,
      });
      if (speechFlag) raised.push(speechFlag);
    }

    if (payload.attention_sample_count != null || payload.gaze_valid) {
      const attentionFlags = await suspiciousService.evaluateAttentionFlags(session, payload);
      raised.push(...attentionFlags);
    }

    if (raised.length) suspiciousFlag = true;

    if (raised.length) {
      proctorDebugFlow('telemetry_ingest', {
        session_id: session.id,
        flag_count: raised.length,
        flag_types: raised.map((f) => f.flag_type),
        proctoring_actions: raised.map((f) => f.proctoring_action || 'none'),
      });
    }

    let proctoring = null;
    let proctoringAction = 'none';
    let triggerFlagType = null;
    for (const f of raised) {
      if (!f?.proctoring) continue;
      proctoring = f.proctoring;
      if (f.trigger_flag_type) triggerFlagType = f.trigger_flag_type;
      if (f.proctoring_action === 'terminate') {
        proctoringAction = 'terminate';
        break;
      }
      if (f.proctoring_action === 'final_warning') proctoringAction = 'final_warning';
      else if (f.proctoring_action === 'warning' && proctoringAction !== 'final_warning') {
        proctoringAction = 'warning';
      }
    }

    const id = await telemetryRepository.create({
      session_id: session.id,
      blink_count: payload.blink ?? payload.blink_count ?? 0,
      yaw: payload.yaw ?? null,
      pitch: payload.pitch ?? null,
      roll: payload.roll ?? null,
      movement_score: movementScore,
      face_detected: payload.faceDetected ?? payload.face_detected ?? false,
      face_count: payload.face_count ?? (payload.faceDetected ? 1 : 0),
      mic_active: payload.mic_active !== false,
      camera_active: payload.camera_active !== false,
      tab_visible: payload.tab_visible !== false,
      suspicious_flag: suspiciousFlag,
      recorded_at: recordedAt,
    });

    return {
      id,
      suspiciousFlag,
      flags: raised.map((f) => ({
        type: f.flag_type,
        message: f.message,
        severity: f.severity,
        proctoring_action: f.proctoring_action || null,
      })),
      proctoring,
      proctoring_action: proctoringAction,
      trigger_flag_type: triggerFlagType,
      terminate: proctoringAction === 'terminate',
    };
  },

  async getSessionReport(sessionId) {
    const aggregates = await telemetryRepository.getAggregates(sessionId);
    const samples = await telemetryRepository.listBySession(sessionId, 200);
    return { aggregates, samples };
  },
};
