/**
 * Confirmation intent classification for "Have you finished answering?"
 */
import { classifyQuestionRepeatRequest } from './question-repeat-request-intent.js';

const FILLER_RE = /\b(um+|uh+|er+|erm+|hm+|hmm+|like|you know|i mean|sort of|kind of)\b/gi;

const STT_FIXES = [
  [/\byas+\b/g, 'yes'],
  [/\bya+\b/g, 'yeah'],
  [/\byaa+\b/g, 'yeah'],
  [/\byah+\b/g, 'yeah'],
  [/\byea+\b/g, 'yeah'],
  [/\boke+\b/g, 'okay'],
  [/\boky\b/g, 'okay'],
  [/\bokai\b/g, 'okay'],
  [/\bcontinew\b/g, 'continue'],
  [/\bcontineu\b/g, 'continue'],
  [/\bproced\b/g, 'proceed'],
  [/\bnxt\b/g, 'next'],
  [/\bpls\b/g, 'please'],
  [/\bplz\b/g, 'please'],
  [/\bpleez\b/g, 'please'],
  [/\bples\b/g, 'please'],
  [/\bmov\b/g, 'move'],
  [/\bredy\b/g, 'ready'],
  [/\bfinsh(ed)?\b/g, 'finish'],
  [/\bcomplet(ed)?\b/g, 'complete'],
  [/\bgohed\b/g, 'go ahead'],
  [/\bgoheda\b/g, 'go ahead'],
  [/\bgo on\b/g, 'go ahead'],
];

const INSTANT_YES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'next', 'done', 'continue',
  'proceed', 'ready', 'alright', 'submit', 'go', 'move',
]);

const YES_PHRASE_PATTERNS = [
  /\b(yes|yeah|yep|yup|sure|ok|okay|alright|affirmative)\b/,
  /\b(go ahead|move on|move ahead|carry on|go on)\b/,
  /\b(proceed|continue|next|submit)\b/,
  /\b(next question|move forward|ask next)\b/,
  /\b(sounds good|lets proceed|let's proceed|lets go|let's go)\b/,
  /\b(i am done|im done|all done|finished|completed|done answering)\b/,
  /\b(you can continue|please continue|please move|yes please)\b/,
  /\b(i am ready|im ready|ready to continue)\b/,
  /\b(that is it|thats it|that's it)\b/,
  /\b(yes move|yes next|yes go|yeah please|okay continue)\b/,
  /\b(hmm yes|um yes)\b/,
];

const NO_PHRASE_PATTERNS = [
  /\b(resume|resume to continue)\b/,
  /\b(no|nope|nah)\b/,
  /\b(not yet|not done|not finished)\b/,
  /\b(wait|hold on|hang on|one moment)\b/,
  /\b(give me a moment|more time|need more time|need time)\b/,
  /\b(skip for now|skip this)\b/,
  /\b(i am thinking|im thinking|still thinking|thinking)\b/,
  /\b(let me)\b.*\b(finish|continue|add|think)\b/,
  /\b(keep going|keep answering)\b/,
];

const AMBIGUOUS_PATTERNS = [
  /\b(maybe|perhaps|not sure|unsure|i guess)\b/,
  /\b(hmm maybe)\b/,
];

const YES_TOKENS = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'next', 'done', 'move', 'go',
  'submit', 'continue', 'proceed', 'ready', 'finish', 'finished', 'complete', 'alright',
];

const NO_TOKENS = [
  'resume', 'no', 'nope', 'nah', 'wait', 'stop', 'hold', 'repeat', 'explain', 'skip', 'thinking',
];

export const CONFIDENCE_PROCEED = 0.65;
export const CONFIDENCE_CLARIFY = 0.45;
export const CONFIDENCE_HIGH = CONFIDENCE_PROCEED;
export const CONFIDENCE_MEDIUM = CONFIDENCE_CLARIFY;

function tierFromConfidence(confidence) {
  if (confidence >= CONFIDENCE_PROCEED) return 'high';
  if (confidence >= CONFIDENCE_CLARIFY) return 'medium';
  return 'low';
}

export function normalizeTranscript(text) {
  let t = String(text || '').toLowerCase();
  t = t.replace(/['']/g, '');
  t = t.replace(FILLER_RE, ' ');
  for (const [re, rep] of STT_FIXES) {
    t = t.replace(re, rep);
  }
  t = t.replace(/(.)\1{2,}/g, '$1$1');
  t = t.replace(/[.,!?;:"()-]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function isConfirmationPromptEcho(text) {
  const t = normalizeTranscript(text);
  if (!t || t.length < 8) return false;
  const wordCount = t.split(/\s+/).filter(Boolean).length;

  if (/\bhave you finished\b/.test(t) && wordCount >= 5) return true;
  if (/\bfinished answering\b/.test(t) && /\b(question|move on|continue)\b/.test(t)) return true;
  if (/\bsay next\b/.test(t) && /\bresume\b/.test(t) && wordCount >= 4) return true;
  if (/\bmove on or resume\b/.test(t)) return true;
  if (/\bnext to move on\b/.test(t) && /\bresume to continue\b/.test(t)) return true;
  if (/\bresume to keep answering\b/.test(t)) return true;
  if (/\bresume to continue\b/.test(t) && wordCount >= 4) return true;
  if (/\b5 minutes are up\b/.test(t)) return true;
  if (/\bwould you like me to move to the next question\b/.test(t)) return true;

  const hasNextCue = /\b(next|move on)\b/.test(t);
  const hasResumeCue = /\bresume\b/.test(t);
  if (hasNextCue && hasResumeCue && wordCount >= 7) return true;

  return false;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(row[j] + 1, prev + 1, row[j - 1] + cost);
      row[j - 1] = prev;
      prev = val;
    }
    row[n] = prev;
  }
  return row[n];
}

function fuzzyTokenScore(word, dictionary) {
  if (!word || word.length < 2) return 0;
  if (dictionary.includes(word)) return 1;
  let best = 0;
  for (const canon of dictionary) {
    const maxDist = canon.length <= 3 ? 1 : canon.length <= 6 ? 2 : 3;
    const d = levenshtein(word, canon);
    if (d <= maxDist) {
      const sim = 1 - d / Math.max(word.length, canon.length);
      best = Math.max(best, sim);
    }
  }
  return best >= 0.68 ? best : 0;
}

function instantYesBoost(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  if (words.length === 1 && INSTANT_YES.has(words[0])) return 1;
  if (words.every((w) => INSTANT_YES.has(w) || fuzzyTokenScore(w, YES_TOKENS) >= 0.85)) {
    return 0.98;
  }
  if (words.some((w) => INSTANT_YES.has(w)) && !words.some((w) => NO_TOKENS.includes(w))) {
    return 0.92;
  }
  return 0;
}

function patternScore(text, patterns, weightEach = 0.32) {
  let hits = 0;
  for (const p of patterns) {
    if (p.test(text)) hits += 1;
  }
  return Math.min(1, hits * weightEach);
}

function tokenScores(text) {
  const words = text.split(/\s+/).filter(Boolean);
  let yes = 0;
  let no = 0;
  for (const w of words) {
    yes = Math.max(yes, fuzzyTokenScore(w, YES_TOKENS));
    no = Math.max(no, fuzzyTokenScore(w, NO_TOKENS));
  }
  const joined = words.join(' ');
  for (const phrase of ['go ahead', 'move on', 'not yet', 'hold on', 'next question', 'go on']) {
    if (joined.includes(phrase)) {
      if (phrase.includes('not') || phrase.includes('hold')) no = Math.max(no, 0.95);
      else yes = Math.max(yes, 0.95);
    }
  }
  return { yes, no };
}

export function classifyConfirmation(input) {
  const raw = Array.isArray(input) ? input.join(' ') : String(input || '');
  const text = normalizeTranscript(raw);
  if (!text) {
    return { intent: 'UNCLEAR', confidence: 0, tier: 'low' };
  }

  if (isConfirmationPromptEcho(text)) {
    return { intent: 'UNCLEAR', confidence: 0, tier: 'low' };
  }

  const repeatCheck = classifyQuestionRepeatRequest(text);
  if (repeatCheck.isRepeatRequest) {
    return {
      intent: 'REPEAT_QUESTION',
      confidence: repeatCheck.confidence,
      tier: tierFromConfidence(repeatCheck.confidence),
    };
  }

  const instant = instantYesBoost(text);
  const ambiguous = patternScore(text, AMBIGUOUS_PATTERNS, 0.5);
  const yesPhrase = patternScore(text, YES_PHRASE_PATTERNS, 0.34);
  const noPhrase = patternScore(text, NO_PHRASE_PATTERNS, 0.35);
  const { yes: yesTok, no: noTok } = tokenScores(text);

  let yesScore = Math.max(instant, yesPhrase, yesTok);
  let noScore = Math.max(noPhrase, noTok);

  if (/\bresume\b/.test(text) && text.split(/\s+/).length <= 4) {
    noScore = Math.max(noScore, 0.95);
  }

  if (/\bno\b/.test(text) && !/\byes\b/.test(text) && !/\byeah\b/.test(text)) {
    noScore = Math.max(noScore, 0.9);
  }

  const wordCount = text.split(/\s+/).length;
  if (wordCount <= 4 && yesScore >= 0.35 && noScore < 0.5) {
    yesScore = Math.min(1, yesScore + 0.15);
  }

  if (ambiguous >= 0.5 && yesScore < 0.75 && noScore < 0.6) {
    return { intent: 'UNCLEAR', confidence: 0.45, tier: 'medium' };
  }

  if (noScore >= 0.42 && noScore >= yesScore) {
    const confidence = Math.min(1, noScore);
    return { intent: 'NO', confidence, tier: tierFromConfidence(confidence) };
  }

  if (yesScore >= 0.38) {
    const confidence = Math.min(1, yesScore);
    return { intent: 'YES', confidence, tier: tierFromConfidence(confidence) };
  }

  return {
    intent: 'UNCLEAR',
    confidence: Math.max(0.15, Math.max(yesScore, noScore) * 0.45),
    tier: 'low',
  };
}

export function localIntentMatch(alternatives) {
  const result = classifyConfirmation(alternatives);
  if (result.intent === 'UNCLEAR' || result.confidence < CONFIDENCE_PROCEED) return null;
  return result.intent;
}

export function interimIndicatesYes(interimText) {
  const r = classifyConfirmation(interimText);
  return r.intent === 'YES' && r.confidence >= CONFIDENCE_PROCEED;
}

export function shouldProceed(result) {
  return result && result.intent !== 'UNCLEAR' && result.confidence >= CONFIDENCE_PROCEED;
}
