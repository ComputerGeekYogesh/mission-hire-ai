/**
 * Shared speech for device checks, greetings, questions, and confirmation prompts.
 * Uses Vapi assistant voice (server-side TTS) when configured; falls back to browser speech.
 */
window.InterviewVoice = (function () {
  const VOICE_LANG = 'en-IN';
  const VOICE_LOAD_TIMEOUT_MS = 1200;
  const SERVER_TTS_FETCH_TIMEOUT_MS = 3500;
  const prefetchInFlight = new Map();
  const ttsFailedTexts = new Set();

  let enabled = true;
  let lastSpoken = '';
  let lastAt = 0;
  let cachedVoice = null;
  let voicesReadyPromise = null;
  let currentAudio = null;
  let serverTtsAvailable = window.INTERVIEW_USE_VAPI_TTS === true;
  let speechQueue = Promise.resolve();
  let speakingCount = 0;
  const idleListeners = new Set();
  /** @type {Map<string, { url?: string, promise?: Promise<string|null>, blob?: Blob }>} */
  const ttsCache = new Map();

  function notifyIdleIfReady() {
    if (speakingCount > 0) return;
    idleListeners.forEach((fn) => {
      try {
        fn();
      } catch (_) {}
    });
  }

  function addIdleListener(fn) {
    if (typeof fn === 'function') idleListeners.add(fn);
    return () => idleListeners.delete(fn);
  }

  function isSpeaking() {
    return speakingCount > 0;
  }

  function canSpeak() {
    return enabled && (serverTtsAvailable || typeof window.speechSynthesis !== 'undefined');
  }

  function stopPlayback() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
    try {
      window.speechSynthesis?.cancel();
    } catch (_) {}
  }

  function enqueueSpeech(task, opts = {}) {
    if (opts.interrupt || opts.queue === false) {
      stopPlayback();
      speechQueue = Promise.resolve();
    }

    const run = speechQueue.then(async () => {
      speakingCount += 1;
      try {
        return await task();
      } finally {
        speakingCount = Math.max(0, speakingCount - 1);
        notifyIdleIfReady();
      }
    }, async () => {
      speakingCount += 1;
      try {
        return await task();
      } finally {
        speakingCount = Math.max(0, speakingCount - 1);
        notifyIdleIfReady();
      }
    });
    speechQueue = run.catch(() => {});
    return run;
  }

  function resetQueue() {
    stopPlayback();
    speechQueue = Promise.resolve();
  }

  function waitUntilIdle() {
    return speechQueue.catch(() => {});
  }

  function scoreVoice(v) {
    const lang = String(v.lang || '').toLowerCase();
    const name = String(v.name || '').toLowerCase();
    let score = 0;

    if (lang === 'en-in' || lang.startsWith('en-in')) score += 100;
    else if (/\bindia\b|\bindian\b/.test(name)) score += 85;

    if (/\bneerja\b|\bpriya\b|\bswara\b/.test(name)) score += 40;
    if (/\bfemale\b|\bwoman\b/.test(name)) score += 28;

    if (/\bravi\b|\bmale\b|\bdavid\b/.test(name)) score -= 35;

    return score;
  }

  function pickVoiceFromList(voices) {
    const list = voices || [];
    if (!list.length) return null;
    const ranked = [...list].sort((a, b) => scoreVoice(b) - scoreVoice(a));
    return (
      ranked[0] ||
      list.find((v) => String(v.lang || '').toLowerCase().startsWith('en-in')) ||
      list.find((v) => String(v.lang || '').toLowerCase().startsWith('en')) ||
      list[0]
    );
  }

  function refreshCachedVoice() {
    if (typeof window.speechSynthesis === 'undefined') return null;
    cachedVoice = pickVoiceFromList(window.speechSynthesis.getVoices());
    return cachedVoice;
  }

  function ensureBrowserVoicesLoaded() {
    if (typeof window.speechSynthesis === 'undefined') return Promise.resolve(null);
    if (cachedVoice) return Promise.resolve(cachedVoice);
    if (voicesReadyPromise) return voicesReadyPromise;

    voicesReadyPromise = new Promise((resolve) => {
      const finish = () => resolve(refreshCachedVoice());
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        finish();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.speechSynthesis.removeEventListener('voiceschanged', onChange);
        finish();
      };
      const onChange = () => done();
      window.speechSynthesis.addEventListener('voiceschanged', onChange);
      window.speechSynthesis.getVoices();
      setTimeout(done, VOICE_LOAD_TIMEOUT_MS);
    }).finally(() => {
      voicesReadyPromise = null;
    });

    return voicesReadyPromise;
  }

  function speakBrowser(text, opts = {}) {
    return ensureBrowserVoicesLoaded().then(
      () =>
        new Promise((resolve) => {
          const u = new SpeechSynthesisUtterance(text);
          const voice = cachedVoice || refreshCachedVoice();
          u.lang = voice?.lang || opts.lang || VOICE_LANG;
          u.rate = opts.rate ?? 0.82;
          u.volume = opts.volume ?? 0.9;
          if (voice) u.voice = voice;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          u.onend = finish;
          u.onerror = finish;
          u.onstart = () => {
            opts.onPlaybackStart?.();
          };
          const maxMs =
            opts.maxMs ??
            Math.min(90000, Math.max(8000, Math.round(text.length * (opts.msPerChar ?? 70))));
          setTimeout(finish, maxMs);
          try {
            window.speechSynthesis.resume();
          } catch (_) {}
          window.speechSynthesis.speak(u);
        })
    );
  }

  /**
   * Server TTS: same voice as Vapi assistant (ElevenLabs / Azure en-IN / OpenAI from dashboard).
   */
  async function fetchTtsBlob(text) {
    const token = window.INTERVIEW_TOKEN;
    if (!token || !serverTtsAvailable || ttsFailedTexts.has(text)) return null;

    const cached = ttsCache.get(text);
    if (cached?.url && cached.blob) {
      return cached.blob;
    }
    if (cached?.promise) {
      await cached.promise;
      const hit = ttsCache.get(text);
      return hit?.blob || null;
    }

    const fetchPromise = (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SERVER_TTS_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`/interview/${encodeURIComponent(token)}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 402 || res.status === 503 || res.status >= 500) {
            serverTtsAvailable = false;
          }
          ttsFailedTexts.add(text);
          return null;
        }
        const blob = await res.blob();
        if (!blob.size) {
          ttsFailedTexts.add(text);
          return null;
        }
        const url = URL.createObjectURL(blob);
        ttsCache.set(text, { url, blob });
        return url;
      } catch (e) {
        if (e?.name === 'AbortError') {
          console.warn('[InterviewVoice] Server TTS timed out — using browser voice');
        }
        serverTtsAvailable = false;
        ttsFailedTexts.add(text);
        return null;
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    ttsCache.set(text, { promise: fetchPromise });
    const url = await fetchPromise;
    if (!url) {
      ttsCache.delete(text);
      return null;
    }
    return ttsCache.get(text)?.blob || null;
  }

  /**
   * Warm server TTS cache while the room is idle so Start Call does not wait on synthesis.
   */
  function prefetchTts(text) {
    const t = String(text || '').trim();
    if (!t || ttsFailedTexts.has(t)) return Promise.resolve(null);
    if (!serverTtsAvailable) return Promise.resolve(null);
    if (ttsCache.get(t)?.url) return Promise.resolve(ttsCache.get(t).url);
    if (prefetchInFlight.has(t)) return prefetchInFlight.get(t);

    console.log(`[interview-startup] TTS prefetch queued (${t.length} chars)`);
    const run = fetchTtsBlob(t)
      .then((blob) => {
        if (blob) {
          console.log(`[interview-startup] TTS prefetch ready +${Math.round(performance.now())}ms`);
        } else {
          console.log(
            `[interview-startup] TTS prefetch skipped (server unavailable) +${Math.round(performance.now())}ms`
          );
        }
        return ttsCache.get(t)?.url || null;
      })
      .finally(() => {
        prefetchInFlight.delete(t);
      });
    prefetchInFlight.set(t, run);
    return run;
  }

  async function speakViaServer(text, opts = {}) {
    if (opts.interrupt) stopPlayback();

    try {
      const blob = await fetchTtsBlob(text);
      if (!blob) return false;

      const url = ttsCache.get(text)?.url || URL.createObjectURL(blob);
      await new Promise((resolve) => {
        const audio = new Audio(url);
        currentAudio = audio;
        audio.volume = opts.volume ?? 0.9;
        audio.playbackRate = opts.playbackRate ?? 0.92;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (currentAudio === audio) currentAudio = null;
          resolve();
        };
        audio.onended = finish;
        audio.onerror = finish;
        audio.onplaying = () => {
          opts.onPlaybackStart?.();
        };
        audio.play()
          .then(() => {
            if (audio.paused) return;
            opts.onPlaybackStart?.();
          })
          .catch(finish);
        const maxMs =
          opts.maxMs ??
          Math.min(90000, Math.max(8000, Math.round(text.length * (opts.msPerChar ?? 70))));
        setTimeout(finish, maxMs);
      });
      return true;
    } catch (e) {
      console.warn('[InterviewVoice] Vapi TTS request failed:', e.message || e);
      return false;
    }
  }

  /**
   * @param {string} text
   * @param {{ interrupt?: boolean, rate?: number, volume?: number, minGapMs?: number, maxMs?: number, msPerChar?: number }} opts
   */
  async function speak(text, opts = {}) {
    const t = String(text || '').trim();
    if (!t) {
      if (opts.proctor) console.warn('[PROCTORING] Audio playback skipped: empty text');
      return false;
    }
    if (!canSpeak()) {
      if (opts.proctor) {
        console.warn('[PROCTORING] Audio playback failed');
        console.warn('[PROCTORING] Error: Speech synthesis unavailable (disabled or unsupported)');
      }
      return false;
    }

    const minGap = opts.proctor ? 0 : (opts.minGapMs ?? 1200);
    const now = Date.now();
    if (!opts.interrupt && !opts.proctor && t === lastSpoken && now - lastAt < minGap) {
      return false;
    }

    return enqueueSpeech(async () => {
      if (opts.interrupt) stopPlayback();

      if (serverTtsAvailable) {
        const ok = await speakViaServer(t, opts);
        if (ok) {
          lastSpoken = t;
          lastAt = Date.now();
          return true;
        }
      }

      await speakBrowser(t, opts);
      lastSpoken = t;
      lastAt = Date.now();
      return true;
    }, opts);
  }

  function announceChecklistItem(label, ok, detail) {
    const status = ok ? 'OK' : 'pending';
    const line = detail ? `${label}: ${detail}` : `${label}: ${status}`;
    return speak(line);
  }

  if (typeof window.speechSynthesis !== 'undefined') {
    window.speechSynthesis.onvoiceschanged = () => refreshCachedVoice();
    refreshCachedVoice();
  }

  function getCurrentAudio() {
    return currentAudio;
  }

  return {
    speak,
    prefetchTts,
    waitUntilIdle,
    isSpeaking,
    canSpeak,
    getCurrentAudio,
    addIdleListener,
    resetQueue,
    announceChecklistItem,
    ensureVoicesLoaded: ensureBrowserVoicesLoaded,
    stop: stopPlayback,
    setEnabled(on) {
      enabled = !!on;
    },
    setServerTtsEnabled(on) {
      serverTtsAvailable = !!on;
    },
  };
})();
