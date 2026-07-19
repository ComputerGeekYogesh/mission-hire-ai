/**
 * Browser thumb-rule intent pre-classifier (mirrors server assessment-intent.js).
 */
(function (global) {
  const INTENTS = {
    ANSWER: 'ANSWER',
    REPEAT_REQUEST: 'REPEAT_REQUEST',
    CLARIFICATION_REQUEST: 'CLARIFICATION_REQUEST',
    GENERAL_QUERY: 'GENERAL_QUERY',
    IRRELEVANT_RESPONSE: 'IRRELEVANT_RESPONSE',
    NOISE_OR_UNCLEAR_INPUT: 'NOISE_OR_UNCLEAR_INPUT',
    RESUME_REQUEST: 'RESUME_REQUEST',
    MOVE_TO_NEXT: 'MOVE_TO_NEXT',
  };

  function norm(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/['']/g, '')
      .replace(/[.,!?;:"()-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function looksLikeQuestion(text) {
    return /\?\s*$/.test(text) || /^(how|what|when|where|why|who|can|could|would|is|are|do|does|am|may)\b/.test(text);
  }

  function classify(input, { questionText = '', isPaused = false } = {}) {
    const raw = String(input || '').trim();
    const text = norm(raw);
    if (!text || text.length < 3) {
      return { intent: INTENTS.NOISE_OR_UNCLEAR_INPUT, confidence: 0.8 };
    }

    if (isPaused && /\b(let's resume|lets resume|ready to resume|continue the interview|pick up where)\b/.test(text)) {
      return { intent: INTENTS.RESUME_REQUEST, confidence: 0.9 };
    }
    if (!isPaused && /\b(next question|move on|skip this question|that covers it)\b/.test(text)) {
      return { intent: INTENTS.MOVE_TO_NEXT, confidence: 0.88 };
    }

    if (window.QuestionRepeatRequest?.classify?.(raw)?.isRepeatRequest) {
      return { intent: INTENTS.REPEAT_REQUEST, confidence: 0.75 };
    }

    if (/\b(explain|clarify|what do you mean|rephrase)\b/.test(text) && looksLikeQuestion(text)) {
      return { intent: INTENTS.CLARIFICATION_REQUEST, confidence: 0.88 };
    }
    if (/\b(how long|how many question|duration|time limit|format|instructions|guideline)\b/.test(text) && looksLikeQuestion(text)) {
      return { intent: INTENTS.GENERAL_QUERY, confidence: 0.88 };
    }
    if (/\b(take a break|need a break|pause|bathroom|step away)\b/.test(text)) {
      return { intent: INTENTS.GENERAL_QUERY, confidence: 0.85, edgeCase: 'CONTROL' };
    }
    if (/\b(mic|microphone|camera|video|not working|frozen|no sound|can't hear)\b/.test(text)) {
      return { intent: INTENTS.CLARIFICATION_REQUEST, confidence: 0.85, edgeCase: 'TECHNICAL' };
    }
    if (/\b(pm of|president|prime minister|news today|write a poem|career advice|capital of|tell me a joke|chatgpt)\b/.test(text)) {
      return { intent: INTENTS.GENERAL_QUERY, confidence: 0.9 };
    }
    if (/\b(give me a hint|tell me the answer|what should i say)\b/.test(text)) {
      return { intent: INTENTS.ANSWER, confidence: 0.55, edgeCase: 'HINT_REQUEST' };
    }
    if (/\b(i don't know|i do not know|no idea|not sure|can't answer)\b/.test(text)) {
      return { intent: INTENTS.ANSWER, confidence: 0.55, edgeCase: 'DONT_KNOW' };
    }
    if (/\b(fuck|shit|damn|asshole|stupid interview)\b/i.test(raw)) {
      return { intent: INTENTS.ANSWER, confidence: 0.55, edgeCase: 'PROFANITY' };
    }
    if (looksLikeQuestion(text)) {
      return { intent: INTENTS.GENERAL_QUERY, confidence: 0.72 };
    }
    const words = text.split(/\s+/).length;
    if (words >= 5 && !looksLikeQuestion(text)) {
      return { intent: INTENTS.ANSWER, confidence: 0.55 };
    }
    return { intent: INTENTS.ANSWER, confidence: 0.3 };
  }

  global.AssessmentIntentClient = { classify, INTENTS };
})(window);
