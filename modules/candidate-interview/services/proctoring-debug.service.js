import os from 'os';
import { interviewConfig } from '../config.js';
import { proctorAudioKey } from '../lib/proctoring-flag-naming.js';

/**
 * Human-readable multi-line proctoring flow logs.
 * Grep: [PROCTORING]
 */
export function proctorLog(message, meta = {}) {
  console.log(`[PROCTORING] ${message}`);
  if (meta.candidate_id != null) {
    console.log(`[PROCTORING] Candidate ID: ${meta.candidate_id}`);
  }
  if (meta.session_id != null && meta.candidate_id == null) {
    console.log(`[PROCTORING] Session ID: ${meta.session_id}`);
  }
  if (meta.warning_count != null) {
    console.log(`[PROCTORING] Warning Count: ${meta.warning_count}`);
  }
  if (meta.flag_type != null) {
    console.log(`[PROCTORING] Proctoring flag created: ${meta.flag_type}`);
  }
  if (meta.action != null) {
    console.log(`[PROCTORING] Action: ${meta.action}`);
  }
  if (meta.detail != null) {
    console.log(`[PROCTORING] ${meta.detail}`);
  }
}

export function proctorLogActivityDetected(session, flagType, extra = {}) {
  const activity = proctorAudioKey(flagType);
  proctorLog(`Suspicious activity detected: ${activity}`, {
    candidate_id: session?.candidate_id ?? session?.id,
    session_id: session?.id,
    flag_type: flagType,
    ...extra,
  });
}

export function proctorLogEscalationEmitted(session, flagType, action, proctoring = {}) {
  const activity = proctorAudioKey(flagType);
  const warningCount = proctoring.warning_count;
  if (action === 'terminate') {
    proctorLog(`Suspicious activity detected: ${activity}`, {
      candidate_id: session?.candidate_id ?? session?.id,
      session_id: session?.id,
      warning_count: warningCount,
    });
    proctorLog('Assessment termination triggered', {
      session_id: session?.id,
      detail: 'Session closed',
    });
    return;
  }
  if (action === 'final_warning') {
    proctorLog(`Suspicious activity detected: ${activity}`, {
      candidate_id: session?.candidate_id ?? session?.id,
      session_id: session?.id,
      warning_count: warningCount,
    });
    proctorLog('Final warning triggered', { session_id: session?.id });
    proctorLog('Audio alert event emitted', { session_id: session?.id, action });
    return;
  }
  if (action === 'warning') {
    proctorLog(`Suspicious activity detected: ${activity}`, {
      candidate_id: session?.candidate_id ?? session?.id,
      session_id: session?.id,
      warning_count: warningCount,
    });
    proctorLog('Warning event emitted to frontend', { session_id: session?.id, action });
  }
}

/**
 * Structured backend logs for proctoring pipeline.
 * Grep: [proctoring-debug]
 */
export function proctorDebug(step, meta = {}) {
  console.log(
    '[proctoring-debug]',
    JSON.stringify({
      step,
      ts: new Date().toISOString(),
      host: os.hostname(),
      pid: process.pid,
      warn_threshold: interviewConfig.proctoringWarnScore,
      terminate_threshold: interviewConfig.proctoringTerminateScore,
      minor_cooldown_ms: interviewConfig.proctoringMinorViolationCooldownMs,
      ...meta,
    })
  );
}

export function proctorDebugError(step, err, meta = {}) {
  console.error(
    '[proctoring-debug]',
    JSON.stringify({
      step,
      ts: new Date().toISOString(),
      host: os.hostname(),
      pid: process.pid,
      error: err?.message || String(err),
      ...meta,
    })
  );
}

/** Structured multi-step flow log for a single proctoring incident. */
export function proctorDebugFlow(phase, meta = {}) {
  proctorDebug(`flow_${phase}`, meta);
}
