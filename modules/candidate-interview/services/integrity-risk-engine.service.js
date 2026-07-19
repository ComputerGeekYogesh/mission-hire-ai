import { FLAG_TYPES } from '../constants.js';
import { interviewConfig } from '../config.js';
import { integrityAuditService, integrityLog, integrityDebug } from './integrity-audit.service.js';

export const INTEGRITY_RISK_LEVEL = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

/** Weighted contribution per signal sub-type (confidence scales 0–100). */
const SIGNAL_WEIGHTS = Object.freeze({
  frozen_frame: 3,
  static_image: 4,
  looped_video: 5,
  pre_recorded: 5,
  camera_replacement: 5,
  no_blink: 2,
  no_micro_motion: 2,
  motionless: 3,
  artificial_face: 4,
  lip_sync_mismatch: 4,
  identity_drift: 5,
  face_change: 5,
  multiple_identities: 5,
  face_occlusion_bypass: 4,
  heartbeat_miss: 3,
  camera_interrupt: 4,
  mic_interrupt: 3,
  recording_gap: 4,
  stream_tamper: 5,
  focus_loss: 2,
  network_interrupt: 2,
  frame_stall: 3,
  virtual_camera: 6,
  synthetic_feed: 6,
  voice_coaching: 5,
  secondary_voice: 5,
  whisper_coaching: 4,
  verification_mismatch: 4,
  repeat_question_abuse: 3,
  existing_violation: 2,
});

const SIGNAL_TO_FLAG = Object.freeze({
  frozen_frame: FLAG_TYPES.LIVENESS_FAILURE,
  static_image: FLAG_TYPES.LIVENESS_FAILURE,
  looped_video: FLAG_TYPES.LIVENESS_FAILURE,
  pre_recorded: FLAG_TYPES.LIVENESS_FAILURE,
  camera_replacement: FLAG_TYPES.LIVENESS_FAILURE,
  no_blink: FLAG_TYPES.LIVENESS_FAILURE,
  no_micro_motion: FLAG_TYPES.LIVENESS_FAILURE,
  motionless: FLAG_TYPES.LIVENESS_FAILURE,
  artificial_face: FLAG_TYPES.LIVENESS_FAILURE,
  lip_sync_mismatch: FLAG_TYPES.LIVENESS_FAILURE,
  identity_drift: FLAG_TYPES.IDENTITY_DRIFT,
  face_change: FLAG_TYPES.IDENTITY_DRIFT,
  multiple_identities: FLAG_TYPES.IDENTITY_DRIFT,
  face_occlusion_bypass: FLAG_TYPES.IDENTITY_DRIFT,
  heartbeat_miss: FLAG_TYPES.INTEGRITY_ANOMALY,
  camera_interrupt: FLAG_TYPES.INTEGRITY_ANOMALY,
  mic_interrupt: FLAG_TYPES.INTEGRITY_ANOMALY,
  recording_gap: FLAG_TYPES.INTEGRITY_ANOMALY,
  stream_tamper: FLAG_TYPES.INTEGRITY_ANOMALY,
  focus_loss: FLAG_TYPES.INTEGRITY_ANOMALY,
  network_interrupt: FLAG_TYPES.INTEGRITY_ANOMALY,
  frame_stall: FLAG_TYPES.INTEGRITY_ANOMALY,
  virtual_camera: FLAG_TYPES.VIRTUAL_CAMERA,
  synthetic_feed: FLAG_TYPES.VIRTUAL_CAMERA,
  voice_coaching: FLAG_TYPES.VOICE_COACHING,
  secondary_voice: FLAG_TYPES.VOICE_COACHING,
  whisper_coaching: FLAG_TYPES.VOICE_COACHING,
  verification_mismatch: FLAG_TYPES.VERIFICATION_FAILED,
  repeat_question_abuse: FLAG_TYPES.VERIFICATION_FAILED,
});

const LIVENESS_SUB_TYPES = new Set(
  Object.entries(SIGNAL_TO_FLAG)
    .filter(([, flagType]) => flagType === FLAG_TYPES.LIVENESS_FAILURE)
    .map(([subType]) => subType)
);

function isLivenessSubType(subType) {
  return LIVENESS_SUB_TYPES.has(subType);
}

function noopLivenessEvaluation(integrity, subType) {
  return {
    shouldEscalate: false,
    flagType: SIGNAL_TO_FLAG[subType] || FLAG_TYPES.LIVENESS_FAILURE,
    subType,
    confidence: 0,
    streak: 0,
    streakRequired: 0,
    integrityScore: integrity.integrity_score || 0,
    riskLevel: integrity.risk_level || INTEGRITY_RISK_LEVEL.LOW,
    message: '',
    stateUpdates: {},
    critical: false,
    disabled: true,
  };
}

const STREAK_REQUIRED = Object.freeze({
  frozen_frame: 4,
  static_image: 4,
  looped_video: 3,
  pre_recorded: 3,
  no_blink: 5,
  no_micro_motion: 5,
  motionless: 4,
  identity_drift: 3,
  face_change: 3,
  heartbeat_miss: 3,
  virtual_camera: 1,
  synthetic_feed: 1,
  voice_coaching: 4,
  secondary_voice: 4,
  verification_mismatch: 2,
});

function defaultIntegrityState() {
  return {
    integrity_score: 0,
    risk_level: INTEGRITY_RISK_LEVEL.LOW,
    hiring_risk_level: 'LOW',
    last_heartbeat_at: null,
    heartbeat_misses: 0,
    consecutive_heartbeat_misses: 0,
    identity_confidence: 100,
    liveness_confidence: 100,
    signals: [],
    streaks: {},
    escalated_at: {},
    audit_event_count: 0,
    verification_challenge_active: false,
  };
}

function riskLevelFromScore(score) {
  if (score >= interviewConfig.integrityCriticalScore) return INTEGRITY_RISK_LEVEL.CRITICAL;
  if (score >= interviewConfig.integrityEscalationScore) return INTEGRITY_RISK_LEVEL.HIGH;
  if (score >= 8) return INTEGRITY_RISK_LEVEL.MEDIUM;
  return INTEGRITY_RISK_LEVEL.LOW;
}

function hiringRiskFromLevel(level, proctoringScore = 0) {
  if (level === INTEGRITY_RISK_LEVEL.CRITICAL || proctoringScore >= interviewConfig.proctoringTerminateScore) {
    return 'HIGH';
  }
  if (level === INTEGRITY_RISK_LEVEL.HIGH || proctoringScore >= interviewConfig.proctoringWarnScore) {
    return 'MEDIUM';
  }
  if (level === INTEGRITY_RISK_LEVEL.MEDIUM) return 'LOW_MEDIUM';
  return 'LOW';
}

function pruneSignals(signals, nowMs) {
  const windowMs = interviewConfig.integritySilentSignalWindowMs;
  return (signals || []).filter((s) => nowMs - new Date(s.at).getTime() <= windowMs);
}

function computeScore(signals) {
  return signals.reduce((sum, s) => sum + (Number(s.risk_contribution) || 0), 0);
}

function minConfidenceFor(subType) {
  if (subType === 'virtual_camera' || subType === 'synthetic_feed') {
    return interviewConfig.virtualCameraMinConfidence;
  }
  if (subType.startsWith('identity') || subType === 'face_change') {
    return interviewConfig.identityDriftMinConfidence;
  }
  if (subType.includes('voice') || subType === 'secondary_voice' || subType === 'whisper_coaching') {
    return interviewConfig.voiceCoachingMinConfidence;
  }
  return interviewConfig.livenessMinConfidence;
}

export const integrityRiskEngine = {
  SIGNAL_WEIGHTS,
  SIGNAL_TO_FLAG,

  getState(meta) {
    return { ...defaultIntegrityState(), ...(meta?.integrity || {}) };
  },

  /**
   * Record a silent or escalated integrity signal. Returns updated meta + evaluation.
   */
  recordSignal(meta, {
    eventType = 'integrity_signal',
    subType,
    confidence = 0,
    sessionState = null,
    screenshotRef = null,
    audioRef = null,
    payload = {},
    silent = true,
  } = {}) {
    if (!interviewConfig.livenessDetectionEnabled && isLivenessSubType(subType)) {
      const integrity = this.getState(meta);
      return {
        meta: { ...meta, integrity },
        integrity,
        evaluation: noopLivenessEvaluation(integrity, subType),
      };
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const weight = SIGNAL_WEIGHTS[subType] ?? 2;
    const conf = Math.max(0, Math.min(100, Number(confidence) || 0));
    const riskContribution = Number((weight * (conf / 100)).toFixed(2));

    let integrity = this.getState(meta);
    const streaks = { ...(integrity.streaks || {}) };
    if (conf >= minConfidenceFor(subType)) {
      streaks[subType] = (streaks[subType] || 0) + 1;
    } else if (conf < minConfidenceFor(subType) * 0.5) {
      streaks[subType] = 0;
    }

    const signalEntry = {
      at: nowIso,
      sub_type: subType,
      confidence: conf,
      risk_contribution: riskContribution,
      silent,
    };
    integrity.signals = pruneSignals([...(integrity.signals || []), signalEntry], nowMs);
    integrity.integrity_score = computeScore(integrity.signals);
    integrity.risk_level = riskLevelFromScore(integrity.integrity_score);

    if (subType.includes('identity') || subType === 'face_change') {
      integrity.identity_confidence = Math.max(0, Math.round(100 - integrity.integrity_score * 2.5));
    }
    if (
      subType.includes('frozen') ||
      subType.includes('blink') ||
      subType.includes('motion') ||
      subType.includes('liveness') ||
      subType === 'static_image' ||
      subType === 'looped_video'
    ) {
      integrity.liveness_confidence = Math.max(0, Math.round(100 - integrity.integrity_score * 2));
    }

    integrity.streaks = streaks;

    let updatedMeta = integrityAuditService.appendEvent(meta, {
      event_type: eventType,
      sub_type: subType,
      confidence: conf,
      risk_contribution: riskContribution,
      risk_level: integrity.risk_level,
      session_state: sessionState,
      screenshot_ref: screenshotRef,
      audio_ref: audioRef,
      escalated: false,
      payload,
    });
    updatedMeta.integrity = integrity;

    integrityLog(`Signal recorded: ${subType}`, {
      session_id: payload.session_id,
      event_type: subType,
      confidence: conf,
      risk_contribution: riskContribution,
      integrity_score: integrity.integrity_score,
      risk_level: integrity.risk_level,
      detail: silent ? 'silent monitoring' : 'direct report',
    });

    const evaluation = this.evaluateEscalation(integrity, subType, conf);
    updatedMeta.integrity = { ...integrity, ...evaluation.stateUpdates };
    updatedMeta.integrity.hiring_risk_level = hiringRiskFromLevel(
      updatedMeta.integrity.risk_level,
      meta?.proctoring?.effective_score || 0
    );

    integrityDebug('signal_recorded', {
      sub_type: subType,
      confidence: conf,
      risk_contribution: riskContribution,
      integrity_score: updatedMeta.integrity.integrity_score,
      risk_level: updatedMeta.integrity.risk_level,
      should_escalate: evaluation.shouldEscalate,
      flag_type: evaluation.flagType,
    });

    return { meta: updatedMeta, integrity: updatedMeta.integrity, evaluation };
  },

  evaluateEscalation(integrity, subType, confidence) {
    if (!interviewConfig.livenessDetectionEnabled && isLivenessSubType(subType)) {
      return noopLivenessEvaluation(integrity, subType);
    }

    const streakRequired =
      STREAK_REQUIRED[subType] ??
      (subType.includes('identity') ? interviewConfig.identityDriftStreakRequired : interviewConfig.livenessStreakRequired);
    const streak = integrity.streaks?.[subType] || 0;
    const flagType = SIGNAL_TO_FLAG[subType] || FLAG_TYPES.INTEGRITY_ANOMALY;
    const score = integrity.integrity_score || 0;
    const minConf = minConfidenceFor(subType);

    const isCriticalImmediate =
      (subType === 'virtual_camera' || subType === 'synthetic_feed') &&
      confidence >= interviewConfig.virtualCameraMinConfidence;

    const streakMet = streak >= streakRequired && confidence >= minConf;
    const scoreMet = score >= interviewConfig.integrityEscalationScore && streak >= Math.max(2, streakRequired - 1);

    const shouldEscalate = isCriticalImmediate || streakMet || scoreMet;

    const stateUpdates = {};
    if (score >= interviewConfig.integrityEscalationScore) {
      stateUpdates.verification_challenge_active = true;
    }

    return {
      shouldEscalate,
      flagType,
      subType,
      confidence,
      streak,
      streakRequired,
      integrityScore: score,
      riskLevel: integrity.risk_level,
      message: this.buildEscalationMessage(subType, confidence, streak),
      stateUpdates,
      critical: isCriticalImmediate,
    };
  },

  buildEscalationMessage(subType, confidence, streak) {
    const labels = {
      frozen_frame: 'Frozen or static video feed detected',
      static_image: 'Static image presented to webcam',
      looped_video: 'Looping video feed detected',
      pre_recorded: 'Pre-recorded video playback suspected',
      no_blink: 'Natural blink pattern absent for extended period',
      motionless: 'Candidate unnaturally motionless on camera',
      identity_drift: 'Identity continuity could not be verified',
      face_change: 'Face change detected during interview',
      heartbeat_miss: 'Integrity heartbeat missed',
      virtual_camera: 'Virtual camera source detected',
      voice_coaching: 'External voice or coaching detected',
      verification_mismatch: 'Verification response inconsistent with prior answers',
      repeat_question_abuse: 'Excessive question repetition pattern',
    };
    const base = labels[subType] || `Integrity anomaly: ${subType}`;
    return `${base} (confidence ${Math.round(confidence)}%, streak ${streak})`;
  },

  recordHeartbeat(meta, { receivedAtMs = Date.now(), expectedIntervalMs = interviewConfig.integrityHeartbeatIntervalMs } = {}) {
    const integrity = this.getState(meta);
    const lastAt = integrity.last_heartbeat_at ? new Date(integrity.last_heartbeat_at).getTime() : null;
    let consecutive = 0;

    if (lastAt && receivedAtMs - lastAt > expectedIntervalMs * 2.5) {
      const missed = Math.floor((receivedAtMs - lastAt) / expectedIntervalMs) - 1;
      consecutive = (integrity.consecutive_heartbeat_misses || 0) + Math.max(1, missed);
      integrity.heartbeat_misses = (integrity.heartbeat_misses || 0) + Math.max(1, missed);
      integrity.consecutive_heartbeat_misses = consecutive;
    } else {
      integrity.consecutive_heartbeat_misses = 0;
    }

    integrity.last_heartbeat_at = new Date(receivedAtMs).toISOString();
    return { ...meta, integrity };
  },

  buildEnterpriseReport(session, meta) {
    const integrity = this.getState(meta);
    const proctoring = meta?.proctoring || {};
    return {
      integrity_score: integrity.integrity_score,
      risk_level: integrity.risk_level,
      hiring_risk_level: integrity.hiring_risk_level || hiringRiskFromLevel(integrity.risk_level, proctoring.effective_score),
      identity_confidence: integrity.identity_confidence,
      liveness_confidence: integrity.liveness_confidence,
      heartbeat_misses: integrity.heartbeat_misses || 0,
      verification_challenge_active: integrity.verification_challenge_active === true,
      timeline: integrityAuditService.buildTimeline(meta),
      suspicious_summary: integrityAuditService.buildSuspiciousSummary(meta),
      proctoring_risk_score: proctoring.effective_score ?? proctoring.risk_score ?? 0,
      recommended_action: integrity.risk_level === INTEGRITY_RISK_LEVEL.CRITICAL ? 'REVIEW_REQUIRED' : 'STANDARD_REVIEW',
    };
  },
};
