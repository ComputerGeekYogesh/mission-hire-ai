import { violationLabel, VIOLATION_LABELS } from './proctoring-violation-messages.js';

/** Canonical proctoring flag prefix for all suspicious activities. */
export const SUSPICIOUS_ACTIVITY_PREFIX = 'suspicious_activity_';

/** Legacy flag_type values → canonical stored names. */
const LEGACY_FLAG_MAP = Object.freeze({
  no_face: 'suspicious_activity_face_missing',
  face_absent_duration: 'suspicious_activity_face_missing',
  excessive_head_movement: 'suspicious_activity_head_movement',
  face_looking_away: 'suspicious_activity_off_screen_gaze',
  face_rotation: 'suspicious_activity_face_rotation',
  tab_switch: 'suspicious_activity_tab_switch',
  window_blur: 'suspicious_activity_window_blur',
  mic_muted: 'suspicious_activity_mic_muted',
  camera_disabled: 'suspicious_activity_camera_disabled',
  suspicious_pattern: 'suspicious_activity_pattern',
  headphones_removed: 'suspicious_activity_headphones_removed',
  question_repeated: 'suspicious_activity_question_repeated',
  identity_mismatch: 'suspicious_activity_identity_mismatch',
  mobile_phone_detected: 'suspicious_activity_mobile_detected',
  leaving_camera_frame: 'suspicious_activity_left_frame',
  excessive_eye_movement: 'suspicious_activity_eye_movement',
  downward_gaze: 'suspicious_activity_downward_gaze',
  off_screen_gaze: 'suspicious_activity_off_screen_gaze',
  reading_pattern_detected: 'suspicious_activity_reading_pattern',
  low_screen_attention: 'suspicious_activity_low_attention',
  pre_answer_downward_glance: 'suspicious_activity_pre_answer_glance',
  hidden_device_attention: 'suspicious_activity_hidden_device',
  attention_correlation: 'suspicious_activity_attention_correlation',
  webcam_obstruction: 'suspicious_activity_webcam_obstruction',
  liveness_failure: 'suspicious_activity_liveness_failure',
  identity_drift: 'suspicious_activity_identity_drift',
  integrity_anomaly: 'suspicious_activity_integrity_anomaly',
  voice_coaching: 'suspicious_activity_voice_coaching',
  virtual_camera: 'suspicious_activity_virtual_camera',
  verification_failed: 'suspicious_activity_verification_failed',
});

/** Strip prefix for audio/UI lookup keys when needed. */
export function proctorAudioKey(flagType) {
  const canonical = canonicalFlagType(flagType);
  if (canonical.startsWith(SUSPICIOUS_ACTIVITY_PREFIX)) {
    return canonical.slice(SUSPICIOUS_ACTIVITY_PREFIX.length);
  }
  return canonical;
}

/** Normalize any incoming flag type to canonical `suspicious_activity_*` form. */
export function canonicalFlagType(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (!s) return `${SUSPICIOUS_ACTIVITY_PREFIX}unknown`;
  if (s.startsWith(SUSPICIOUS_ACTIVITY_PREFIX)) return s;
  if (LEGACY_FLAG_MAP[s]) return LEGACY_FLAG_MAP[s];
  return `${SUSPICIOUS_ACTIVITY_PREFIX}${s.replace(/^suspicious_activity_?/, '')}`;
}

/** Human-readable activity names for warning audio and logs. */
export function activityDisplayName(flagType) {
  return violationLabel(flagType);
}

export { VIOLATION_LABELS };
