/**
 * Varied spoken responses for assessment intents (no markdown — audio/video UI).
 */
const GENERAL_QUERY_REDIRECT = [
  'Please focus on answering the interview question. I can only assist with assessment-related requests such as repeating or clarifying the current question.',
];

const GENERAL_QUERY_IRRELEVANT = [
  "I can't help with that during the assessment, but I'm happy to continue with the interview question when you're ready.",
  "That's outside what I can cover here. Let's stay focused on the interview question.",
];

const MOVE_TO_NEXT_ACK = [
  'Got it, noted your answer.',
  'Thanks — I have that. Moving on.',
];

const IRRELEVANT_RESPONSE = [
  'Your response does not appear to be related to the current interview question. Please answer the question being asked.',
];

const NOISE_OR_UNCLEAR = [
  "I didn't catch that clearly. Could you please repeat your response?",
  "Sorry, I couldn't understand that. Please repeat what you said.",
  'I missed that — could you say it again?',
];

const META_DURATION = [
  "That's a great question! It really depends on how detailed your answers are — some candidates finish quickly, others take a bit more time. I wouldn't worry too much about the clock; just take the time you need to answer thoughtfully.",
  "Good question — there isn't a fixed time for everyone. Take whatever time you need to give thoughtful answers, and we'll move at your pace.",
];

const META_QUESTION_COUNT = [
  "There are a few questions lined up for you. I'd rather not give away the exact number so you can stay focused — but we'll get through them together!",
  'You have several questions ahead — enough to give us a good sense of your experience. Just take them one at a time.',
];

const META_FORMAT = [
  "This is a video assessment — I'll ask you questions aloud, and you respond in your own words on camera. When you're done with an answer, we'll move to the next question together.",
];

const CONTROL_BREAK = [
  "Absolutely, take a moment if you need it. Just let me know when you're ready to continue.",
  'Of course — take a short break. When you\'re ready, we can pick up right where we left off.',
];

const TECHNICAL = [
  "I'm sorry you're running into that. Try checking your microphone and camera permissions in the browser, then refresh if needed. Let me know if it persists.",
  'Thanks for flagging that. Please check your device settings and ensure the browser has permission to use your mic and camera.',
];

const EDGE_DONT_KNOW = [
  "No worries at all, let's move on to the next one.",
  "That's completely fine — we can move forward whenever you're ready.",
];

const EDGE_PROFANITY = [
  "Let's keep things professional — shall we continue?",
  "I'd appreciate us keeping a professional tone — ready to continue?",
];

const EDGE_HINT = [
  "I'm not able to guide on answers, but I believe you've got this!",
  "I can't help with the answer itself, but trust your own experience — you've got this.",
];

const POOLS = {
  GENERAL_QUERY: {
    redirect: GENERAL_QUERY_REDIRECT,
    irrelevant: GENERAL_QUERY_IRRELEVANT,
    duration: META_DURATION,
    question_count: META_QUESTION_COUNT,
    format: META_FORMAT,
    control: CONTROL_BREAK,
    default: GENERAL_QUERY_REDIRECT,
  },
  MOVE_TO_NEXT: { default: MOVE_TO_NEXT_ACK },
  IRRELEVANT_RESPONSE: { default: IRRELEVANT_RESPONSE },
  NOISE_OR_UNCLEAR_INPUT: { default: NOISE_OR_UNCLEAR },
  CLARIFICATION_REQUEST: { default: [] },
  EDGE_CASE: {
    DONT_KNOW: EDGE_DONT_KNOW,
    PROFANITY: EDGE_PROFANITY,
    HINT_REQUEST: EDGE_HINT,
    TECHNICAL: TECHNICAL,
    CONTROL: CONTROL_BREAK,
  },
};

const usedBySession = new Map();

function pickFromPool(sessionId, poolKey, pool) {
  const key = `${sessionId}:${poolKey}`;
  let used = usedBySession.get(key);
  if (!used) {
    used = new Set();
    usedBySession.set(key, used);
  }
  const indices = pool.map((_, i) => i).filter((i) => !used.has(i));
  const pickFrom = indices.length ? indices : pool.map((_, i) => i);
  if (indices.length === 0) used.clear();
  const idx = pickFrom[Math.floor(Math.random() * pickFrom.length)];
  used.add(idx);
  return { text: pool[idx], templateIndex: idx };
}

export function pickGeneralQueryResponse(sessionId, { reasoning, scopeCategory, edgeCase, irrelevant } = {}) {
  if (edgeCase === 'CONTROL') {
    return pickFromPool(sessionId, 'general:control', POOLS.GENERAL_QUERY.control);
  }
  if (irrelevant) {
    return pickFromPool(sessionId, 'general:irrelevant', POOLS.GENERAL_QUERY.irrelevant);
  }
  const r = String(reasoning || scopeCategory || '').toLowerCase();
  if (r.includes('duration') || r.includes('how long') || r.includes('assessment_meta')) {
    return pickFromPool(sessionId, 'general:duration', POOLS.GENERAL_QUERY.duration);
  }
  if (r.includes('question_count') || r.includes('how many')) {
    return pickFromPool(sessionId, 'general:count', POOLS.GENERAL_QUERY.question_count);
  }
  if (r.includes('format') || r.includes('instruction')) {
    return pickFromPool(sessionId, 'general:format', POOLS.GENERAL_QUERY.format);
  }
  return pickFromPool(sessionId, 'general:redirect', POOLS.GENERAL_QUERY.default);
}

export function pickResponseForIntent(sessionId, intent, { reasoning, edgeCase, scopeCategory, irrelevant } = {}) {
  if (edgeCase && POOLS.EDGE_CASE[edgeCase]) {
    return pickFromPool(sessionId, `edge:${edgeCase}`, POOLS.EDGE_CASE[edgeCase]);
  }
  if (intent === 'GENERAL_QUERY') {
    return pickGeneralQueryResponse(sessionId, { reasoning, scopeCategory, edgeCase, irrelevant });
  }
  if (intent === 'MOVE_TO_NEXT') {
    return pickFromPool(sessionId, 'move_next', POOLS.MOVE_TO_NEXT.default);
  }
  if (intent === 'IRRELEVANT_RESPONSE') {
    return pickFromPool(sessionId, 'irrelevant', POOLS.IRRELEVANT_RESPONSE.default);
  }
  if (intent === 'NOISE_OR_UNCLEAR_INPUT') {
    return pickFromPool(sessionId, 'noise', POOLS.NOISE_OR_UNCLEAR_INPUT.default);
  }
  return { text: null, templateIndex: null };
}

export function pickSilencePrompt(sessionId) {
  return pickFromPool(sessionId, 'noise:silence', POOLS.NOISE_OR_UNCLEAR_INPUT.default);
}

export function clearSessionResponses(sessionId) {
  for (const key of [...usedBySession.keys()]) {
    if (key.startsWith(`${sessionId}:`)) usedBySession.delete(key);
  }
}
