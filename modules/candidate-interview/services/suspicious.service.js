import { FLAG_SEVERITY, FLAG_TYPES, SESSION_STATUS } from '../constants.js';
import { interviewConfig } from '../config.js';
import { flagRepository } from '../repositories/flag.repository.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { detectQuestionRepetition } from '../lib/question-repeat-detect.js';
import { logInterviewError } from './interview-error-log.service.js';
import { proctoringViolationService } from './proctoring-violation.service.js';
import { integrityService } from './integrity.service.js';
import { proctorDebug, proctorDebugFlow, proctorLogActivityDetected } from './proctoring-debug.service.js';
import {
  evaluateAttentionMetrics,
  noteFocusLossEvent,
} from './attention-analysis.service.js';
import { canonicalFlagType, activityDisplayName } from '../lib/proctoring-flag-naming.js';

const recentFlags = new Map();
const headStrikeCounts = new Map();
const offAngleState = new Map();
const identityMismatchCounts = new Map();
/** One warning/terminate escalation per telemetry HTTP ingest. */
const telemetryIngestBatch = new Map();

function bumpHeadStrike(sessionId) {
  const n = (headStrikeCounts.get(sessionId) || 0) + 1;
  headStrikeCounts.set(sessionId, n);
  return n;
}

function resetHeadStrike(sessionId) {
  headStrikeCounts.set(sessionId, 0);
}

async function raiseFlag(sessionId, flagType, severity, message, payload, cooldownMs = 10_000) {
  const canonicalType = canonicalFlagType(flagType);
  const scope = payload?.question_id != null ? `:${payload.question_id}` : '';
  const key = `${sessionId}:${canonicalType}${scope}`;
  const last = recentFlags.get(key);
  if (last && Date.now() - last < cooldownMs) return null;
  recentFlags.set(key, Date.now());

  const id = await flagRepository.create({
    session_id: sessionId,
    flag_type: canonicalType,
    severity,
    message,
    payload_json: payload,
  });

  proctorDebugFlow('flag_created', {
    session_id: sessionId,
    flag_type: canonicalType,
    raw_flag_type: flagType,
    flag_id: id,
    severity,
    activity_label: activityDisplayName(canonicalType),
    message: String(message || '').slice(0, 200),
    source: payload?.source || 'telemetry',
  });

  if (severity === FLAG_SEVERITY.HIGH) {
    const highSession = await sessionRepository.findById(sessionId);
    if (highSession && highSession.status === SESSION_STATUS.IN_PROGRESS) {
      await sessionRepository.update(sessionId, { status: SESSION_STATUS.SUSPICIOUS });
    }
  }

  const session = await sessionRepository.findById(sessionId);
  if (session) {
    proctorLogActivityDetected(session, canonicalType, {
      flag_id: id,
      source: payload?.source || 'telemetry',
    });
  }
  logInterviewError({
    severity: severity === FLAG_SEVERITY.HIGH ? 'warning' : 'info',
    sessionId,
    sessionToken: session?.session_token,
    sourceTag: 'proctoring_flag',
    message: `[${flagType}] ${message}`,
    context: { flag_type: canonicalType, severity, flag_id: id },
  }).catch(() => {});

  proctorDebug('flag_raised', {
    session_id: sessionId,
    flag_type: canonicalType,
    flag_id: id,
    severity,
    cooldown_ms: cooldownMs,
  });

  const sessionForViolation = session || (await sessionRepository.findById(sessionId));
  let escalation = { action: 'none', proctoring: null };
  const batch = telemetryIngestBatch.get(sessionId);
  const skipEscalation = batch?.escalated === true;

  if (sessionForViolation && !skipEscalation) {
    escalation = await proctoringViolationService.processViolation(sessionForViolation, canonicalType, {
      flagId: id,
      message,
      source: payload?.source || 'telemetry',
      payload,
    });
    integrityService
      .recordExistingViolation(sessionForViolation, canonicalType, severity === FLAG_SEVERITY.HIGH ? 70 : 45)
      .catch(() => {});
    if (batch && escalation.action && escalation.action !== 'none') {
      batch.escalated = true;
      proctorDebugFlow('batch_escalation_locked', {
        session_id: sessionId,
        flag_type: canonicalType,
        action: escalation.action,
      });
    }
  } else if (sessionForViolation && skipEscalation) {
    const { state } = proctoringViolationService.getState(sessionForViolation);
    proctorDebugFlow('batch_escalation_skipped', {
      session_id: sessionId,
      flag_type: canonicalType,
      flag_id: id,
      reason: 'already_escalated_this_ingest',
    });
    escalation = {
      action: 'none',
      proctoring: {
        risk_score: state.effective_score,
        raw_risk_score: state.risk_score,
        warning_issued: state.warning_issued,
        warning_count: state.warning_count,
        integrity_status:
          (state.warning_count || 0) >= interviewConfig.proctoringFinalWarningStrike
            ? 'critical'
            : state.warning_issued
              ? 'warning'
              : 'ok',
        confidence_score: state.confidence_score,
        action: 'none',
        terminate: state.terminated,
        trigger_flag_type: null,
      },
    };
  }

  proctorDebugFlow('telemetry_logged', {
    session_id: sessionId,
    flag_type: canonicalType,
    flag_id: id,
    proctoring_action: escalation.action,
    risk_score: escalation.proctoring?.risk_score ?? null,
  });

  return {
    id,
    flag_type: canonicalType,
    message,
    severity,
    proctoring: escalation.proctoring,
    proctoring_action: escalation.action,
    trigger_flag_type: escalation.trigger_flag_type || canonicalType,
  };
}

export const suspiciousService = {
  beginTelemetryIngest(sessionId) {
    telemetryIngestBatch.set(sessionId, { escalated: false });
  },

  endTelemetryIngest(sessionId) {
    telemetryIngestBatch.delete(sessionId);
  },

  async evaluateTelemetry(session, payload) {
    const flags = [];
    const sessionId = session.id;

    // Rely on sustained face_absent_seconds (client) — avoid one-frame false NO_FACE alerts.

    const movementScore = Number(payload.movement_score) || 0;
    const hasAttentionMetrics =
      payload.gaze_valid === true ||
      (Number(payload.attention_sample_count) || 0) >= interviewConfig.attentionMinSamples;
    if (
      !hasAttentionMetrics &&
      movementScore >= interviewConfig.proctoringEyeMovementThreshold &&
      payload.face_detected !== false &&
      (payload.face_count || 0) === 1
    ) {
      flags.push(
        await raiseFlag(
          sessionId,
          FLAG_TYPES.EXCESSIVE_EYE_MOVEMENT,
          FLAG_SEVERITY.MEDIUM,
          `Excessive eye/head movement detected (score ${Math.round(movementScore)})`,
          { ...payload, movement_score: movementScore },
          15_000
        )
      );
    }

    const absentSec = Number(payload.face_absent_seconds) || 0;
    if (absentSec >= 10 && absentSec < interviewConfig.faceAbsentSecondsThreshold) {
      flags.push(
        await raiseFlag(
          sessionId,
          FLAG_TYPES.LEAVING_CAMERA_FRAME,
          FLAG_SEVERITY.HIGH,
          `Candidate left camera frame (${Math.round(absentSec)}s)`,
          { ...payload, absent_seconds: absentSec },
          12_000
        )
      );
    }

    const yaw = Math.abs(Number(payload.yaw) || 0);
    const pitch = Math.abs(Number(payload.pitch) || 0);
    const yawThreshold = interviewConfig.faceRotationYawThreshold;
    const pitchThreshold = interviewConfig.faceRotationPitchThreshold;
    const yawBad = yaw >= yawThreshold && yaw < 88;
    const pitchBad = pitch >= pitchThreshold && pitch < 88;

    if (yawBad || pitchBad) {
      const strikes = bumpHeadStrike(sessionId);
      const need = Math.max(5, interviewConfig.faceRotationSustainCount || 5);
      const now = Date.now();
      const off = offAngleState.get(sessionId) || { since: now, strikes: 0 };
      off.strikes += 1;
      if (!off.since) off.since = now;
      offAngleState.set(sessionId, off);
      const offDurationSec = (now - off.since) / 1000;
      if (strikes >= need) {
        flags.push(
          await raiseFlag(
            sessionId,
            FLAG_TYPES.FACE_ROTATION,
            FLAG_SEVERITY.HIGH,
            `Face rotated away from camera (${strikes} checks, yaw=${Math.round(yaw)}° pitch=${Math.round(pitch)}°)`,
            { ...payload, yaw, pitch, off_duration_seconds: Number(offDurationSec.toFixed(1)) },
            12_000
          )
        );
        resetHeadStrike(sessionId);
        offAngleState.set(sessionId, { since: Date.now(), strikes: 0 });
      } else if (offDurationSec >= interviewConfig.attentionSustainedSec) {
        flags.push(
          await raiseFlag(
            sessionId,
            FLAG_TYPES.FACE_ROTATION,
            FLAG_SEVERITY.HIGH,
            `Face stayed rotated away for ${Math.round(offDurationSec)}s (yaw=${Math.round(yaw)}° pitch=${Math.round(pitch)}°)`,
            { ...payload, yaw, pitch, off_duration_seconds: Number(offDurationSec.toFixed(1)) },
            12_000
          )
        );
        offAngleState.set(sessionId, { since: Date.now(), strikes: 0 });
      }
    } else {
      resetHeadStrike(sessionId);
      offAngleState.delete(sessionId);
    }

    // Tab/window focus loss is reported by the browser client via POST /suspicious — skip here to avoid double flags/scoring.
    // if (payload.tab_visible === false) { ... }
    // if (payload.window_blur === true) { ... }

    if (payload.mic_active === false) {
      flags.push(
        await raiseFlag(sessionId, FLAG_TYPES.MIC_MUTED, FLAG_SEVERITY.MEDIUM, 'Microphone muted or inactive', payload)
      );
    }

    if (payload.camera_active === false) {
      flags.push(
        await raiseFlag(sessionId, FLAG_TYPES.CAMERA_DISABLED, FLAG_SEVERITY.HIGH, 'Camera disabled during session', payload)
      );
    }

    if (payload.mobile_phone_detected === true || payload.phone_detected === true) {
      flags.push(
        await raiseFlag(
          sessionId,
          FLAG_TYPES.MOBILE_PHONE_DETECTED,
          FLAG_SEVERITY.HIGH,
          payload.phone_message || 'Mobile phone detected in camera frame',
          { ...payload, source: payload.source || 'phone_detector' },
          12_000
        )
      );
    }

    const obstructionConfidence = Number(payload.webcam_obstruction_confidence) || 0;
    const obstructionStreak = Number(payload.webcam_obstruction_streak) || 0;
    if (
      payload.webcam_obstruction_alert === true ||
      (obstructionConfidence >= interviewConfig.webcamObstructionMinConfidence &&
        obstructionStreak >= interviewConfig.webcamObstructionMinStreak)
    ) {
      flags.push(
        await raiseFlag(
          sessionId,
          FLAG_TYPES.WEBCAM_OBSTRUCTION,
          FLAG_SEVERITY.HIGH,
          payload.webcam_obstruction_message ||
            `Webcam obstruction detected (${Math.round(obstructionConfidence)}% confidence)`,
          { ...payload, source: payload.source || 'webcam_obstruction_detector' },
          15_000
        )
      );
    }

    return flags.filter(Boolean);
  },

  async evaluateIdentityMismatch(session, { mismatch = false, confidence = 0, distance = null, payload = {} } = {}) {
    if (!mismatch) {
      identityMismatchCounts.delete(session.id);
      return null;
    }
    const next = (identityMismatchCounts.get(session.id) || 0) + 1;
    identityMismatchCounts.set(session.id, next);
    // Require multiple consecutive mismatches to reduce false positives.
    if (next < 3) return null;
    return raiseFlag(
      session.id,
      FLAG_TYPES.IDENTITY_MISMATCH,
      FLAG_SEVERITY.HIGH,
      `Identity mismatch detected vs preflight face (confidence=${Number(confidence || 0).toFixed(2)})`,
      { ...payload, distance, confidence, mismatch_streak: next }
    );
  },

  async flagQuestionRepetition(
    session,
    { overlapRatio = 0, questionText = '', answerText = '', questionId = null, source = 'submit' } = {}
  ) {
    return raiseFlag(
      session.id,
      FLAG_TYPES.QUESTION_REPEATED,
      FLAG_SEVERITY.HIGH,
      `Candidate repeated interview question aloud (similarity ${(overlapRatio * 100).toFixed(0)}%)`,
      {
        overlap_ratio: Number(overlapRatio.toFixed(3)),
        question_id: questionId,
        source,
        question_excerpt: String(questionText || '').slice(0, 220),
        answer_excerpt: String(answerText || '').slice(0, 220),
      },
      12_000
    );
  },

  async evaluateQuestionRepetitionFromSpeech(session, { questionText, speechText, questionId } = {}) {
    const result = detectQuestionRepetition(questionText, speechText);
    if (!result.repeated) return null;
    return this.flagQuestionRepetition(session, {
      overlapRatio: result.overlapRatio,
      questionText,
      answerText: speechText,
      questionId,
      source: 'live_speech',
    });
  },

  async evaluateFaceAbsent(session, absentSeconds) {
    if (absentSeconds >= interviewConfig.faceAbsentSecondsThreshold) {
      return raiseFlag(
        session.id,
        FLAG_TYPES.FACE_ABSENT_DURATION,
        FLAG_SEVERITY.HIGH,
        `Face absent for ${Math.round(absentSeconds)}s`,
        { absentSeconds }
      );
    }
    return null;
  },

  async evaluateAttentionFlags(session, payload) {
    const descriptors = evaluateAttentionMetrics(session.id, payload);
    const flags = [];
    for (const d of descriptors) {
      flags.push(
        await raiseFlag(
          session.id,
          d.flagType,
          d.severity,
          d.message,
          d.payload,
          d.cooldownMs ?? 15_000
        )
      );
    }
    return flags.filter(Boolean);
  },

  noteFocusLossForAttention(sessionId) {
    noteFocusLossEvent(sessionId);
  },
};
