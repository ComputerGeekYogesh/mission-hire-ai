import { FLAG_TYPES, FLAG_SEVERITY } from '../constants.js';
import { interviewConfig } from '../config.js';
import { proctorDebug } from './proctoring-debug.service.js';

/** Per-session rolling attention + correlation state. */
const sessionAttention = new Map();

function getState(sessionId) {
  if (!sessionAttention.has(sessionId)) {
    sessionAttention.set(sessionId, {
      recentAttentionFlags: [],
      lastTabOrBlurAt: null,
      firedRules: new Map(),
      ruleStrikes: new Map(),
    });
  }
  return sessionAttention.get(sessionId);
}

function pushRecentFlag(state, flagType) {
  const now = Date.now();
  state.recentAttentionFlags.push({ type: flagType, at: now });
  state.recentAttentionFlags = state.recentAttentionFlags.filter(
    (f) => now - f.at < interviewConfig.attentionCorrelationWindowMs
  );
}

function hadRecentFlag(state, flagType, withinMs) {
  const now = Date.now();
  return state.recentAttentionFlags.some(
    (f) => f.type === flagType && now - f.at <= withinMs
  );
}

function ruleCooldown(state, ruleKey, cooldownMs) {
  const last = state.firedRules.get(ruleKey);
  if (last && Date.now() - last < cooldownMs) return false;
  state.firedRules.set(ruleKey, Date.now());
  return true;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Increment strike counter while condition holds; reset when it clears. */
function tickRuleStrike(state, ruleKey, conditionMet, requiredStrikes) {
  const prev = state.ruleStrikes.get(ruleKey) || 0;
  if (conditionMet) {
    const next = prev + 1;
    state.ruleStrikes.set(ruleKey, next);
    return next >= requiredStrikes;
  }
  state.ruleStrikes.set(ruleKey, 0);
  return false;
}

function computeRuleConfidence(payload, ruleKey, cfg) {
  const sustained = cfg.attentionSustainedSec;
  const gazeOffSec = num(payload.gaze_off_screen_seconds);
  const gazeDownSec = num(payload.gaze_down_seconds);
  const gazeFixedSec = num(payload.gaze_fixed_off_seconds);
  const headOffSec = num(payload.head_off_screen_seconds);
  const headDownSec = num(payload.head_down_seconds);
  const combinedDownSec = num(payload.combined_down_seconds);
  const gazeOffPct = num(payload.gaze_off_screen_pct_10s);
  const headOffPct = num(payload.head_off_screen_pct_10s);
  const answerGazeOffPct = num(payload.answer_gaze_off_pct);
  const answerHeadOffPct = num(payload.answer_head_off_pct);
  const gazeMoves = num(payload.gaze_moves_10s);
  const headTurns = num(payload.head_turns_10s);
  const preSpeechCount = num(payload.pre_speech_glance_count);

  const sustainedBoost = (seconds) =>
    Math.min(45, Math.max(0, (seconds - sustained) * 10));

  switch (ruleKey) {
    case 'gaze_off_sustained':
      return Math.min(100, 55 + sustainedBoost(gazeOffSec));
    case 'gaze_fixed_off':
      return Math.min(100, 58 + sustainedBoost(gazeFixedSec));
    case 'gaze_down_sustained':
      return Math.min(100, 58 + sustainedBoost(gazeDownSec));
    case 'head_off_sustained':
      return Math.min(100, 55 + sustainedBoost(headOffSec));
    case 'head_down_while_answering':
      return Math.min(100, 60 + sustainedBoost(headDownSec));
    case 'combined_down_sustained':
      return Math.min(100, 65 + sustainedBoost(combinedDownSec));
    case 'head_and_gaze_off':
      return Math.min(100, 68 + sustainedBoost(Math.min(gazeOffSec, headOffSec)));
    case 'gaze_off_pct_10s':
      return Math.min(100, 50 + (gazeOffPct - cfg.attentionGazeOffScreenPct) * 1.2);
    case 'gaze_moves_10s':
      return Math.min(
        100,
        45 +
          (gazeMoves - cfg.attentionGazeMovesMax) * 4 +
          (gazeOffPct > 55 ? 18 : 0) +
          sustainedBoost(gazeOffSec)
      );
    case 'head_turns_10s':
      return Math.min(
        100,
        45 +
          (headTurns - cfg.attentionHeadTurnsMax) * 4 +
          (headOffPct > 45 ? 15 : 0) +
          sustainedBoost(headOffSec)
      );
    case 'gaze_scanning_answer':
    case 'head_scanning_answer':
      return 72;
    case 'gaze_and_head_moves':
      return Math.min(
        100,
        70 +
          (gazeMoves - cfg.attentionGazeMovesMax) * 2 +
          (headTurns - cfg.attentionHeadTurnsMax) * 2
      );
    case 'head_off_answer_pct':
      return Math.min(100, 55 + (answerHeadOffPct - cfg.attentionHeadOffScreenPct) * 1.1);
    case 'answer_more_away_than_screen':
      return Math.min(100, 58 + (answerGazeOffPct - cfg.attentionAnswerGazeOffPct) * 1.1);
    case 'pre_speech_pattern':
      return Math.min(100, 60 + (preSpeechCount - cfg.attentionPreSpeechGlanceCount) * 8);
    case 'focus_loss_with_attention':
      return 75;
    default:
      return 70;
  }
}

function addFlag(flags, state, { ruleKey, flagType, severity, message, cooldownMs, payload }) {
  if (!ruleCooldown(state, ruleKey, cooldownMs)) return;
  flags.push({ flagType, severity, message, cooldownMs, payload });
  pushRecentFlag(state, flagType);
  state.ruleStrikes.set(ruleKey, 0);
}

/**
 * Require consecutive telemetry ticks + confidence score before raising a flag.
 */
function addFlagIfConfirmed(flags, state, cfg, {
  ruleKey,
  conditionMet,
  flagType,
  severity,
  message,
  cooldownMs,
  payload,
  confidence = null,
}) {
  const strikesRequired = cfg.attentionConsecutiveTicks;
  const confThreshold = cfg.attentionConfidenceThreshold;

  if (!conditionMet) {
    tickRuleStrike(state, ruleKey, false, strikesRequired);
    return;
  }

  const conf = confidence ?? computeRuleConfidence(payload, ruleKey, cfg);
  if (!tickRuleStrike(state, ruleKey, true, strikesRequired)) return;
  if (conf < confThreshold) {
    state.ruleStrikes.set(ruleKey, 0);
    return;
  }

  addFlag(flags, state, {
    ruleKey,
    flagType,
    severity,
    message,
    cooldownMs,
    payload: { ...payload, rule: ruleKey, attention_confidence: Math.round(conf) },
  });
}

/**
 * Evaluate attention telemetry; returns flag descriptors for suspicious.service raiseFlag.
 */
export function evaluateAttentionMetrics(sessionId, payload) {
  const flags = [];
  const state = getState(sessionId);
  const cfg = interviewConfig;

  const sampleCount = num(payload.attention_sample_count);
  const minSamples = cfg.attentionMinSamples;
  const sustainedSec = cfg.attentionSustainedSec;
  const hasEnoughSamples = sampleCount >= minSamples;

  const gazeOffSec = num(payload.gaze_off_screen_seconds);
  const gazeDownSec = num(payload.gaze_down_seconds);
  const gazeFixedSec = num(payload.gaze_fixed_off_seconds);
  const headOffSec = num(payload.head_off_screen_seconds);
  const headDownSec = num(payload.head_down_seconds);
  const combinedDownSec = num(payload.combined_down_seconds);
  const gazeMoves10s = num(payload.gaze_moves_10s);
  const headTurns10s = num(payload.head_turns_10s);
  const gazeOffPct10s = num(payload.gaze_off_screen_pct_10s);
  const headOffPct10s = num(payload.head_off_screen_pct_10s);
  const gazeScanning = payload.gaze_scanning_10s === true;
  const headScanning = payload.head_scanning_10s === true;
  const answerActive = payload.answer_phase_active === true;
  const answerGazeOffPct = num(payload.answer_gaze_off_pct);
  const answerHeadOffPct = num(payload.answer_head_off_pct);
  const preSpeechCount = num(payload.pre_speech_glance_count);

  proctorDebug('attention_sample', {
    session_id: sessionId,
    samples: sampleCount,
    gaze_off_sec: gazeOffSec,
    gaze_down_sec: gazeDownSec,
    head_off_sec: headOffSec,
    head_down_sec: headDownSec,
    combined_down_sec: combinedDownSec,
    gaze_moves_10s: gazeMoves10s,
    head_turns_10s: headTurns10s,
    gaze_off_pct_10s: gazeOffPct10s,
    head_off_pct_10s: headOffPct10s,
    answer_active: answerActive,
    answer_gaze_off_pct: answerGazeOffPct,
  });

  if (!hasEnoughSamples) {
    return flags;
  }

  const repeatedOffScreenGaze =
    gazeMoves10s > cfg.attentionGazeMovesMax &&
    (gazeOffSec >= sustainedSec || gazeOffPct10s > 55 || gazeScanning);
  const repeatedHeadTurns =
    headTurns10s > cfg.attentionHeadTurnsMax &&
    (headOffSec >= sustainedSec || headOffPct10s > 45 || headScanning);

  // ── Eye gaze rules ─────────────────────────────────────────────────────────

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'gaze_off_sustained',
    conditionMet: gazeOffSec >= sustainedSec,
    flagType: FLAG_TYPES.OFF_SCREEN_GAZE,
    severity: FLAG_SEVERITY.HIGH,
    message: `Eyes not focused on screen/webcam for ${gazeOffSec.toFixed(1)}s`,
    cooldownMs: 20_000,
    payload: { ...payload, gaze_off_screen_seconds: gazeOffSec },
  });

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'gaze_fixed_off',
    conditionMet:
      gazeFixedSec >= sustainedSec &&
      payload.gaze_fixed_zone &&
      payload.gaze_fixed_zone !== 'screen',
    flagType: FLAG_TYPES.OFF_SCREEN_GAZE,
    severity: FLAG_SEVERITY.HIGH,
    message: `Gaze fixed off-screen (${String(payload.gaze_fixed_zone).replace(/_/g, ' ')}) for ${gazeFixedSec.toFixed(1)}s`,
    cooldownMs: 20_000,
    payload: { ...payload, gaze_fixed_off_seconds: gazeFixedSec },
  });

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'gaze_moves_10s',
    conditionMet: repeatedOffScreenGaze,
    flagType: FLAG_TYPES.EXCESSIVE_EYE_MOVEMENT,
    severity: FLAG_SEVERITY.MEDIUM,
    message: `Repeated off-screen eye movement (${gazeMoves10s} shifts in ${cfg.attentionWindowSec}s)`,
    cooldownMs: 18_000,
    payload: { ...payload, gaze_moves_10s: gazeMoves10s },
  });

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'gaze_off_pct_10s',
    conditionMet: gazeOffPct10s > cfg.attentionGazeOffScreenPct && gazeOffSec >= sustainedSec * 0.6,
    flagType: FLAG_TYPES.LOW_SCREEN_ATTENTION,
    severity: FLAG_SEVERITY.MEDIUM,
    message: `${gazeOffPct10s}% of gaze samples off-screen in last ${cfg.attentionWindowSec}s`,
    cooldownMs: 22_000,
    payload: { ...payload, gaze_off_screen_pct_10s: gazeOffPct10s },
  });

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'gaze_scanning_answer',
    conditionMet: answerActive && gazeScanning,
    flagType: FLAG_TYPES.READING_PATTERN_DETECTED,
    severity: FLAG_SEVERITY.MEDIUM,
    message: 'Eyes scanning multiple directions while answering',
    cooldownMs: 25_000,
    payload,
  });

  // ── Head pose rules ────────────────────────────────────────────────────────

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'head_off_sustained',
    conditionMet: headOffSec >= sustainedSec,
    flagType: FLAG_TYPES.FACE_LOOKING_AWAY,
    severity: FLAG_SEVERITY.HIGH,
    message: `Head rotated away from screen for ${headOffSec.toFixed(1)}s`,
    cooldownMs: 20_000,
    payload: { ...payload, head_off_screen_seconds: headOffSec },
  });

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'head_turns_10s',
    conditionMet: repeatedHeadTurns,
    flagType: FLAG_TYPES.EXCESSIVE_HEAD_MOVEMENT,
    severity: FLAG_SEVERITY.MEDIUM,
    message: `Repeated head turns away from screen (${headTurns10s} in ${cfg.attentionWindowSec}s)`,
    cooldownMs: 18_000,
    payload: { ...payload, head_turns_10s: headTurns10s },
  });

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'head_scanning_answer',
    conditionMet: answerActive && headScanning,
    flagType: FLAG_TYPES.EXCESSIVE_HEAD_MOVEMENT,
    severity: FLAG_SEVERITY.MEDIUM,
    message: 'Head moving between multiple directions while answering',
    cooldownMs: 25_000,
    payload,
  });

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'head_off_answer_pct',
    conditionMet:
      answerActive &&
      answerHeadOffPct > cfg.attentionHeadOffScreenPct &&
      headOffSec >= sustainedSec * 0.5,
    flagType: FLAG_TYPES.FACE_LOOKING_AWAY,
    severity: FLAG_SEVERITY.MEDIUM,
    message: `Face away from screen for ${answerHeadOffPct}% of current answer`,
    cooldownMs: 30_000,
    payload: { ...payload, answer_head_off_pct: answerHeadOffPct },
  });

  // ── Combined behavioral rules ──────────────────────────────────────────────

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'head_and_gaze_off',
    conditionMet: headOffSec >= sustainedSec && gazeOffSec >= sustainedSec,
    flagType: FLAG_TYPES.HIDDEN_DEVICE_ATTENTION,
    severity: FLAG_SEVERITY.HIGH,
    message: 'Head turned away while eyes focused off-screen',
    cooldownMs: 30_000,
    payload,
  });

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'gaze_and_head_moves',
    conditionMet:
      gazeMoves10s > cfg.attentionGazeMovesMax &&
      headTurns10s > cfg.attentionHeadTurnsMax &&
      (gazeOffSec >= sustainedSec || headOffSec >= sustainedSec),
    flagType: FLAG_TYPES.ATTENTION_CORRELATION,
    severity: FLAG_SEVERITY.HIGH,
    message: `Repeated eye (${gazeMoves10s}) and head (${headTurns10s}) movement in ${cfg.attentionWindowSec}s`,
    cooldownMs: 30_000,
    payload,
  });

  // Brief pre-answer glances are normal — only flag a repeated pattern.
  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'pre_speech_pattern',
    conditionMet: preSpeechCount >= cfg.attentionPreSpeechGlanceCount,
    flagType: FLAG_TYPES.ATTENTION_CORRELATION,
    severity: FLAG_SEVERITY.HIGH,
    message: `Repeated look-away before speaking (${preSpeechCount} times)`,
    cooldownMs: 35_000,
    payload: { ...payload, pre_speech_glance_count: preSpeechCount },
  });

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'answer_more_away_than_screen',
    conditionMet:
      answerActive &&
      answerGazeOffPct > cfg.attentionAnswerGazeOffPct &&
      gazeOffSec >= sustainedSec * 0.5,
    flagType: FLAG_TYPES.ATTENTION_CORRELATION,
    severity: FLAG_SEVERITY.HIGH,
    message: `Looking away from screen for ${answerGazeOffPct}% of answer (more than on-screen)`,
    cooldownMs: 35_000,
    payload: { ...payload, answer_gaze_off_pct: answerGazeOffPct },
  });

  const tabBlurRecent =
    state.lastTabOrBlurAt &&
    Date.now() - state.lastTabOrBlurAt < cfg.attentionCorrelationWindowMs;

  addFlagIfConfirmed(flags, state, cfg, {
    ruleKey: 'focus_loss_with_attention',
    conditionMet:
      tabBlurRecent &&
      (gazeOffSec >= sustainedSec ||
        hadRecentFlag(state, FLAG_TYPES.OFF_SCREEN_GAZE, cfg.attentionCorrelationWindowMs)),
    flagType: FLAG_TYPES.HIDDEN_DEVICE_ATTENTION,
    severity: FLAG_SEVERITY.HIGH,
    message: 'Off-screen attention combined with tab or focus loss',
    cooldownMs: 35_000,
    payload: { ...payload, tab_blur_recent: true },
  });

  return flags;
}

/** Called when tab_switch / window_blur flags are raised for correlation. */
export function noteFocusLossEvent(sessionId) {
  const state = getState(sessionId);
  state.lastTabOrBlurAt = Date.now();
  proctorDebug('attention_focus_loss_noted', { session_id: sessionId });
}

export function clearAttentionState(sessionId) {
  sessionAttention.delete(sessionId);
}
