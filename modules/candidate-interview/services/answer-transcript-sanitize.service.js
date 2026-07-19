/**
 * Remove system TTS, proctoring prompts, and question echo from answer transcripts
 * before scoring. Whisper and browser STT often capture Mission's voice from the mic.
 */

const SYSTEM_PHRASE_PATTERNS = [
  /have you finished answering the question\??/gi,
  /finished answering the question\??/gi,
  /say next to move on/gi,
  /keep talking to add more/gi,
  /keep talking to (?:them|admin|move on)/gi,
  /or keep talking/gi,
  /say to me\b/gi,
  /say to or keep talking/gi,
  /you keep talking to admin/gi,
  /excessive question repetition was detected\.?/gi,
  /please answer in your own words\.?/gi,
  /warning\.?\s*excessive question repetition/gi,
  /please (?:continue|proceed)/gi,
  /next question/gi,
  /move on to the next/gi,
  /am i audible/gi,
  /can you hear me/gi,
];

const META_UTTERANCE_RE =
  /\b(hello\??|hi\??|yes i have finished(?: my answer)?|i (?:have )?finished(?: my answer)?|please continue|next question|^next$|resume|move on|go ahead|submit answer)\b/gi;

function normalizeText(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function stripSystemPhrases(text) {
  let out = String(text || '');
  for (const pattern of SYSTEM_PHRASE_PATTERNS) {
    out = out.replace(pattern, ' ');
  }
  return normalizeText(out.replace(META_UTTERANCE_RE, ' '));
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove leading/trailing repeats of the interview question text. */
function stripQuestionEcho(questionText, text) {
  const q = normalizeText(questionText);
  let out = normalizeText(text);
  if (!q || !out) return out;

  const qLower = q.toLowerCase();
  let outLower = out.toLowerCase();

  // Remove consecutive repeated question phrases anywhere in the transcript.
  const qEscaped = escapeRegExp(qLower);
  const repeatRe = new RegExp(`(?:${qEscaped}[\\s,?.!]*){2,}`, 'gi');
  out = out.replace(repeatRe, ' ');
  outLower = out.toLowerCase();

  // Strip leading question echo (partial or full).
  for (let pass = 0; pass < 5; pass += 1) {
    if (outLower.startsWith(qLower)) {
      out = normalizeText(out.slice(q.length));
      outLower = out.toLowerCase();
      continue;
    }
    const minOverlap = Math.min(40, qLower.length);
    if (qLower.length >= 20 && outLower.startsWith(qLower.slice(0, minOverlap))) {
      const words = q.split(/\s+/);
      let removed = 0;
      for (const word of words) {
        if (!outLower.startsWith(word.toLowerCase())) break;
        removed += word.length;
        while (out[removed] === ' ') removed += 1;
      }
      if (removed > 15) {
        out = normalizeText(out.slice(removed));
        outLower = out.toLowerCase();
        continue;
      }
    }
    break;
  }

  return normalizeText(out);
}

function dedupeSentences(text) {
  const parts = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => normalizeText(s))
    .filter(Boolean);

  const seen = new Set();
  const kept = [];
  for (const sentence of parts) {
    const key = sentence.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(sentence);
  }

  if (kept.length) return kept.join(' ');
  return normalizeText(text);
}

export function meaningfulAnswerTokenCount(text) {
  const meaningless = /^(hello|hi|yes|no|next|resume|continue|please|audible|finished|answer|admin|them|move|on|say|keep|talking)$/i;
  return tokenize(text).filter((t) => !meaningless.test(t)).length;
}

/**
 * Produce candidate answer text suitable for AI scoring.
 */
export function sanitizeAnswerTranscript(rawTranscript, { questionText = '' } = {}) {
  const raw = normalizeText(rawTranscript);
  if (!raw) {
    return { cleaned: '', raw, removedChars: 0, meaningfulTokens: 0 };
  }

  let cleaned = stripSystemPhrases(raw);
  cleaned = stripQuestionEcho(questionText, cleaned);
  cleaned = dedupeSentences(cleaned);
  cleaned = stripSystemPhrases(cleaned);
  cleaned = normalizeText(cleaned);

  return {
    cleaned,
    raw,
    removedChars: Math.max(0, raw.length - cleaned.length),
    meaningfulTokens: meaningfulAnswerTokenCount(cleaned),
  };
}

/**
 * After sanitizing whisper + client transcripts, pick the richest candidate content.
 */
export function pickBestSanitizedTranscript(whisperRaw, clientRaw, { questionText = '' } = {}) {
  const whisper = sanitizeAnswerTranscript(whisperRaw, { questionText });
  const client = sanitizeAnswerTranscript(clientRaw, { questionText });

  const whisperTokens = whisper.meaningfulTokens;
  const clientTokens = client.meaningfulTokens;

  if (whisperTokens >= 3 && whisperTokens >= clientTokens) {
    return {
      transcript: whisper.cleaned,
      source: 'whisper_sanitized',
      whisperCleaned: whisper.cleaned,
      clientCleaned: client.cleaned,
      sanitization: { whisper, client },
    };
  }

  if (clientTokens >= 3) {
    return {
      transcript: client.cleaned,
      source: whisperTokens > 0 ? 'client_sanitized_preferred' : 'client_sanitized',
      whisperCleaned: whisper.cleaned,
      clientCleaned: client.cleaned,
      sanitization: { whisper, client },
    };
  }

  const fallback =
    whisper.cleaned.length >= client.cleaned.length ? whisper.cleaned : client.cleaned;

  return {
    transcript: fallback,
    source: fallback === whisper.cleaned ? 'whisper_partial_sanitized' : 'client_partial_sanitized',
    whisperCleaned: whisper.cleaned,
    clientCleaned: client.cleaned,
    sanitization: { whisper, client },
  };
}
