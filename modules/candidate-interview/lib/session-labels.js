/**
 * Session type → display label lookup for video-interview flows.
 * Add new types by extending SESSION_TYPES and LABELS_BY_TYPE.
 */

export const SESSION_TYPES = Object.freeze({
  INTERVIEW: 'interview',
  SKILL_ASSESSMENT: 'skill_assessment',
});

const LABELS_BY_TYPE = Object.freeze({
  [SESSION_TYPES.INTERVIEW]: Object.freeze({
    pageTitle: 'Interview',
    headerFallback: 'Interview',
    callUiLabel: 'In-app interview',
    inviteSubject: 'Interview Invitation',
    inviteHeading: 'Interview Invitation',
    inviteIntro: 'You are invited to complete your interview. Please use the secure link below.',
    joinCta: 'Join your interview',
    openCta: 'Open interview',
    guidelinesTitle: 'Guidelines for Your Interview',
    beforeSection: 'Before the Interview:',
    duringSection: 'During the Interview:',
    navigateAwayWarning:
      'Do not switch tabs, minimize the browser window, or navigate away from the interview. Such actions may be flagged as suspicious activity.',
    monitoredWarning:
      'Suspicious activities are monitored throughout the interview. You will receive up to four warnings for suspicious behavior; a fifth detection will result in automatic interview termination.',
    videoBrowserNote:
      'This video interview is supported only on the Google Chrome browser. Please use a laptop or desktop computer for the best experience. Do not use Mozilla Firefox or other browsers, as they may not support the required voice recognition and video interview features.',
    labelLower: 'interview',
    completionTitle: 'Interview completed',
    completionAudio: 'You have completed all questions. Thank you for your interview.',
    finishButton: 'Finish Interview',
    finishButtonTitle: 'Submit your final answer and complete the interview',
    terminatedTitle: 'Interview Terminated',
    terminatedMessage:
      'Your interview has been terminated due to repeated violations of interview guidelines after multiple warnings were issued.',
    terminatedAudio:
      'Your interview has been terminated due to repeated violations of interview guidelines after multiple warnings were issued.',
    rulesIntroTermination: 'terminates the interview.',
    endApiMessage: 'Interview completed. Thank you.',
    terminatedEndApiMessage: 'Interview terminated due to proctoring violations.',
    finalizingError: 'We encountered an issue finalising your interview. Retrying automatically…',
  }),
  [SESSION_TYPES.SKILL_ASSESSMENT]: Object.freeze({
    pageTitle: 'Skill Assessment',
    headerFallback: 'Skill Assessment',
    callUiLabel: 'In-app skill assessment',
    inviteSubject: 'Assessment Invitation',
    inviteHeading: 'Assessment Invitation',
    inviteIntro: 'You are invited to complete your assessment. Please use the secure link below.',
    joinCta: 'Join your assessment',
    openCta: 'Open assessment',
    guidelinesTitle: 'Guidelines for Your Assessment',
    beforeSection: 'Before the Assessment:',
    duringSection: 'During the Assessment:',
    navigateAwayWarning:
      'Do not switch tabs, minimize the browser window, or navigate away from the assessment. Such actions may be flagged as suspicious activity.',
    monitoredWarning:
      'Suspicious activities are monitored throughout the assessment. You will receive up to four warnings for suspicious behavior; a fifth detection will result in automatic assessment termination.',
    videoBrowserNote:
      'This video assessment is supported only on the Google Chrome browser. Please use a laptop or desktop computer for the best experience. Do not use Mozilla Firefox or other browsers, as they may not support the required voice recognition and video assessment features.',
    labelLower: 'skill assessment',
    completionTitle: 'Assessment completed',
    completionAudio: 'You have completed all questions. Thank you for your assessment.',
    finishButton: 'Finish Assessment',
    finishButtonTitle: 'Submit your final answer and complete the assessment',
    terminatedTitle: 'Assessment Terminated',
    terminatedMessage:
      'Your assessment has been terminated due to repeated violations of assessment guidelines after multiple warnings were issued.',
    terminatedAudio:
      'Your assessment has been terminated due to repeated violations of assessment guidelines after multiple warnings were issued.',
    rulesIntroTermination: 'terminates the assessment.',
    endApiMessage: 'Assessment completed. Thank you.',
    terminatedEndApiMessage: 'Assessment terminated due to proctoring violations.',
    finalizingError: 'We encountered an issue finalising your assessment. Retrying automatically…',
  }),
});

/** @returns {string} Normalized session type key; defaults to skill_assessment. */
export function normalizeSessionType(type) {
  const t = String(type ?? '').trim().toLowerCase();
  if (t === SESSION_TYPES.INTERVIEW) return SESSION_TYPES.INTERVIEW;
  if (t === SESSION_TYPES.SKILL_ASSESSMENT) return SESSION_TYPES.SKILL_ASSESSMENT;
  return SESSION_TYPES.INTERVIEW;
}

/**
 * Resolve a single label variant for a session type.
 * @param {string|null|undefined} type
 * @param {keyof typeof LABELS_BY_TYPE['interview']} variant
 */
export function getSessionLabel(type, variant = 'pageTitle') {
  const normalized = normalizeSessionType(type);
  const labels = LABELS_BY_TYPE[normalized];
  const value = labels[variant];
  return typeof value === 'function' ? value : value ?? labels.pageTitle;
}

/** @returns {Readonly<typeof LABELS_BY_TYPE['interview']> & { type: string }} */
export function resolveSessionLabels(type) {
  const normalized = normalizeSessionType(type);
  return { type: normalized, ...LABELS_BY_TYPE[normalized] };
}

/**
 * Post device-check room greeting (TTS). Uses pageTitle as {label} and labelLower as {label_lowercase}.
 * Single string with sentence punctuation for natural pauses — no literal newlines.
 */
export function buildWelcomeAudioText(firstName, type) {
  const labels = resolveSessionLabels(type);
  const name = String(firstName || '').trim().split(/\s+/)[0] || 'there';
  return (
    `Hi ${name}, welcome to your ${labels.pageTitle}. ` +
    `This ${labels.labelLower} contains multiple questions. After completing your answer for each question, click the Next Question button in the sidebar to proceed. ` +
    `Please read all the instructions in the sidebar carefully before you begin. ` +
    `When you're ready, let's get started. Good luck!`
  );
}

function parseMeta(session) {
  try {
    return typeof session?.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session?.metadata_json || {};
  } catch {
    return {};
  }
}

/** Extract session_type from interview session metadata. */
export function getSessionTypeFromSession(session) {
  const meta = parseMeta(session);
  if (meta.session_type) return normalizeSessionType(meta.session_type);
  // Mission schedule chat always creates interviews (never skill assessments).
  if (meta.source === 'schedule_chat') return SESSION_TYPES.INTERVIEW;
  return SESSION_TYPES.INTERVIEW;
}

/** Resolve full label set from an interview session record. */
export function resolveSessionLabelsFromSession(session) {
  return resolveSessionLabels(getSessionTypeFromSession(session));
}

/** JSON-serializable labels for browser (resolves welcomeAudio with candidate name). */
export function resolveClientSessionLabels(type, candidateName) {
  const labels = resolveSessionLabels(type);
  const firstName = String(candidateName || '').trim().split(/\s+/)[0] || 'there';
  return { ...labels, welcomeAudioText: buildWelcomeAudioText(firstName, type) };
}

/** Client labels from session record. */
export function resolveClientSessionLabelsFromSession(session) {
  return resolveClientSessionLabels(getSessionTypeFromSession(session), session?.candidate_name);
}
