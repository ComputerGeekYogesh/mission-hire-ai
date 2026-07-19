/**
 * Detect when a candidate asks to hear the interview question again.
 * Separate from confirmation yes/no and from cheating "question repeated aloud" detection.
 */
import { normalizeTranscript } from './confirmation-intent.js';

const REPEAT_PHRASE_PATTERNS = [
  /\b(repeat the question|repeat that question|repeat this question)\b/,
  /\b(can you repeat|could you repeat|please repeat|kindly repeat)\b/,
  /\b(say (?:that |it )?again|ask (?:that |it )?again|say the question again)\b/,
  /\b(what was the question|what is the question|what did you ask)\b/,
  /\b(i didnt catch|i didn't catch|didnt catch the question|didn't catch the question)\b/,
  /\b(i didnt hear|i didn't hear|didnt hear the question|didn't hear the question)\b/,
  /\b(did not hear|did not catch|could not hear|couldn't hear)\b/,
  /\b(come again|pardon|sorry what|excuse me what)\b/,
  /\b(explain (?:the question|again)|clarify the question)\b/,
  /\b(one more time|once more|again please)\b/,
];

const REPEAT_TOKEN_HINTS = ['repeat', 'again', 'pardon', 'clarify'];

export const REPEAT_REQUEST_CONFIDENCE = 0.62;

export function classifyQuestionRepeatRequest(input) {
  const raw = Array.isArray(input) ? input.join(' ') : String(input || '');
  const text = normalizeTranscript(raw);
  if (!text) {
    return { isRepeatRequest: false, confidence: 0 };
  }

  let hits = 0;
  for (const pattern of REPEAT_PHRASE_PATTERNS) {
    if (pattern.test(text)) hits += 1;
  }

  const words = text.split(/\s+/).filter(Boolean);
  const tokenHit = words.some((w) => REPEAT_TOKEN_HINTS.includes(w));
  const shortRepeat =
    words.length <= 6 &&
    /\brepeat\b/.test(text) &&
    (/\bquestion\b/.test(text) || /\bplease\b/.test(text) || /\bthat\b/.test(text));

  let confidence = Math.min(1, hits * 0.38 + (tokenHit ? 0.22 : 0) + (shortRepeat ? 0.35 : 0));

  if (/\bnext\b/.test(text) && !/\brepeat\b/.test(text)) {
    confidence *= 0.35;
  }
  if (/\bresume\b/.test(text) && !/\brepeat\b/.test(text)) {
    confidence *= 0.4;
  }

  const isRepeatRequest = confidence >= REPEAT_REQUEST_CONFIDENCE;
  return { isRepeatRequest, confidence, normalized: text };
}
