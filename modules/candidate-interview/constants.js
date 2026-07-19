export const SESSION_STATUS = Object.freeze({
  CREATED: 'created',
  INVITED: 'invited',
  VERIFIED: 'verified',
  PREFLIGHT_OK: 'preflight_ok',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SUSPICIOUS: 'suspicious',
  TERMINATED_PROCTORING: 'terminated_due_to_proctoring_violation',
  CANCELLED: 'cancelled',
});

export const INTERVIEW_TYPES = Object.freeze({
  BROWSER_VIDEO: 'browser_video',
  VOICE_CALL: 'voice_call',
  AI_INTERVIEW: 'ai_interview',
});

export const FLAG_SEVERITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

/** All proctoring flags use the suspicious_activity_ prefix. */
export const FLAG_TYPES = Object.freeze({
  NO_FACE: 'suspicious_activity_face_missing',
  EXCESSIVE_HEAD_MOVEMENT: 'suspicious_activity_head_movement',
  FACE_LOOKING_AWAY: 'suspicious_activity_off_screen_gaze',
  FACE_ROTATION: 'suspicious_activity_face_rotation',
  TAB_SWITCH: 'suspicious_activity_tab_switch',
  WINDOW_BLUR: 'suspicious_activity_window_blur',
  MIC_MUTED: 'suspicious_activity_mic_muted',
  CAMERA_DISABLED: 'suspicious_activity_camera_disabled',
  FACE_ABSENT_DURATION: 'suspicious_activity_face_missing',
  SUSPICIOUS_PATTERN: 'suspicious_activity_pattern',
  HEADPHONES_REMOVED: 'suspicious_activity_headphones_removed',
  QUESTION_REPEATED: 'suspicious_activity_question_repeated',
  IDENTITY_MISMATCH: 'suspicious_activity_identity_mismatch',
  MOBILE_PHONE_DETECTED: 'suspicious_activity_mobile_detected',
  LEAVING_CAMERA_FRAME: 'suspicious_activity_left_frame',
  EXCESSIVE_EYE_MOVEMENT: 'suspicious_activity_eye_movement',
  DOWNWARD_GAZE: 'suspicious_activity_downward_gaze',
  OFF_SCREEN_GAZE: 'suspicious_activity_off_screen_gaze',
  READING_PATTERN_DETECTED: 'suspicious_activity_reading_pattern',
  LOW_SCREEN_ATTENTION: 'suspicious_activity_low_attention',
  PRE_ANSWER_DOWNWARD_GLANCE: 'suspicious_activity_pre_answer_glance',
  HIDDEN_DEVICE_ATTENTION: 'suspicious_activity_hidden_device',
  ATTENTION_CORRELATION: 'suspicious_activity_attention_correlation',
  WEBCAM_OBSTRUCTION: 'suspicious_activity_webcam_obstruction',
  LIVENESS_FAILURE: 'suspicious_activity_liveness_failure',
  IDENTITY_DRIFT: 'suspicious_activity_identity_drift',
  INTEGRITY_ANOMALY: 'suspicious_activity_integrity_anomaly',
  VOICE_COACHING: 'suspicious_activity_voice_coaching',
  VIRTUAL_CAMERA: 'suspicious_activity_virtual_camera',
  VERIFICATION_FAILED: 'suspicious_activity_verification_failed',
});

export const HEADPHONE_STATUS = Object.freeze({
  UNKNOWN: 'unknown',
  DETECTED: 'detected',
  NOT_DETECTED: 'not_detected',
});

/** Session video stored in interview_recording_blobs (final upload only). */
export const RECORDING_STORAGE_KEY_MYSQL_BLOB = 'mysql_blob';

export const RECORDING_STORAGE_MODES = Object.freeze({
  FILESYSTEM: 'filesystem',
  MYSQL_BLOB: 'mysql_blob',
});

export const ACTIVE_STATUSES = [
  SESSION_STATUS.INVITED,
  SESSION_STATUS.VERIFIED,
  SESSION_STATUS.PREFLIGHT_OK,
  SESSION_STATUS.IN_PROGRESS,
];
