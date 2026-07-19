window.InterviewQuestionRepeatDetect = (function () {
  const META_PHRASE_RE =
    /\b(hello|hi|am i audible|can you hear me|yes i have finished|please continue|next question|next|resume|move on|go ahead)\b/gi;

  function normalizeForSimilarity(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenSet(text) {
    return new Set(
      normalizeForSimilarity(text)
        .split(' ')
        .filter((t) => t.length > 2)
    );
  }

  function bigrams(text) {
    const words = normalizeForSimilarity(text).split(' ').filter(Boolean);
    const grams = [];
    for (let i = 0; i < words.length - 1; i++) {
      grams.push(`${words[i]} ${words[i + 1]}`);
    }
    return grams;
  }

  function longestConsecutiveTokenRun(questionText, answerText) {
    const qWords = normalizeForSimilarity(questionText).split(' ').filter((w) => w.length > 2);
    const aWords = normalizeForSimilarity(answerText).split(' ').filter((w) => w.length > 2);
    if (!qWords.length || !aWords.length) return 0;

    let maxRun = 0;
    for (let i = 0; i < qWords.length; i++) {
      for (let j = 0; j < aWords.length; j++) {
        let run = 0;
        while (qWords[i + run] && aWords[j + run] && qWords[i + run] === aWords[j + run]) {
          run += 1;
        }
        if (run > maxRun) maxRun = run;
      }
    }
    return maxRun;
  }

  function detect(questionText, answerText) {
    const qNorm = normalizeForSimilarity(questionText);
    const aNorm = normalizeForSimilarity(String(answerText || '').replace(META_PHRASE_RE, ' '));
    if (!qNorm || qNorm.length < 12 || !aNorm || aNorm.length < 8) {
      return { repeated: false, overlapRatio: 0, phraseRatio: 0 };
    }

    const q = tokenSet(qNorm);
    const a = tokenSet(aNorm);
    if (!q.size || !a.size) return { repeated: false, overlapRatio: 0, phraseRatio: 0 };

    let overlap = 0;
    q.forEach((t) => {
      if (a.has(t)) overlap += 1;
    });
    const overlapRatio = overlap / q.size;

    const qBi = bigrams(qNorm);
    const aBiSet = new Set(bigrams(aNorm));
    let phraseHits = 0;
    qBi.forEach((g) => {
      if (aBiSet.has(g)) phraseHits += 1;
    });
    const phraseRatio = qBi.length ? phraseHits / qBi.length : 0;
    const extraAnswerTokens = [...a].filter((t) => !q.has(t)).length;
    const longestRun = longestConsecutiveTokenRun(qNorm, aNorm);

    const repeated =
      (overlapRatio >= 0.32 && phraseRatio >= 0.18 && extraAnswerTokens <= 20) ||
      (overlapRatio >= 0.42 && extraAnswerTokens <= 24) ||
      (phraseRatio >= 0.3 && overlapRatio >= 0.22) ||
      longestRun >= 4;

    return { repeated, overlapRatio, phraseRatio, extraAnswerTokens, longestRun };
  }

  return { detect, normalizeForSimilarity };
})();
