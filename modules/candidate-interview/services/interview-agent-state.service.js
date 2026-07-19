import { sessionRepository } from '../repositories/session.repository.js';

function parseMeta(session) {
  try {
    return typeof session?.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session?.metadata_json || {};
  } catch {
    return {};
  }
}

export function defaultAgentState() {
  return {
    currentQuestionIndex: 1,
    totalQuestions: 0,
    currentQuestionId: null,
    currentQuestionText: '',
    isPaused: false,
    pauseReason: null,
    lastGeneralQuestion: null,
    resumePrompt: null,
  };
}

export function getInterviewAgentState(session) {
  const meta = parseMeta(session);
  const stored = meta.interview_agent;
  if (!stored || typeof stored !== 'object') return defaultAgentState();
  return { ...defaultAgentState(), ...stored };
}

export async function saveInterviewAgentState(session, patch = {}) {
  if (!session?.id) return defaultAgentState();
  const meta = parseMeta(session);
  const next = {
    ...getInterviewAgentState(session),
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await sessionRepository.update(session.id, {
    metadata_json: { ...meta, interview_agent: next },
  });
  return next;
}

export function buildResumePrompt(questionIndex, questionText) {
  const idx = Number(questionIndex) || 1;
  const q = String(questionText || '').trim();
  if (!q) {
    return `Welcome back! We can continue with Question ${idx} whenever you are ready.`;
  }
  return `Ready to continue? We were on Question ${idx}: ${q}`;
}

export function buildWelcomeBackPrompt(questionIndex, questionText) {
  const idx = Number(questionIndex) || 1;
  const q = String(questionText || '').trim();
  if (!q) {
    return `Welcome back! Go ahead with Question ${idx} whenever you are ready.`;
  }
  return `Welcome back! We were on Question ${idx}: ${q}. Go ahead whenever you are ready.`;
}

export function appendResumeOffer(responseText, questionIndex, questionText) {
  const base = String(responseText || '').trim();
  const offer = buildResumePrompt(questionIndex, questionText);
  if (!base) return offer;
  if (base.toLowerCase().includes('ready to continue') || base.toLowerCase().includes('welcome back')) {
    return base;
  }
  return `${base} ${offer}`;
}
