/**
 * Builds a compact, UI-friendly summary of interview flags.
 *
 * This file exists because admin pages import:
 *   import('../services/flag-summary.service.js');
 */

import { canonicalFlagType, proctorAudioKey } from '../lib/proctoring-flag-naming.js';

/** Map internal flag_type → webhook summary bucket. */
const FLAG_BUCKET = {
  tab_switch: 'tab_switches',
  window_blur: 'tab_switches',
  no_face: 'face_not_detected',
  face_absent_duration: 'face_not_detected',
  face_missing: 'face_not_detected',
  left_frame: 'face_not_detected',
  excessive_head_movement: 'suspicious_activity',
  head_movement: 'suspicious_activity',
  face_looking_away: 'face_rotation',
  face_rotation: 'face_rotation',
  suspicious_pattern: 'suspicious_activity',
  pattern: 'suspicious_activity',
  headphones_removed: 'suspicious_activity',
  mic_muted: 'suspicious_activity',
  camera_disabled: 'suspicious_activity',
  question_repeated: 'suspicious_activity',
  identity_mismatch: 'suspicious_activity',
  downward_gaze: 'suspicious_activity',
  off_screen_gaze: 'face_rotation',
  reading_pattern: 'suspicious_activity',
  reading_pattern_detected: 'suspicious_activity',
  low_attention: 'suspicious_activity',
  low_screen_attention: 'suspicious_activity',
  pre_answer_glance: 'suspicious_activity',
  pre_answer_downward_glance: 'suspicious_activity',
  hidden_device: 'suspicious_activity',
  hidden_device_attention: 'suspicious_activity',
  attention_correlation: 'suspicious_activity',
  excessive_eye_movement: 'suspicious_activity',
  eye_movement: 'suspicious_activity',
  leaving_camera_frame: 'face_not_detected',
  mobile_phone_detected: 'suspicious_activity',
  mobile_detected: 'suspicious_activity',
  webcam_obstruction: 'suspicious_activity',
  liveness_failure: 'suspicious_activity',
  identity_drift: 'suspicious_activity',
  integrity_anomaly: 'suspicious_activity',
  voice_coaching: 'suspicious_activity',
  virtual_camera: 'suspicious_activity',
  verification_failed: 'suspicious_activity',
};

/** Map internal flag_type → external `type` in flag_details. */
const FLAG_EXTERNAL_TYPE = {
  tab_switch: 'tab_switch',
  window_blur: 'tab_switch',
  no_face: 'face_not_detected',
  face_absent_duration: 'face_not_detected',
  face_missing: 'face_not_detected',
  left_frame: 'face_not_detected',
  excessive_head_movement: 'suspicious_activity',
  head_movement: 'suspicious_activity',
  face_looking_away: 'face_rotation',
  face_rotation: 'face_rotation',
  suspicious_pattern: 'suspicious_activity',
  pattern: 'suspicious_activity',
  headphones_removed: 'suspicious_activity',
  mic_muted: 'suspicious_activity',
  camera_disabled: 'suspicious_activity',
  question_repeated: 'question_repeated',
  identity_mismatch: 'suspicious_activity',
  downward_gaze: 'suspicious_activity',
  off_screen_gaze: 'face_rotation',
  reading_pattern: 'suspicious_activity',
  reading_pattern_detected: 'suspicious_activity',
  low_attention: 'suspicious_activity',
  low_screen_attention: 'suspicious_activity',
  pre_answer_glance: 'suspicious_activity',
  pre_answer_downward_glance: 'suspicious_activity',
  hidden_device: 'suspicious_activity',
  hidden_device_attention: 'suspicious_activity',
  attention_correlation: 'suspicious_activity',
  excessive_eye_movement: 'suspicious_activity',
  eye_movement: 'suspicious_activity',
  leaving_camera_frame: 'face_not_detected',
  mobile_phone_detected: 'suspicious_activity',
  mobile_detected: 'suspicious_activity',
  webcam_obstruction: 'webcam_obstruction',
  liveness_failure: 'liveness_failure',
  identity_drift: 'identity_drift',
  integrity_anomaly: 'integrity_anomaly',
  voice_coaching: 'voice_coaching',
  virtual_camera: 'virtual_camera',
  verification_failed: 'verification_failed',
};

function toIsoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function externalFlagType(flagType) {
  const key = proctorAudioKey(flagType);
  return FLAG_EXTERNAL_TYPE[key] || FLAG_EXTERNAL_TYPE[flagType] || flagType || 'suspicious_activity';
}

function bucketForFlag(flagType) {
  const key = proctorAudioKey(flagType);
  return FLAG_BUCKET[key] || FLAG_BUCKET[flagType] || 'suspicious_activity';
}

function emptyFlagSummary() {
  return {
    total_flags: 0,
    tab_switches: 0,
    face_not_detected: 0,
    low_light_detected: 0,
    suspicious_activity: 0,
    flag_details: [],
  };
}

export function buildFlagSummary(flags = []) {
  const summary = emptyFlagSummary();
  summary.flag_details = (flags || []).map((f) => {
    const canonical = canonicalFlagType(f.flag_type);
    const type = externalFlagType(canonical);
    const bucket = bucketForFlag(canonical);
    summary[bucket] = (summary[bucket] || 0) + 1;
    summary.total_flags += 1;

    return {
      type,
      timestamp: toIsoDate(f.created_at),
      description: f.message || `${canonical} flagged during interview`,
      severity: f.severity,
      flag_type: canonical,
    };
  });

  return summary;
}
