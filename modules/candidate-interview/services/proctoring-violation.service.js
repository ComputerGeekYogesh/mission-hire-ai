import { FLAG_TYPES, SESSION_STATUS } from '../constants.js';
import moment from 'moment-timezone';
import { interviewConfig } from '../config.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { verificationRepository } from '../repositories/verification.repository.js';
import { auditRepository } from '../repositories/audit.repository.js';
import { proctorDebug, proctorDebugFlow, proctorLog, proctorLogEscalationEmitted } from './proctoring-debug.service.js';
import { canonicalFlagType, activityDisplayName, proctorAudioKey } from '../lib/proctoring-flag-naming.js';
import {
  buildEscalationMessages,
  violationLabel,
} from '../lib/proctoring-violation-messages.js';
import { resolveSessionLabelsFromSession } from '../lib/session-labels.js';

/** Risk score per activity type (spec table + sensible defaults for related flags). */
export const VIOLATION_RISK_SCORES = Object.freeze({
  [FLAG_TYPES.TAB_SWITCH]: 3,
  [FLAG_TYPES.WINDOW_BLUR]: 3,
  [FLAG_TYPES.MOBILE_PHONE_DETECTED]: 5,
  [FLAG_TYPES.FACE_ABSENT_DURATION]: 4,
  [FLAG_TYPES.NO_FACE]: 4,
  [FLAG_TYPES.LEAVING_CAMERA_FRAME]: 4,
  [FLAG_TYPES.EXCESSIVE_EYE_MOVEMENT]: 3,
  [FLAG_TYPES.EXCESSIVE_HEAD_MOVEMENT]: 3,
  [FLAG_TYPES.FACE_ROTATION]: 3,
  [FLAG_TYPES.FACE_LOOKING_AWAY]: 3,
  [FLAG_TYPES.CAMERA_DISABLED]: 5,
  [FLAG_TYPES.MIC_MUTED]: 2,
  [FLAG_TYPES.HEADPHONES_REMOVED]: 3,
  [FLAG_TYPES.IDENTITY_MISMATCH]: 5,
  [FLAG_TYPES.QUESTION_REPEATED]: 3,
  [FLAG_TYPES.SUSPICIOUS_PATTERN]: 2,
  [FLAG_TYPES.DOWNWARD_GAZE]: 4,
  [FLAG_TYPES.OFF_SCREEN_GAZE]: 3,
  [FLAG_TYPES.READING_PATTERN_DETECTED]: 3,
  [FLAG_TYPES.LOW_SCREEN_ATTENTION]: 2,
  [FLAG_TYPES.PRE_ANSWER_DOWNWARD_GLANCE]: 3,
  [FLAG_TYPES.HIDDEN_DEVICE_ATTENTION]: 5,
  [FLAG_TYPES.ATTENTION_CORRELATION]: 4,
  [FLAG_TYPES.WEBCAM_OBSTRUCTION]: 4,
  [FLAG_TYPES.LIVENESS_FAILURE]: 5,
  [FLAG_TYPES.IDENTITY_DRIFT]: 5,
  [FLAG_TYPES.INTEGRITY_ANOMALY]: 4,
  [FLAG_TYPES.VOICE_COACHING]: 5,
  [FLAG_TYPES.VIRTUAL_CAMERA]: 5,
  [FLAG_TYPES.VERIFICATION_FAILED]: 4,
});

export const PROCTORING_ACTION = Object.freeze({
  NONE: 'none',
  WARNING: 'warning',
  FINAL_WARNING: 'final_warning',
  TERMINATE: 'terminate',
});

export const INTEGRITY_STATUS = Object.freeze({
  OK: 'ok',
  ELEVATED: 'elevated',
  WARNING: 'warning',
  CRITICAL: 'critical',
  TERMINATED: 'terminated',
});

const MAJOR_VIOLATION_MIN_SCORE = 3;

function parseMeta(session) {
  try {
    return typeof session.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session.metadata_json || {};
  } catch {
    return {};
  }
}

function defaultProctoringState() {
  return {
    risk_score: 0,
    effective_score: 0,
    warning_issued: false,
    warning_issued_at: null,
    warning_count: 0,
    major_strikes: 0,
    terminated: false,
    terminated_at: null,
    termination_reason: null,
    confidence_score: 100,
    violations: [],
  };
}

function getProctoringState(meta) {
  return { ...defaultProctoringState(), ...(meta.proctoring || {}) };
}

function violationScore(flagType) {
  const canonical = canonicalFlagType(flagType);
  return VIOLATION_RISK_SCORES[canonical] ?? VIOLATION_RISK_SCORES[flagType] ?? 2;
}

function computeEffectiveScore(violations, nowMs) {
  const cooldown = interviewConfig.proctoringMinorViolationCooldownMs;
  return violations.reduce((sum, v) => {
    const score = Number(v.score) || 0;
    if (score >= MAJOR_VIOLATION_MIN_SCORE) return sum + score;
    const age = nowMs - new Date(v.at).getTime();
    if (age <= cooldown) return sum + score;
    return sum;
  }, 0);
}

function computeConfidence(effectiveScore, warningIssued, terminated) {
  if (terminated) return 0;
  let confidence = 100 - effectiveScore * 4;
  if (warningIssued) confidence -= 10;
  return Math.max(0, Math.min(100, Math.round(confidence)));
}

function integrityStatusFrom(state) {
  if (state.terminated) return INTEGRITY_STATUS.TERMINATED;
  const count = state.warning_count || 0;
  const finalWarningStrike = interviewConfig.proctoringFinalWarningStrike;
  if (count >= finalWarningStrike) return INTEGRITY_STATUS.CRITICAL;
  if (count >= 1 || state.warning_issued) return INTEGRITY_STATUS.WARNING;
  const score = state.effective_score;
  if (score >= interviewConfig.proctoringWarnScore) return INTEGRITY_STATUS.ELEVATED;
  return INTEGRITY_STATUS.OK;
}

function buildClientPayload(state, action, triggerFlagType = null, labels = null) {
  const messages =
    triggerFlagType && action !== PROCTORING_ACTION.NONE
      ? buildEscalationMessages(triggerFlagType, action, labels)
      : null;

  return {
    risk_score: state.effective_score,
    raw_risk_score: state.risk_score,
    major_strikes: state.major_strikes || 0,
    warning_issued: state.warning_issued,
    warning_count: state.warning_count,
    integrity_status: integrityStatusFrom(state),
    confidence_score: state.confidence_score,
    action,
    terminate: action === PROCTORING_ACTION.TERMINATE,
    trigger_flag_type: triggerFlagType,
    banner_text: messages?.banner || null,
    audio_text: messages?.audio || null,
    violation_label: triggerFlagType ? violationLabel(triggerFlagType) : null,
    thresholds: {
      warn: interviewConfig.proctoringWarnScore,
      terminate: interviewConfig.proctoringTerminateScore,
      final_warning_strike: interviewConfig.proctoringFinalWarningStrike,
      termination_strike: interviewConfig.proctoringTerminationStrike,
    },
  };
}

const FOCUS_VIOLATION_TYPES = new Set([
  FLAG_TYPES.TAB_SWITCH,
  FLAG_TYPES.WINDOW_BLUR,
]);

const VIOLATION_DEDUPE_MS = 20_000;

/** Serialize per-session escalation to prevent blur/tab_switch race double-count or double-dedupe. */
const violationProcessLocks = new Map();

async function withSessionViolationLock(sessionId, fn) {
  const prev = violationProcessLocks.get(sessionId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chain = prev.then(() => gate);
  violationProcessLocks.set(sessionId, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (violationProcessLocks.get(sessionId) === chain) {
      violationProcessLocks.delete(sessionId);
    }
  }
}

function normalizeFocusViolationType(flagType) {
  const canonical = canonicalFlagType(flagType);
  if (FOCUS_VIOLATION_TYPES.has(canonical)) {
    return FLAG_TYPES.TAB_SWITCH;
  }
  return canonical;
}

/** Same incident reported by client + telemetry, or tab_switch + window_blur together. */
function isDuplicateViolation(violations, flagType, nowMs) {
  const dedupeMs = FOCUS_VIOLATION_TYPES.has(flagType)
    ? interviewConfig.focusViolationDedupeMs
    : VIOLATION_DEDUPE_MS;
  const recent = (violations || []).filter((v) => {
    const age = nowMs - new Date(v.at).getTime();
    return age >= 0 && age < dedupeMs;
  });
  if (recent.some((v) => v.type === flagType)) return true;
  if (FOCUS_VIOLATION_TYPES.has(flagType)) {
    return recent.some((v) => FOCUS_VIOLATION_TYPES.has(v.type));
  }
  return false;
}

async function persistProctoringState(sessionId, meta, proctoring) {
  const updated = { ...meta, proctoring };
  await sessionRepository.update(sessionId, { metadata_json: updated });
  return updated;
}

/** Lock session status when /end completes (not on termination strike — recording flush must stay open). */
async function persistSessionTerminatedStatus(session, meta, state) {
  const ended = moment().format('YYYY-MM-DD HH:mm:ss');
  let duration = null;
  if (session.started_at) {
    duration = moment(ended).diff(moment(session.started_at), 'seconds');
  }
  const updatedMeta = {
    ...meta,
    proctoring: state,
    termination_reason: 'terminated_due_to_proctoring_violation',
    assessment_status: 'terminated_due_to_proctoring_violation',
    termination_label: 'Terminated Due To Proctoring Violation',
  };
  await sessionRepository.update(session.id, {
    status: SESSION_STATUS.TERMINATED_PROCTORING,
    ended_at: ended,
    duration_seconds: duration,
    metadata_json: updatedMeta,
  });
  proctorDebug('session_status_terminated', {
    session_id: session.id,
    ended_at: ended,
    duration_seconds: duration,
  });
  return updatedMeta;
}

export const proctoringViolationService = {
  violationScore,

  getState(session) {
    const meta = parseMeta(session);
    const state = getProctoringState(meta);
    const nowMs = Date.now();
    state.effective_score = computeEffectiveScore(state.violations || [], nowMs);
    state.confidence_score = computeConfidence(
      state.effective_score,
      state.warning_issued,
      state.terminated
    );
    return { meta, state };
  },

  /**
   * Record a proctoring violation and evaluate warning / termination escalation.
   */
  async processViolation(session, flagType, options = {}) {
    if (!session?.id) return { action: PROCTORING_ACTION.NONE };
    return withSessionViolationLock(session.id, () =>
      this._processViolation(session, flagType, options)
    );
  },

  async _processViolation(session, flagType, {
    flagId = null,
    message = '',
    source = 'telemetry',
    payload = {},
  } = {}) {
    const rawCanonical = canonicalFlagType(flagType);
    const isFocusLoss = FOCUS_VIOLATION_TYPES.has(rawCanonical);
    const canonicalType = normalizeFocusViolationType(flagType);

    if (isFocusLoss) {
      proctorLog('Window focus lost', {
        session_id: session.id,
        candidate_id: session.candidate_id ?? session.id,
        detail: `source=${source}, normalized=${proctorAudioKey(canonicalType)}`,
      });
    }

    const fresh = await sessionRepository.findById(session.id);
    if (!fresh) return { action: PROCTORING_ACTION.NONE };

    const sessionLabels = resolveSessionLabelsFromSession(fresh);
    const { meta, state } = this.getState(fresh);
    if (state.terminated || fresh.status === SESSION_STATUS.FAILED || fresh.status === SESSION_STATUS.TERMINATED_PROCTORING) {
      proctorDebug('violation_ignored_already_terminated', {
        session_id: session.id,
        flag_type: flagType,
        source,
      });
      return { action: PROCTORING_ACTION.NONE, proctoring: buildClientPayload(state, PROCTORING_ACTION.NONE) };
    }

    const nowMs = Date.now();
    if (isDuplicateViolation(state.violations, canonicalType, nowMs)) {
      proctorLog('Focus loss coalesced (duplicate within dedupe window)', {
        session_id: session.id,
        flag_type: canonicalType,
        detail: `Activity: ${proctorAudioKey(canonicalType)}`,
      });
      proctorDebugFlow('deduped', {
        session_id: session.id,
        flag_type: canonicalType,
        raw_flag_type: flagType,
        source,
        flag_id: flagId,
      });
      return {
        action: PROCTORING_ACTION.NONE,
        proctoring: buildClientPayload(state, PROCTORING_ACTION.NONE),
        deduped: true,
      };
    }

    const score = violationScore(canonicalType);
    const isMajor = score >= MAJOR_VIOLATION_MIN_SCORE;
    const entry = {
      type: canonicalType,
      score,
      at: new Date().toISOString(),
      flag_id: flagId,
      message: String(message || '').slice(0, 500),
      violation_label: violationLabel(canonicalType),
      source,
      major: isMajor,
    };

    state.violations = [...(state.violations || []), entry];
    state.risk_score = (state.risk_score || 0) + score;
    state.effective_score = computeEffectiveScore(state.violations, nowMs);
    if (isMajor) {
      state.major_strikes = (state.major_strikes || 0) + 1;
    }
    state.confidence_score = computeConfidence(
      state.effective_score,
      state.warning_issued,
      state.terminated
    );

    proctorDebugFlow('risk_score_updated', {
      session_id: session.id,
      flag_type: canonicalType,
      raw_flag_type: flagType,
      flag_id: flagId,
      source,
      score_added: score,
      is_major: isMajor,
      major_strikes: state.major_strikes,
      effective_score: state.effective_score,
      raw_risk_score: state.risk_score,
      warning_issued: state.warning_issued,
    });

    let action = PROCTORING_ACTION.NONE;
    let triggerFlagType = null;
    const violationCount = state.violations.length;

    state.warning_count = (state.warning_count || 0) + 1;
    const strikeNumber = state.warning_count;

    if (isFocusLoss) {
      proctorLog('Tab switch violation created', {
        session_id: session.id,
        flag_type: canonicalType,
        flag_id: flagId,
      });
      proctorLog('Warning count updated', {
        session_id: session.id,
        warning_count: strikeNumber,
      });
    }

    const finalWarningStrike = interviewConfig.proctoringFinalWarningStrike;
    const terminationStrike = interviewConfig.proctoringTerminationStrike;

    if (strikeNumber >= terminationStrike) {
      action = PROCTORING_ACTION.TERMINATE;
      triggerFlagType = canonicalType;
      state.terminated = true;
      state.terminated_at = new Date().toISOString();
      state.termination_reason = 'terminated_due_to_proctoring_violation';
      state.confidence_score = 0;

      proctorDebugFlow('termination_strike', {
        session_id: session.id,
        violation_count: violationCount,
        warning_count: strikeNumber,
        termination_strike: terminationStrike,
        triggering_flag_type: canonicalType,
        activity_label: violationLabel(canonicalType),
        flag_id: flagId,
        prior_violation_types: state.violations.slice(0, -1).map((v) => v.type),
      });

      await verificationRepository.log({
        session_id: session.id,
        event_type: 'proctoring_terminated',
        success: true,
        details_json: {
          violation_count: violationCount,
          warning_count: strikeNumber,
          flag_type: canonicalType,
          flag_id: flagId,
          activity_label: violationLabel(canonicalType),
          violations_count: state.violations.length,
        },
      });
    } else if (strikeNumber === finalWarningStrike) {
      action = PROCTORING_ACTION.FINAL_WARNING;
      triggerFlagType = canonicalType;
      state.warning_issued = true;

      proctorDebugFlow('final_warning_strike', {
        session_id: session.id,
        violation_count: violationCount,
        warning_count: strikeNumber,
        final_warning_strike: finalWarningStrike,
        flag_type: canonicalType,
        activity_label: violationLabel(canonicalType),
        flag_id: flagId,
      });

      await verificationRepository.log({
        session_id: session.id,
        event_type: 'proctoring_final_warning',
        success: true,
        details_json: {
          violation_count: violationCount,
          warning_count: strikeNumber,
          flag_type: canonicalType,
          flag_id: flagId,
          activity_label: violationLabel(canonicalType),
          banner: buildEscalationMessages(canonicalType, PROCTORING_ACTION.FINAL_WARNING, sessionLabels).banner,
        },
      });
    } else {
      action = PROCTORING_ACTION.WARNING;
      triggerFlagType = canonicalType;
      state.warning_issued = true;
      state.warning_issued_at = new Date().toISOString();

      proctorDebugFlow('warning_strike', {
        session_id: session.id,
        violation_count: violationCount,
        warning_count: strikeNumber,
        flag_type: canonicalType,
        activity_label: violationLabel(canonicalType),
        flag_id: flagId,
      });

      await verificationRepository.log({
        session_id: session.id,
        event_type: 'proctoring_warning',
        success: true,
        details_json: {
          violation_count: violationCount,
          warning_count: strikeNumber,
          flag_type: canonicalType,
          flag_id: flagId,
          activity_label: violationLabel(canonicalType),
          banner: buildEscalationMessages(canonicalType, PROCTORING_ACTION.WARNING, sessionLabels).banner,
        },
      });
    }

    await persistProctoringState(session.id, meta, state);

    const clientPayload = buildClientPayload(state, action, triggerFlagType, sessionLabels);
    if (action !== PROCTORING_ACTION.NONE) {
      proctorLogEscalationEmitted(fresh, canonicalType, action, clientPayload);
      if (isFocusLoss) {
        proctorLog('Warning event emitted', {
          session_id: session.id,
          action,
          warning_count: clientPayload.warning_count,
        });
      }
    }
    proctorDebugFlow('escalation_result', {
      session_id: session.id,
      flag_type: canonicalType,
      activity_label: activityDisplayName(canonicalType),
      action,
      violation_count: violationCount,
      warning_issued: state.warning_issued,
      integrity_status: clientPayload.integrity_status,
      confidence_score: clientPayload.confidence_score,
      effective_score: clientPayload.effective_score ?? clientPayload.risk_score,
    });

    return {
      action,
      proctoring: clientPayload,
      trigger_flag_type: triggerFlagType,
      state,
    };
  },

  async terminateSession(session, { reason = 'proctoring_violation', flagType = null } = {}) {
    const fresh = await sessionRepository.findById(session.id);
    if (!fresh) return null;

    const { meta, state } = this.getState(fresh);
    state.terminated = true;
    state.terminated_at = new Date().toISOString();
    state.termination_reason = reason;
    state.confidence_score = 0;

    await persistProctoringState(session.id, meta, state);

    proctorDebug('session_marked_terminated', {
      session_id: session.id,
      reason,
      flag_type: flagType,
      effective_score: state.effective_score,
    });

    await auditRepository.log({
      session_id: session.id,
      actor_type: 'system',
      action: 'proctoring_termination',
      details_json: {
        reason,
        flag_type: flagType,
        effective_score: state.effective_score,
        warning_issued: state.warning_issued,
        violations_count: (state.violations || []).length,
      },
    });

    return state;
  },

  buildReport(session) {
    const { state } = this.getState(session);
    return {
      risk_score: state.effective_score,
      raw_risk_score: state.risk_score,
      warning_count: state.warning_count,
      warning_issued: state.warning_issued,
      terminated: state.terminated,
      confidence_score: state.confidence_score,
      integrity_status: integrityStatusFrom(state),
      violations: state.violations || [],
      timeline: (state.violations || []).map((v) => ({
        type: v.type,
        label: violationLabel(v.type),
        score: v.score,
        at: v.at,
        message: v.message,
      })),
    };
  },

  isDuplicateFocusViolation(session) {
    const { state } = this.getState(session);
    return isDuplicateViolation(state.violations, FLAG_TYPES.TAB_SWITCH, Date.now());
  },

  getClientSnapshot(session, action = PROCTORING_ACTION.NONE, triggerFlagType = null) {
    const { state } = this.getState(session);
    const sessionLabels = resolveSessionLabelsFromSession(session);
    return buildClientPayload(state, action, triggerFlagType, sessionLabels);
  },
};
