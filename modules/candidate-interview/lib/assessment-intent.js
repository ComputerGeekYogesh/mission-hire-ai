/**
 * Local fallback intent classifier for video assessment candidate input.
 * Primary classification is AI-based (assessment-intent-ai.service.js).
 */
import { normalizeTranscript } from './confirmation-intent.js';
import { classifyQuestionRepeatRequest } from './question-repeat-request-intent.js';

export const ASSESSMENT_INTENTS = Object.freeze({
  ANSWER: 'ANSWER',
  REPEAT_REQUEST: 'REPEAT_REQUEST',
  CLARIFICATION_REQUEST: 'CLARIFICATION_REQUEST',
  GENERAL_QUERY: 'GENERAL_QUERY',
  IRRELEVANT_RESPONSE: 'IRRELEVANT_RESPONSE',
  NOISE_OR_UNCLEAR_INPUT: 'NOISE_OR_UNCLEAR_INPUT',
  RESUME_REQUEST: 'RESUME_REQUEST',
  MOVE_TO_NEXT: 'MOVE_TO_NEXT',
});

/** @deprecated Use REPEAT_REQUEST */
export const LEGACY_REPEAT_REQ = 'REPEAT_REQ';

const CLARIFICATION_PATTERNS = [
  { re: /\b(explain|clarify|rephrase|elaborate on|what do you mean|what does that mean)\b.*\b(question|mean|requirement|asking|asked)\b/, score: 0.9 },
  { re: /\b(can you|could you|please)\b.*\b(explain|clarify|rephrase)\b/, score: 0.88 },
  { re: /\bwhat do you mean by\b/, score: 0.92 },
  { re: /\bwhat are you asking\b/, score: 0.88 },
];

const GENERAL_QUERY_PATTERNS = [
  { re: /\b(who is|who's)\b.*\b(pm|president|prime minister|ceo|minister)\b/, score: 0.95, category: 'general_knowledge' },
  { re: /\b(what happened|news today|headlines|current events)\b/, score: 0.93, category: 'current_events' },
  { re: /\b(what job|which job|should i apply|career advice|salary|offer letter)\b/, score: 0.9, category: 'personal_advice' },
  { re: /\b(write|compose|create)\b.*\b(poem|story|essay|code for me|solve this)\b/, score: 0.92, category: 'unrelated_task' },
  { re: /\b(capital of|population of|weather in|score of the match)\b/, score: 0.88, category: 'general_knowledge' },
  { re: /\b(recipe|cook|movie recommendation|best restaurant|tell me a joke)\b/, score: 0.85, category: 'general_knowledge' },
  { re: /\b(what is chatgpt|what is ai|what is artificial intelligence)\b/, score: 0.9, category: 'general_knowledge' },
  { re: /\b(how long|how much time|duration|time limit)\b.*\b(assessment|interview|test|take|last)\b/, score: 0.88, category: 'assessment_meta' },
  { re: /\b(how many|number of|total)\b.*\b(question|questions)\b/, score: 0.9, category: 'assessment_meta' },
];

const TECHNICAL_PATTERNS = [
  { re: /\b(mic|microphone|audio|sound|voice|hear me|cant hear|can't hear|not audible)\b.*\b(not|no|broken|issue|problem|working|work)\b/, score: 0.92 },
  { re: /\b(camera|video|webcam|screen|display)\b.*\b(not|no|broken|issue|problem|working|black|frozen)\b/, score: 0.92 },
  { re: /\b(frozen|stuck|lagging|disconnect|connection|internet|network)\b/, score: 0.85 },
  { re: /\b(technical issue|tech issue|something wrong|not working|broken|glitch|error)\b/, score: 0.88 },
  { re: /\b(can't hear|cannot hear|no sound|no audio)\b/, score: 0.9 },
];

const CONTROL_PATTERNS = [
  { re: /\b(take a break|need a break|pause|can i pause|hold on a minute|give me a minute)\b/, score: 0.92 },
  { re: /\b(bathroom|restroom|water break|step away|be right back|brb)\b/, score: 0.88 },
];

const RESUME_PATTERNS = [
  { re: /\b(let's resume|lets resume|okay resume|ok resume|ready to resume)\b/, score: 0.94 },
  { re: /\b(continue (the )?interview|pick up where we left|back to the question)\b/, score: 0.9 },
  { re: /^\s*resume\s*$/i, score: 0.92 },
  { re: /\b(i am ready|im ready|ready when you are)\b.*\b(continue|resume|go ahead)\b/, score: 0.88 },
];

const MOVE_TO_NEXT_PATTERNS = [
  { re: /\b(next question|move on|move to the next|skip (this )?question|go to the next)\b/, score: 0.93 },
  { re: /\b(that covers it|that is all|i think that is enough|i think that covers)\b.*\b(next|move on|please)\b/, score: 0.9 },
  { re: /\b(i am done|i'm done|finished answering|done with (this|that))\b.*\b(next|move on)?\b/, score: 0.88 },
  { re: /^\s*next\s*$/i, score: 0.85 },
];

const INTERVIEW_CONTEXT_PATTERNS = [
  { re: /\b(team size|how big is the team|how many people|tech stack|technologies|tools used)\b/, score: 0.9, category: 'role_context' },
  { re: /\b(remote|hybrid|work from home|on site|office location)\b/, score: 0.88, category: 'role_context' },
  { re: /\b(what does the role|day to day|responsibilities|reporting to|who would i work)\b/, score: 0.9, category: 'role_context' },
  { re: /\b(what happens after|next steps|when will i hear|feedback timeline|hiring process)\b/, score: 0.88, category: 'process_context' },
  { re: /\b(company culture|about the company|what is the company)\b/, score: 0.85, category: 'company_context' },
];

const EDGE_DONT_KNOW = [
  /\b(i (?:do not|don't) know|no idea|not sure|can't answer|cannot answer|dont know)\b/,
  /\b(no experience|never done|not familiar)\b/,
];

const EDGE_PROFANITY = [
  /\b(fuck|shit|damn|bitch|asshole|bastard|crap)\b/i,
  /\b(stupid|idiot|dumb)\b.*\b(assessment|interview|this|you)\b/i,
];

const EDGE_HINT = [
  /\b(give me a hint|any hints|what should i say|help me answer|tell me the answer)\b/,
  /\b(what is the (?:right|correct) answer|how should i answer)\b/,
];

function scorePatterns(text, patterns) {
  let best = { score: 0, reason: null, category: null };
  for (const p of patterns) {
    if (p.re.test(text)) {
      if (p.score > best.score) {
        best = { score: p.score, reason: p.reason || p.category || 'pattern_match', category: p.category || null };
      }
    }
  }
  return best;
}

function questionOverlapScore(text, questionText) {
  const q = normalizeTranscript(questionText || '');
  if (!q || q.length < 8) return 0;
  const words = q.split(/\s+/).filter((w) => w.length > 3);
  if (!words.length) return 0;
  let hits = 0;
  for (const w of words) {
    if (text.includes(w)) hits += 1;
  }
  return Math.min(0.85, hits / Math.min(words.length, 12));
}

function looksLikeQuestion(text) {
  return (
    /\?\s*$/.test(text) ||
    /^(how|what|when|where|why|who|can|could|would|is|are|do|does|am|may)\b/.test(text)
  );
}

function isNoiseOrUnclear(text, raw) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.length === 1 && words[0].length <= 3) return true;
  if (/^(uh+|um+|hmm+|ah+|er+|hm+)$/i.test(text.replace(/\s+/g, ''))) return true;
  if (raw.length < 4) return true;
  return false;
}

/**
 * @param {string} input - Raw candidate speech/text
 * @param {{ questionText?: string, questionId?: number|null, isPaused?: boolean }} [currentQuestion]
 */
export function classifyIntent(input, currentQuestion = {}) {
  const raw = String(input || '').trim();
  const text = normalizeTranscript(raw);
  const questionText = String(currentQuestion.questionText || currentQuestion.question_text || '').trim();
  const isPaused = !!currentQuestion.isPaused;

  if (isNoiseOrUnclear(text, raw)) {
    return {
      intent: ASSESSMENT_INTENTS.NOISE_OR_UNCLEAR_INPUT,
      confidence: 0.85,
      reasoning: 'noise_or_unclear_local',
      edgeCase: null,
    };
  }

  const candidates = [];

  if (isPaused) {
    const resume = scorePatterns(text, RESUME_PATTERNS);
    if (resume.score >= 0.82) {
      candidates.push({
        intent: ASSESSMENT_INTENTS.RESUME_REQUEST,
        confidence: resume.score,
        reasoning: resume.reason || 'resume_request_patterns',
      });
    }
  }

  const moveNext = scorePatterns(text, MOVE_TO_NEXT_PATTERNS);
  if (!isPaused && moveNext.score >= 0.82) {
    candidates.push({
      intent: ASSESSMENT_INTENTS.MOVE_TO_NEXT,
      confidence: moveNext.score,
      reasoning: moveNext.reason || 'move_to_next_patterns',
    });
  }

  const repeat = classifyQuestionRepeatRequest(raw);
  if (repeat.isRepeatRequest) {
    candidates.push({
      intent: ASSESSMENT_INTENTS.REPEAT_REQUEST,
      confidence: repeat.confidence,
      reasoning: 'repeat_request_patterns',
    });
  }

  const clarification = scorePatterns(text, CLARIFICATION_PATTERNS);
  if (clarification.score >= 0.82) {
    candidates.push({
      intent: ASSESSMENT_INTENTS.CLARIFICATION_REQUEST,
      confidence: clarification.score,
      reasoning: clarification.reason,
    });
  }

  for (const edge of [
    { type: 'DONT_KNOW', patterns: EDGE_DONT_KNOW },
    { type: 'PROFANITY', patterns: EDGE_PROFANITY },
    { type: 'HINT_REQUEST', patterns: EDGE_HINT },
  ]) {
    if (edge.patterns.some((p) => p.test(text))) {
      candidates.push({
        intent: ASSESSMENT_INTENTS.ANSWER,
        confidence: 0.55,
        reasoning: `edge_${edge.type.toLowerCase()}`,
        edgeCase: edge.type,
      });
    }
  }

  const technical = scorePatterns(text, TECHNICAL_PATTERNS);
  if (technical.score >= 0.82) {
    candidates.push({
      intent: ASSESSMENT_INTENTS.CLARIFICATION_REQUEST,
      confidence: technical.score * 0.95,
      reasoning: `technical:${technical.reason}`,
      edgeCase: 'TECHNICAL',
    });
  }

  const control = scorePatterns(text, CONTROL_PATTERNS);
  if (control.score >= 0.82) {
    candidates.push({
      intent: ASSESSMENT_INTENTS.GENERAL_QUERY,
      confidence: control.score * 0.9,
      reasoning: `control:${control.reason}`,
      edgeCase: 'CONTROL',
    });
  }

  const general = scorePatterns(text, GENERAL_QUERY_PATTERNS);
  if (general.score >= 0.82) {
    candidates.push({
      intent: ASSESSMENT_INTENTS.GENERAL_QUERY,
      confidence: general.score,
      reasoning: general.reason,
      scopeCategory: general.category,
      generalRelevance: general.category === 'assessment_meta' ? 'relevant' : 'irrelevant',
    });
  }

  const roleContext = scorePatterns(text, INTERVIEW_CONTEXT_PATTERNS);
  if (roleContext.score >= 0.82 && looksLikeQuestion(text)) {
    candidates.push({
      intent: ASSESSMENT_INTENTS.GENERAL_QUERY,
      confidence: roleContext.score,
      reasoning: roleContext.reason,
      scopeCategory: roleContext.category,
      generalRelevance: 'relevant',
    });
  }

  if (looksLikeQuestion(text) && clarification.score < 0.5 && general.score < 0.5 && repeat.confidence < 0.55) {
    candidates.push({
      intent: ASSESSMENT_INTENTS.GENERAL_QUERY,
      confidence: 0.68,
      reasoning: 'interrogative_without_answer_signals',
    });
  }

  const overlap = questionOverlapScore(text, questionText);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const answerScore = Math.min(0.95, overlap * 0.55 + Math.min(wordCount / 40, 0.35));

  if (!looksLikeQuestion(text) && wordCount >= 4) {
    candidates.push({
      intent: ASSESSMENT_INTENTS.ANSWER,
      confidence: Math.max(0.42, answerScore),
      reasoning: overlap > 0.15 ? 'semantic_overlap_with_question' : 'declarative_substantive_utterance',
    });
  }

  if (!looksLikeQuestion(text) && wordCount >= 6 && overlap < 0.08 && answerScore < 0.35) {
    candidates.push({
      intent: ASSESSMENT_INTENTS.IRRELEVANT_RESPONSE,
      confidence: 0.62,
      reasoning: 'substantive_but_low_question_overlap',
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  const top = candidates[0];
  if (top && top.confidence >= 0.72) {
    return {
      intent: top.intent,
      confidence: top.confidence,
      reasoning: top.reasoning,
      edgeCase: top.edgeCase || null,
      scopeCategory: top.scopeCategory || null,
      generalRelevance: top.generalRelevance || null,
      candidates: candidates.slice(0, 5),
      source: 'local',
    };
  }

  const topAnswer = candidates.find((c) => c.intent === ASSESSMENT_INTENTS.ANSWER);
  if (topAnswer && topAnswer.confidence >= 0.38 && !looksLikeQuestion(text)) {
    return {
      intent: ASSESSMENT_INTENTS.ANSWER,
      confidence: topAnswer.confidence,
      reasoning: topAnswer.reasoning,
      edgeCase: topAnswer.edgeCase || null,
      candidates: candidates.slice(0, 5),
      source: 'local',
    };
  }

  return {
    intent: ASSESSMENT_INTENTS.ANSWER,
    confidence: Math.max(0.25, topAnswer?.confidence || 0.25),
    reasoning: 'low_signal_default_answer',
    ambiguous: true,
    candidates: candidates.slice(0, 5),
    source: 'local',
  };
}

const VALID_INTENT_SET = new Set(Object.values(ASSESSMENT_INTENTS));

export function normalizeAssessmentIntent(intent) {
  if (intent === LEGACY_REPEAT_REQ || intent === 'REPEAT_REQ') return ASSESSMENT_INTENTS.REPEAT_REQUEST;
  if (intent === 'META_QUERY' || intent === 'OUT_OF_SCOPE') return ASSESSMENT_INTENTS.GENERAL_QUERY;
  if (VALID_INTENT_SET.has(intent)) return intent;
  return ASSESSMENT_INTENTS.ANSWER;
}
