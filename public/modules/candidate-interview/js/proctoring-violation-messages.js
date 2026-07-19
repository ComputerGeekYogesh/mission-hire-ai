/**
 * Client-side proctoring violation labels and alert copy (mirrors server module).
 */
window.InterviewProctorMessages = (function () {
  const VIOLATION_LABELS = {
    face_rotation: 'Face Rotation',
    head_rotation: 'Head Rotation',
    excessive_head_movement: 'Excessive Head Movement',
    looking_away: 'Looking Away From Screen',
    downward_gaze: 'Downward Gaze',
    mobile_detected: 'Mobile Phone',
    face_missing: 'Face Not Visible',
    tab_switch: 'Tab Switching',
    window_blur: 'Window Focus Lost',
    eye_movement: 'Excessive Eye Movement',
    reading_pattern: 'Reading Pattern',
    low_attention: 'Low Screen Attention',
    hidden_device: 'Hidden Device Usage',
    attention_correlation: 'Attention Anomaly',
    camera_disabled: 'Camera Disabled',
    mic_muted: 'Microphone Muted',
    headphones_removed: 'Headphones Removed',
    identity_mismatch: 'Identity Mismatch',
    question_repeated: 'Question Repetition',
    pattern: 'Suspicious Pattern',
    webcam_obstruction: 'Webcam Obstruction',
    liveness_failure: 'Liveness Verification Failed',
    identity_drift: 'Identity Continuity Lost',
    integrity_anomaly: 'Session Integrity Anomaly',
    voice_coaching: 'Voice Coaching Detected',
    virtual_camera: 'Virtual Camera Detected',
    verification_failed: 'Verification Challenge Failed',
  };

  const AUDIO_KEY_TO_VIOLATION = {
    face_rotation: 'face_rotation',
    head_rotation: 'head_rotation',
    head_movement: 'excessive_head_movement',
    excessive_head_movement: 'excessive_head_movement',
    off_screen_gaze: 'looking_away',
    face_looking_away: 'looking_away',
    downward_gaze: 'downward_gaze',
    mobile_detected: 'mobile_detected',
    mobile_phone_detected: 'mobile_detected',
    face_missing: 'face_missing',
    no_face: 'face_missing',
    face_absent_duration: 'face_missing',
    left_frame: 'face_missing',
    leaving_camera_frame: 'face_missing',
    tab_switch: 'tab_switch',
    window_blur: 'window_blur',
    eye_movement: 'eye_movement',
    excessive_eye_movement: 'eye_movement',
    reading_pattern: 'reading_pattern',
    reading_pattern_detected: 'reading_pattern',
    low_attention: 'low_attention',
    low_screen_attention: 'low_attention',
    pre_answer_glance: 'downward_gaze',
    pre_answer_downward_glance: 'downward_gaze',
    hidden_device: 'hidden_device',
    hidden_device_attention: 'hidden_device',
    attention_correlation: 'attention_correlation',
    camera_disabled: 'camera_disabled',
    mic_muted: 'mic_muted',
    headphones_removed: 'headphones_removed',
    identity_mismatch: 'identity_mismatch',
    question_repeated: 'question_repeated',
    pattern: 'pattern',
    suspicious_pattern: 'pattern',
    webcam_obstruction: 'webcam_obstruction',
    liveness_failure: 'liveness_failure',
    identity_drift: 'identity_drift',
    integrity_anomaly: 'integrity_anomaly',
    voice_coaching: 'voice_coaching',
    virtual_camera: 'virtual_camera',
    verification_failed: 'verification_failed',
  };

  const FOCUS_LOSS_WARNING_MESSAGE =
    'Interview window focus lost. Please stay on the interview screen.';

  const FIRST_WARNING_AUDIO_TEMPLATES = {
    face_rotation:
      'Warning. Face rotation has been detected. Please keep your face directed toward the screen and camera.',
    head_rotation:
      'Warning. Head rotation has been detected. Please remain focused on the {session}.',
    excessive_head_movement:
      'Warning. Excessive head movement has been detected. Please keep your head facing the screen and camera.',
    looking_away:
      'Warning. Looking away from the screen has been detected. Please maintain attention on the {session}.',
    downward_gaze:
      'Warning. Downward gaze has been detected. Please keep your eyes on the {screen}.',
    mobile_detected:
      'Warning. A mobile phone has been detected during the {session}. Please remove the device immediately.',
    face_missing:
      'Warning. Your face is not clearly visible in the camera. Please return to the camera view.',
    eye_movement:
      'Warning. Excessive eye movement has been detected. Please maintain focus on the {screen}.',
    reading_pattern:
      'Warning. A reading pattern has been detected. Please answer independently without referring to external materials.',
    low_attention:
      'Warning. Low screen attention has been detected. Please focus on the {session}.',
    hidden_device:
      'Warning. Suspicious attention toward a hidden device has been detected. Please remove any unauthorized devices.',
    attention_correlation:
      'Warning. Multiple attention anomalies have been detected. Please remain focused on the {session}.',
    camera_disabled:
      'Warning. Your camera appears to be disabled. Please enable your camera to continue.',
    mic_muted:
      'Warning. Your microphone appears to be muted. Please unmute your microphone.',
    headphones_removed:
      'Warning. Headphones were removed. Please reconnect your headphones to continue.',
    identity_mismatch:
      'Warning. An identity mismatch was detected. Please face the camera directly.',
    question_repeated:
      'Warning. Excessive question repetition was detected. Please answer in your own words.',
    pattern:
      'Warning. Suspicious activity has been detected. Please follow the {guidelines}.',
    webcam_obstruction:
      'Warning. Your webcam appears to be obstructed. Please ensure your camera remains clear and unobstructed throughout the {session}.',
    liveness_failure:
      'Warning. Live presence verification failed. Please ensure you are actively on camera with a live video feed.',
    identity_drift:
      'Warning. Identity continuity could not be verified. Please remain the same candidate who started this {session}.',
    integrity_anomaly:
      'Warning. A session integrity anomaly was detected. Please keep your camera, microphone, and browser active.',
    voice_coaching:
      'Warning. Additional voices or coaching cues were detected. Only you should participate in this {session}.',
    virtual_camera:
      'Warning. A virtual or synthetic camera source was detected. Please use your physical webcam for this {session}.',
    verification_failed:
      'Warning. Your verification response did not match your prior answers. Please answer independently.',
  };

  const FINAL_WARNING_AUDIO_TEMPLATES = {
    webcam_obstruction:
      'Final Warning. Your webcam continues to appear obstructed. Any further violation will result in {termination}.',
    liveness_failure:
      'Final Warning. Live presence could not be verified again. Any further violation will result in {termination}.',
    identity_drift:
      'Final Warning. Identity continuity remains unverified. Any further violation will result in {termination}.',
    virtual_camera:
      'Final Warning. Virtual camera usage continues to be detected. Any further violation will result in {termination}.',
    voice_coaching:
      'Final Warning. Additional voices or coaching continue to be detected. Any further violation will result in {termination}.',
  };

  const TERMINATION_BANNER = 'Interview Terminated';
  const TERMINATION_AUDIO =
    'Your interview has been terminated due to repeated violations of interview guidelines after multiple warnings were issued.';

  function resolveLexicon(labels) {
    const source = labels || window.INTERVIEW_SESSION_LABELS || {};
    const cap = source.pageTitle || 'Interview';
    const lower = source.labelLower || 'interview';
    return {
      cap,
      lower,
      screen: `${lower} screen`,
      guidelines: `${lower} guidelines`,
      termination: `${lower} termination`,
      focusLossWarning:
        source.focusLossWarning ||
        `${cap} window focus lost. Please stay on the ${lower} screen.`,
      focusLossSpoken: source.focusLossSpoken || `${cap} window focus lost`,
      terminatedTitle: source.terminatedTitle || `${cap} Terminated`,
      terminatedAudio:
        source.terminatedAudio ||
        source.terminatedMessage ||
        `Your ${lower} has been terminated due to repeated violations of ${lower} guidelines after multiple warnings were issued.`,
    };
  }

  function applyLexicon(text, lex) {
    if (!text) return text;
    return text
      .replace(/\{cap\}/g, lex.cap)
      .replace(/\{session\}/g, lex.lower)
      .replace(/\{screen\}/g, lex.screen)
      .replace(/\{guidelines\}/g, lex.guidelines)
      .replace(/\{termination\}/g, lex.termination);
  }

  function proctorAudioKey(flagType) {
    const s = String(flagType || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');
    if (s.startsWith('suspicious_activity_')) return s.slice('suspicious_activity_'.length);
    return s.replace(/^suspicious_activity_?/, '');
  }

  function violationKeyFromFlagType(flagType) {
    const audioKey = proctorAudioKey(flagType);
    return AUDIO_KEY_TO_VIOLATION[audioKey] || audioKey;
  }

  function violationLabel(flagType) {
    const key = violationKeyFromFlagType(flagType);
    return VIOLATION_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function violationSpokenLabel(flagType, labels) {
    const key = violationKeyFromFlagType(flagType);
    if (key === 'tab_switch' || key === 'window_blur') {
      return resolveLexicon(labels).focusLossSpoken;
    }
    const spokenDefaults = {
      face_rotation: 'Face rotation',
      head_rotation: 'Head rotation',
      excessive_head_movement: 'Excessive head movement',
      looking_away: 'Looking away from the screen',
      downward_gaze: 'Downward gaze',
      mobile_detected: 'A mobile phone',
      face_missing: 'Your face not being visible',
      eye_movement: 'Excessive eye movement',
      reading_pattern: 'A reading pattern',
      low_attention: 'Low screen attention',
      hidden_device: 'Hidden device usage',
      attention_correlation: 'Attention anomalies',
      camera_disabled: 'Camera disabled',
      mic_muted: 'Microphone muted',
      headphones_removed: 'Headphones removed',
      identity_mismatch: 'Identity mismatch',
      question_repeated: 'Question repetition',
      pattern: 'Suspicious activity',
      webcam_obstruction: 'Webcam obstruction',
      liveness_failure: 'Live presence verification failure',
      identity_drift: 'Identity continuity loss',
      integrity_anomaly: 'Session integrity anomaly',
      voice_coaching: 'Voice coaching',
      virtual_camera: 'Virtual camera usage',
      verification_failed: 'Verification challenge failure',
    };
    return spokenDefaults[key] || violationLabel(flagType).toLowerCase();
  }

  function isFocusLossViolation(flagType) {
    const key = violationKeyFromFlagType(flagType);
    return key === 'tab_switch' || key === 'window_blur';
  }

  function buildWarningBanner(flagType, labels) {
    const lex = resolveLexicon(labels);
    if (isFocusLossViolation(flagType)) return lex.focusLossWarning;
    return `Warning: ${violationLabel(flagType)} Detected`;
  }

  function buildFinalWarningBanner(flagType, labels) {
    const lex = resolveLexicon(labels);
    if (isFocusLossViolation(flagType)) {
      return `Final Warning: ${lex.focusLossWarning}`;
    }
    return `Final Warning: ${violationLabel(flagType)} Detected`;
  }

  function buildWarningAudio(flagType, labels) {
    const lex = resolveLexicon(labels);
    const key = violationKeyFromFlagType(flagType);
    if (isFocusLossViolation(flagType)) return lex.focusLossWarning;
    const template = FIRST_WARNING_AUDIO_TEMPLATES[key];
    if (template) return applyLexicon(template, lex);
    return applyLexicon(
      `Warning. ${violationSpokenLabel(flagType, labels)} has been detected. Please remain focused on the {session} and follow the {guidelines}.`,
      lex
    );
  }

  function buildFinalWarningAudio(flagType, labels) {
    const lex = resolveLexicon(labels);
    const key = violationKeyFromFlagType(flagType);
    if (isFocusLossViolation(flagType)) {
      return `Final Warning. ${lex.focusLossWarning} Any further violation will result in immediate ${lex.termination}.`;
    }
    const template = FINAL_WARNING_AUDIO_TEMPLATES[key];
    if (template) return applyLexicon(template, lex);
    const spoken = violationSpokenLabel(flagType, labels);
    const subject =
      spoken.endsWith(' switching') || spoken.endsWith(' loss') || spoken.startsWith('Your ')
        ? spoken
        : `${spoken.charAt(0).toLowerCase()}${spoken.slice(1)}`;
    return `Final Warning. ${subject} has been detected again. Any further violation will result in immediate ${lex.termination}.`;
  }

  function buildEscalationMessages(flagType, action, labels) {
    const lex = resolveLexicon(labels);
    if (action === 'terminate') {
      return {
        banner: lex.terminatedTitle || TERMINATION_BANNER,
        audio: lex.terminatedAudio || TERMINATION_AUDIO,
      };
    }
    if (action === 'final_warning') {
      return {
        banner: buildFinalWarningBanner(flagType, labels),
        audio: buildFinalWarningAudio(flagType, labels),
      };
    }
    return {
      banner: buildWarningBanner(flagType, labels),
      audio: buildWarningAudio(flagType, labels),
    };
  }

  return {
    VIOLATION_LABELS,
    AUDIO_KEY_TO_VIOLATION,
    FOCUS_LOSS_WARNING_MESSAGE,
    TERMINATION_BANNER,
    TERMINATION_AUDIO,
    violationKeyFromFlagType,
    violationLabel,
    violationSpokenLabel,
    buildWarningBanner,
    buildFinalWarningBanner,
    buildWarningAudio,
    buildFinalWarningAudio,
    buildEscalationMessages,
  };
})();
