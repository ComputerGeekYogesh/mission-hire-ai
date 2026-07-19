/**
 * Auto-submit state machine for interview answers.
 * Flow control: persistent NEXT button + unified silence prompt.
 */
window.AutoSubmitAnswer = (function () {
  const SILENCE_THRESHOLD = 0.01;
  /** Byte-frequency average below this value = silence (0–255 scale). */
  const SILENCE_FLOOR = 10;
  const AUDIO_LEVEL_POLL_MS = 200;
  const SILENCE_THRESHOLD_MS = 10000;
  const UTTERANCE_CLASSIFY_DEBOUNCE_MS = 800;
  const META_UTTERANCE_CLASSIFY_DEBOUNCE_MS = 200;
  const MAX_RECORDING_DURATION_MS = 5 * 60 * 1000;
  const RECORDING_HEALTH_CHECK_MS = 5000;
  const NEXT_QUESTION_DELAY_MS = 2000;
  const SPEECH_RECOGNITION_LANG = 'en-US';
  const RECOGNITION_RETRY_MS = 400;
  const INTENT_LISTEN_MS = 15000;
  /** Ignore advance-intent matches briefly after prompt TTS (mic echo). */
  const INTENT_POST_PROMPT_ECHO_GUARD_MS = 1800;
  const QUESTION_PLAYING_HARD_CAP_MS = 60000;
  const DEFAULT_QUESTION_AUDIO_MS = 10000;

  const UNIFIED_PROMPT_TEXT =
    'Have you finished answering the question? Say next to move on, or keep talking to add more.';

  const EXACT_INTENTS = [
    'next',
    'next question',
    'next to move on',
    'move to next',
    'move on',
    'go next',
    'go to next',
    'proceed',
    'skip',
    'skip this',
    'skip question',
    'done',
    'done with this',
    'all done',
    "i'm done",
    'im done',
    'finished',
    "i've finished",
    'ive finished',
    "i'm finished",
    'im finished',
    'submit',
    'submit answer',
    'submit this',
    'yes',
    'yes next',
    'yes move on',
    "i don't know",
    'i dont know',
    "don't know",
    'dont know',
    'no idea',
    'pass',
    'pass this',
    'no answer',
    'go ahead',
    'go forward',
    'continue',
    'advance',
    "that's all",
    'thats all',
    "that's it",
    'thats it',
    'okay next',
    'ok next',
    'alright next',
  ];

  const TRIGGER_KEYWORDS = [
    'next',
    'skip',
    'done',
    'finished',
    'submit',
    'move on',
    'proceed',
    'pass',
    "don't know",
    'dont know',
    'no idea',
    'go ahead',
    'go forward',
    "that's all",
    'thats all',
    "that's it",
    'thats it',
    'advance',
    'continue to next',
  ];

  const PHONETIC_VARIANTS = [
    'necks',
    'nest',
    'text',
    'hex',
    'dun',
    'nun',
    'skip it',
    'skipped',
  ];

  function normalizeIntentTranscript(text) {
    return String(text || '')
      .toLowerCase()
      .trim()
      .replace(/[.,!?]/g, '');
  }

  const PROMPT_ECHO_PHRASES = [
    'have you finished answering',
    'finished answering the question',
    'say next to move on',
    'keep talking to add more',
    'or keep talking',
  ];

  function isLikelyPromptEcho(normalized) {
    if (!normalized) return false;
    return PROMPT_ECHO_PHRASES.some((phrase) => normalized.includes(phrase));
  }

  function matchesAdvanceIntent(transcript) {
    const normalized = normalizeIntentTranscript(transcript);
    if (!normalized) return false;

    if (EXACT_INTENTS.includes(normalized)) {
      console.log('[Assessment] Exact intent match:', normalized);
      return true;
    }

    if (TRIGGER_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
      console.log('[Assessment] Keyword intent match in:', normalized);
      return true;
    }

    if (PHONETIC_VARIANTS.some((variant) => normalized.includes(variant))) {
      console.log('[Assessment] Phonetic variant match:', normalized);
      return true;
    }

    return false;
  }

  const STATES = {
    IDLE: 'IDLE',
    RECORDING: 'RECORDING',
    SUBMITTING: 'SUBMITTING',
    GIVE_UP: 'GIVE_UP',
  };

  function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function isSpeechRecognitionSupported() {
    return !!getSpeechRecognitionCtor();
  }

  function formatTimeRemaining(ms) {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function estimateQuestionDurationMs(text) {
    const len = String(text || '').length;
    return Math.min(60000, Math.max(DEFAULT_QUESTION_AUDIO_MS, len * 55));
  }

  function dbg(label, meta = {}) {
    try {
      console.log('[Assessment]', label, meta);
      const token = window.INTERVIEW_TOKEN;
      if (!token) return;
      const url = `/interview/${encodeURIComponent(token)}/flow-debug`;
      const payload = JSON.stringify({
        label,
        ts: new Date().toISOString(),
        meta,
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      } else {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    } catch (_) {}
  }

  class AutoSubmitController {
    constructor(options) {
      this.token = options.token;
      this.ui = options.ui;
      this.getMicStream = options.getMicStream;
      this.onSubmitAnswer = options.onSubmitAnswer;
      this.onAfterSubmit = options.onAfterSubmit;
      this.onGiveUp = options.onGiveUp;
      this.onRecordingStart = options.onRecordingStart;
      this.onTranscriptUpdate = options.onTranscriptUpdate;
      this.onRepeatQuestion = options.onRepeatQuestion;
      this.onError = options.onError;
      this.getCurrentQuestionId = options.getCurrentQuestionId || (() => null);
      this.getQuestionPosition = options.getQuestionPosition || (() => ({ index: 0, total: 0, isLastQuestion: false }));
      this.onCandidateUtterance = options.onCandidateUtterance;

      this.state = STATES.IDLE;
      this.transcript = '';
      this.interimTranscript = '';
      this.intentionalRecognitionStop = false;

      this.recognition = null;
      this.silenceDetector = null;
      this.maxTimer = null;
      this.countdownTimer = null;
      this.recordingStartedAt = 0;
      this.pausedAt = null;
      this._visibilityHandler = null;
      this._destroyed = false;
      this._flowGeneration = 0;
      this.proctorHold = false;
      this._stateBeforeProctor = null;
      this._proctorHoldDepth = 0;
      this._proctorHoldGeneration = 0;
      this._recordingHealthInterval = null;
      this._speechActivityAt = 0;
      this._submitLockQuestionId = null;
      this._submitInFlight = false;
      this._pausedForRepeat = false;
      this._utteranceClassifyTimer = null;
      this._utteranceClassifyInFlight = false;
      this._nonAnswerInterruptionActive = false;
      this._assessmentSpeakHold = false;
      this._suppressSilenceUntil = 0;
      this._postRepeatAnswerGraceUntil = 0;
      this._repeatFlowPhase = null;

      /** Unified silence prompt + NEXT button flow */
      this._questionAudioFinished = false;
      this._silenceTimer = null;
      this._isPromptPlaying = false;
      this._intentRecognition = null;
      this._intentListenTimeout = null;
      this._intentListenActive = false;
      this._intentListenHasActed = false;
      this._intentListenUntil = 0;
      this._intentListenEchoGuardUntil = 0;
      this._isAdvancing = false;
      this._questionAudioEndTimers = [];
      this._questionAudioEndCleanup = null;
      this._questionAudioDurationMs = DEFAULT_QUESTION_AUDIO_MS;
      this._pendingQuestionAudioEnd = false;
    }

    _questionPositionLabel() {
      const { index, total } = this.getQuestionPosition?.() || {};
      if (!total) return '';
      return `| Question ${index || '?'} of ${total}`;
    }

    isPausedForRepeat() {
      return !!this._pausedForRepeat;
    }

    _bumpFlowGeneration() {
      this._flowGeneration += 1;
      return this._flowGeneration;
    }

    _currentQuestionId() {
      return this.getCurrentQuestionId?.() ?? null;
    }

    _isSubmitLockedForCurrentQuestion() {
      const qid = this._currentQuestionId();
      return this._submitInFlight && qid != null && this._submitLockQuestionId === qid;
    }

    getTranscript() {
      return (this.transcript + ' ' + this.interimTranscript).trim();
    }

    /** Merge interim STT into final buffer (display / fallback hint only — scoring uses server Whisper). */
    flushInterimTranscript() {
      if (this.interimTranscript) {
        const combined = this.getTranscript();
        this.transcript = combined;
        this.interimTranscript = '';
      }
      return this.transcript.trim();
    }

    isActive() {
      return this.state !== STATES.IDLE && this.state !== STATES.GIVE_UP;
    }

    isPostRepeatAnswerGrace() {
      return this._postRepeatAnswerGraceUntil > Date.now();
    }

    resetReengagementState({ stopVoice = false, skipIfCompleting = false } = {}) {
      if (skipIfCompleting) {
        const { isLastQuestion } = this.getQuestionPosition?.() || {};
        if (isLastQuestion) {
          console.log('[Assessment] Last question — skipping reengagement reset, completion owns state');
          return;
        }
      }
      this._stopAudioLevelMonitor();
      this._clearSilenceWatchTimers();
      this._questionAudioFinished = false;
      this._pendingQuestionAudioEnd = false;
      this._isPromptPlaying = false;
      this._isAdvancing = false;
      this.stopIntentListening();
      this.ui?.hideNextButton?.();
      if (stopVoice) {
        window.InterviewVoice?.stop?.();
      }
      console.log('[Assessment] State reset for new question');
    }

    _clearSilenceWatchTimers() {
      if (this._silenceTimer) clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }

    _shouldRunSilenceMonitor() {
      return (
        this.state === STATES.RECORDING &&
        !this.proctorHold &&
        this._questionAudioFinished &&
        !this._isPromptPlaying &&
        !this._intentListenActive &&
        !this._assessmentSpeakHold &&
        !this._shouldSuppressSilence()
      );
    }

    onQuestionAudioStart() {
      this._questionAudioFinished = false;
      this._stopAudioLevelMonitor();
      this._clearSilenceWatchTimers();
      this.stopIntentListening();
      this._isPromptPlaying = false;
      this.ui?.hideNextButton?.();
      dbg('question_audio_start', { qid: this._currentQuestionId(), flow: this._flowGeneration });
      console.log('[Assessment] Question audio playing — monitor paused');
    }

    onQuestionAudioEnd() {
      if (this._destroyed) return;
      if (this.state !== STATES.RECORDING) {
        this._pendingQuestionAudioEnd = true;
        console.log(
          '[Assessment] Question audio ended before recording ready — deferring silence monitor',
          this._questionPositionLabel()
        );
        return;
      }
      this._applyQuestionAudioEnd();
    }

    _applyQuestionAudioEnd() {
      this._pendingQuestionAudioEnd = false;
      this._questionAudioFinished = true;
      this._clearSilenceWatchTimers();
      this.ui?.showNextButton?.();
      dbg('question_audio_end', { qid: this._currentQuestionId(), flow: this._flowGeneration });
      console.log(
        '[Assessment] Question audio ended — silence monitor active',
        this._questionPositionLabel()
      );
      void this._startAudioLevelMonitor();
    }

    onCandidateStartedSpeaking() {
      this._clearSilenceWatchTimers();
    }

    _onAudioLevelTick(avgLevel) {
      if (this.state !== STATES.RECORDING || this.proctorHold) return;
      if (!this._shouldRunSilenceMonitor()) return;

      if (avgLevel >= SILENCE_FLOOR) {
        this._clearSilenceWatchTimers();
      } else if (!this._silenceTimer) {
        this._silenceTimer = setTimeout(() => {
          this._silenceTimer = null;
          if (!this._shouldRunSilenceMonitor()) return;
          console.log('[Assessment] Silence threshold reached — playing unified prompt');
          void this.playUnifiedSilencePrompt();
        }, SILENCE_THRESHOLD_MS);
      }
    }

    async _startAudioLevelMonitor() {
      if (!this._questionAudioFinished || this.state !== STATES.RECORDING) return;
      await this._ensureSilenceDetector();
    }

    _stopAudioLevelMonitor() {
      if (this.silenceDetector) {
        this.silenceDetector.stop();
        this.silenceDetector = null;
      }
    }

    async playUnifiedSilencePrompt() {
      if (this._isPromptPlaying || this._intentListenActive) return;
      if (this.state !== STATES.RECORDING || !this._shouldRunSilenceMonitor()) return;

      this._clearSilenceWatchTimers();
      this._isPromptPlaying = true;
      dbg('unified_silence_prompt_start', { qid: this._currentQuestionId(), flow: this._flowGeneration });
      console.log('[Assessment] Playing unified silence prompt', this._questionPositionLabel());

      try {
        await window.InterviewVoice?.speak?.(UNIFIED_PROMPT_TEXT, {
          interrupt: false,
          rate: 0.92,
          volume: 0.9,
        });
      } catch (e) {
        console.warn('[Assessment] Unified prompt TTS failed:', e.message);
      } finally {
        this._isPromptPlaying = false;
      }

      if (this._destroyed || this.state !== STATES.RECORDING) return;
      await delay(400);
      if (this._destroyed || this.state !== STATES.RECORDING) return;
      this.startIntentListening();
    }

    _looksLikeSubstantiveSpeech(normalized) {
      if (!normalized) return false;
      const words = normalized.split(/\s+/).filter(Boolean);
      return words.length >= 2 || normalized.length >= 8;
    }

    _isIntentEchoGuardActive() {
      return this._intentListenEchoGuardUntil > 0 && Date.now() < this._intentListenEchoGuardUntil;
    }

    _evaluateIntentSpeechResult(rawTranscript, isFinal, confidence = 1) {
      if (this._intentListenHasActed || !this._intentListenActive) return false;
      if (Date.now() > this._intentListenUntil) {
        this.stopIntentListening();
        return false;
      }

      const normalized = normalizeIntentTranscript(rawTranscript);
      if (!normalized) return false;

      console.log('[Assessment] Transcript:', normalized, '| Final:', isFinal, '| Confidence:', confidence);

      if (this._isIntentEchoGuardActive() || isLikelyPromptEcho(normalized)) {
        console.log('[Assessment] Ignoring likely prompt echo:', normalized);
        return false;
      }

      const confidenceOk = !isFinal || confidence > 0.5;
      if (confidenceOk && matchesAdvanceIntent(normalized)) {
        this._intentListenHasActed = true;
        this.stopIntentListening({ resumeMain: false });
        console.log('[Assessment] Advance intent matched — submitting and advancing');
        dbg('silence_advance_intent', {
          transcript: normalized,
          isFinal,
          confidence,
          qid: this._currentQuestionId(),
          flow: this._flowGeneration,
        });
        this.handleNextQuestion();
        return true;
      }

      if (isFinal && this._looksLikeSubstantiveSpeech(normalized)) {
        console.log('[Assessment] No advance intent — candidate still answering');
        this.stopIntentListening();
      }
      return false;
    }

    _processIntentSpeechEvent(event) {
      if (!this._intentListenActive || this._intentListenHasActed) return false;

      let combined = '';
      let anyFinal = false;
      for (let i = 0; i < event.results.length; i++) {
        combined += (combined ? ' ' : '') + event.results[i][0].transcript;
        if (event.results[i].isFinal) anyFinal = true;
      }
      if (combined && this._evaluateIntentSpeechResult(combined, anyFinal, 1)) {
        return true;
      }

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const isFinal = event.results[i].isFinal;
        for (let j = 0; j < event.results[i].length; j++) {
          const alt = event.results[i][j];
          console.log(
            '[Assessment] Alt transcript:',
            normalizeIntentTranscript(alt.transcript),
            '| Confidence:',
            alt.confidence ?? 'n/a'
          );
          if (this._evaluateIntentSpeechResult(alt.transcript, isFinal, alt.confidence ?? 1)) {
            return true;
          }
        }
      }
      return false;
    }

    startIntentListening() {
      this.stopIntentListening();
      const Ctor = getSpeechRecognitionCtor();
      if (!Ctor || this.state !== STATES.RECORDING) return;

      this._intentListenActive = true;
      this._intentListenHasActed = false;
      this._intentListenUntil = Date.now() + INTENT_LISTEN_MS;
      this._intentListenEchoGuardUntil = Date.now() + INTENT_POST_PROMPT_ECHO_GUARD_MS;

      if (!this.recognition) {
        this.recognition = this._createRecognition(true, true);
        if (this.recognition) {
          this._attachMainRecognitionHandlers(this.recognition);
        }
      }
      if (this.recognition) {
        this.intentionalRecognitionStop = false;
        try {
          this.recognition.start();
        } catch (e) {
          console.warn('[Assessment] Intent listen — main recognition start failed:', e.message);
          this._restartMainRecognition();
        }
      }

      this._intentListenTimeout = setTimeout(() => {
        if (this._intentListenActive && !this._intentListenHasActed) {
          console.log('[Assessment] Intent window expired — resuming silence watch');
          this.stopIntentListening();
        }
      }, INTENT_LISTEN_MS);

      console.log(
        '[Assessment] Intent listening started (interim results ON, main recognition)',
        this._questionPositionLabel()
      );
    }

    stopIntentListening({ resumeMain = true } = {}) {
      void resumeMain;
      if (this._intentListenTimeout) {
        clearTimeout(this._intentListenTimeout);
        this._intentListenTimeout = null;
      }
      if (this._intentRecognition) {
        this._stopRecognition(this._intentRecognition);
        this._intentRecognition = null;
      }
      this._intentListenActive = false;
      this._intentListenHasActed = false;
      this._intentListenUntil = 0;
      this._intentListenEchoGuardUntil = 0;
    }

    cancelReengagement(reason = 'cancelled') {
      const resumeMain = reason !== 'next_clicked' && reason !== 'submitting';
      this.stopIntentListening({ resumeMain });
      this._isPromptPlaying = false;
      dbg('silence_flow_cancelled', { reason, qid: this._currentQuestionId(), flow: this._flowGeneration });
    }

    handleNextQuestion() {
      if (this._isAdvancing || this.state !== STATES.RECORDING || this._isSubmitLockedForCurrentQuestion()) {
        return;
      }
      this._isAdvancing = true;
      this._stopAudioLevelMonitor();
      this._clearSilenceWatchTimers();
      this.stopIntentListening({ resumeMain: false });
      this._isPromptPlaying = false;
      window.InterviewVoice?.stop?.();
      const { index, total, isLastQuestion } = this.getQuestionPosition?.() || {};
      console.log(
        '[Assessment] Next triggered on question',
        index || '?',
        'of',
        total || '?',
        isLastQuestion ? '(last question)' : ''
      );
      dbg('next_clicked_advancing', {
        qid: this._currentQuestionId(),
        flow: this._flowGeneration,
        isLastQuestion: !!isLastQuestion,
        questionIndex: index,
        totalQuestions: total,
      });
      this._submitInFlight = true;
      this._submitLockQuestionId = this._currentQuestionId();
      void this._enterSubmitting();
    }

    _clearVoiceFlowGuards() {
      this._nonAnswerInterruptionActive = false;
      this._assessmentSpeakHold = false;
      this._suppressSilenceUntil = 0;
      if (this._utteranceClassifyTimer) clearTimeout(this._utteranceClassifyTimer);
      this._utteranceClassifyTimer = null;
      this._utteranceClassifyInFlight = false;
    }

    _clearQuestionAudioEndDetection() {
      if (this._questionAudioEndCleanup) {
        try {
          this._questionAudioEndCleanup();
        } catch (_) {}
        this._questionAudioEndCleanup = null;
      }
      this._questionAudioEndTimers.forEach((id) => clearTimeout(id));
      this._questionAudioEndTimers = [];
    }

    holdSilenceForQuestionTts(speechPromise, options = {}) {
      this._clearQuestionAudioEndDetection();
      if (options.expectedDurationMs) {
        this._questionAudioDurationMs = options.expectedDurationMs;
      }

      let endFired = false;
      const handleAudioEnd = () => {
        if (endFired) return;
        endFired = true;
        this.onQuestionAudioEnd();
      };

      void Promise.resolve(speechPromise).finally(handleAudioEnd);

      const audioEl = window.InterviewVoice?.getCurrentAudio?.();
      if (audioEl) {
        const onTimeUpdate = () => {
          if (Number.isFinite(audioEl.duration) && audioEl.duration - audioEl.currentTime < 0.3) {
            handleAudioEnd();
          }
        };
        audioEl.addEventListener('ended', handleAudioEnd);
        audioEl.addEventListener('timeupdate', onTimeUpdate);
        this._questionAudioEndCleanup = () => {
          audioEl.removeEventListener('ended', handleAudioEnd);
          audioEl.removeEventListener('timeupdate', onTimeUpdate);
        };
      }

      const expectedDurationMs = options.expectedDurationMs || this._questionAudioDurationMs;
      if (expectedDurationMs) {
        this._questionAudioEndTimers.push(setTimeout(handleAudioEnd, expectedDurationMs + 500));
      }

      this._questionAudioEndTimers.push(
        setTimeout(() => {
          if (!this._questionAudioFinished) {
            console.warn('[Assessment] Hard cap hit — forcing question audio end');
            handleAudioEnd();
          }
        }, QUESTION_PLAYING_HARD_CAP_MS)
      );
    }

    _onAudioLevelChange(level) {
      this.ui?.setVolumeLevel?.(level);
    }

    _resetForRecordingResume({
      preserveTranscript = false,
      preserveRepeatContext = false,
      invalidateFlow = true,
    } = {}) {
      const savedGrace = this._postRepeatAnswerGraceUntil;
      const savedPhase = this._repeatFlowPhase;

      if (invalidateFlow) this._bumpFlowGeneration();
      this._clearVoiceFlowGuards();
      this._clearTimers();
      this.intentionalRecognitionStop = true;
      this._stopRecognition(this.recognition);
      this.recognition = null;

      if (this.silenceDetector) {
        this.silenceDetector.stop();
        this.silenceDetector = null;
      }

      if (!preserveTranscript) {
        this.transcript = '';
        this.interimTranscript = '';
      } else {
        this.interimTranscript = '';
      }

      this.intentionalRecognitionStop = false;
      this.ui?.hideCountdown?.();
      if (!preserveTranscript) {
        this.ui?.updateTranscript?.('');
      }

      if (preserveRepeatContext) {
        this._postRepeatAnswerGraceUntil = savedGrace;
        this._repeatFlowPhase = savedPhase || 'ANSWER_WAITING';
      }
    }

    resetForNextQuestion({ preserveTranscript = false } = {}) {
      this._bumpFlowGeneration();
      this._clearVoiceFlowGuards();
      this.proctorHold = false;
      this._stateBeforeProctor = null;
      this._clearTimers();
      this.resetReengagementState();
      this.intentionalRecognitionStop = true;

      this._stopRecognition(this.recognition);
      this.recognition = null;

      if (this.silenceDetector) {
        this.silenceDetector.stop();
        this.silenceDetector = null;
      }

      if (!preserveTranscript) {
        this.transcript = '';
        this.interimTranscript = '';
      } else {
        this.interimTranscript = '';
      }

      this.recordingStartedAt = 0;
      this.pausedAt = null;
      this.intentionalRecognitionStop = false;
      this._submitInFlight = false;
      this._submitLockQuestionId = null;
      this._postRepeatAnswerGraceUntil = 0;
      this._repeatFlowPhase = null;

      if (this.state !== STATES.SUBMITTING) {
        this.state = STATES.IDLE;
      }

      this.ui?.hideCountdown?.();
      this.ui?.setVolumeLevel?.(0);
      if (!preserveTranscript) {
        this.ui?.updateTranscript?.('');
      }
    }

    stop() {
      this._destroyed = true;
      this.resetForNextQuestion();
      window.speechSynthesis?.cancel();
      if (this._visibilityHandler) {
        document.removeEventListener('visibilitychange', this._visibilityHandler);
        this._visibilityHandler = null;
      }
      this.state = STATES.IDLE;
      this.ui?.setPanelVisible?.(false);
      this.ui?.showSubmittingOverlay?.(false);
    }

    _clearTimers() {
      if (this.maxTimer) clearTimeout(this.maxTimer);
      if (this.countdownTimer) clearInterval(this.countdownTimer);
      if (this._utteranceClassifyTimer) clearTimeout(this._utteranceClassifyTimer);
      if (this._recordingHealthInterval) clearInterval(this._recordingHealthInterval);
      this._clearSilenceWatchTimers();
      this._clearQuestionAudioEndDetection();
      this.stopIntentListening();
      this.maxTimer = null;
      this.countdownTimer = null;
      this._utteranceClassifyTimer = null;
      this._recordingHealthInterval = null;
    }

    shouldSuppressSilence() {
      return this._shouldSuppressSilence();
    }

    isAssessmentSpeakActive() {
      return !!this._assessmentSpeakHold;
    }

    beginAssessmentSpeak() {
      this._assessmentSpeakHold = true;
      this._nonAnswerInterruptionActive = true;
      this._suppressSilenceUntil = Date.now() + 60000;
      this._clearSilenceWatchTimers();
      this.cancelReengagement('assessment_speak');
      dbg('assessment_speak_begin', {
        qid: this._currentQuestionId(),
        state: this.state,
        flow: this._flowGeneration,
      });
    }

    _shouldSuppressSilence() {
      return (
        this._assessmentSpeakHold ||
        this._nonAnswerInterruptionActive ||
        this._utteranceClassifyInFlight ||
        !!this._utteranceClassifyTimer ||
        (this._suppressSilenceUntil > 0 && Date.now() < this._suppressSilenceUntil)
      );
    }

    _looksLikeNonAnswerUtterance(text) {
      const t = String(text || '').trim();
      if (t.length < 8) return false;

      const wordCount = t.split(/\s+/).filter(Boolean).length;
      if (this.isPostRepeatAnswerGrace() && wordCount >= 4) {
        return false;
      }

      const repeatCheck = window.QuestionRepeatRequest?.classify?.(t);
      if (repeatCheck?.isRepeatRequest && Number(repeatCheck.confidence) >= 0.55) {
        return true;
      }

      const looksLikeQuestion =
        /\?\s*$/.test(t) &&
        /^(how|what|when|where|why|who|can|could|would|is|are|do|does|may)\b/i.test(t);
      if (looksLikeQuestion) return true;

      const local = window.AssessmentIntentClient?.classify?.(t, {});
      if (!local) return false;
      if (local.edgeCase) return true;
      if (local.intent === 'REPEAT_REQUEST' && (local.confidence ?? 0) >= 0.55) return true;
      return local.intent !== 'ANSWER' && (local.confidence ?? 0) >= 0.72;
    }

    _armNonAnswerGuard() {
      this._nonAnswerInterruptionActive = true;
      this._suppressSilenceUntil = Date.now() + 25000;
      dbg('non_answer_guard_armed', {
        qid: this._currentQuestionId(),
        state: this.state,
        flow: this._flowGeneration,
      });
    }

    _onFinalUtterance(trimmed) {
      const text = String(trimmed || '').trim();
      if (!text) return;
      const likelyNonAnswer = this._looksLikeNonAnswerUtterance(text);
      if (likelyNonAnswer) {
        this._armNonAnswerGuard();
      }
      this._scheduleUtteranceClassify(text, { fast: likelyNonAnswer });
    }

    async abortConfirmationForAssessmentSpeak() {
      return this.abortForAssessmentSpeak();
    }

    async abortForAssessmentSpeak() {
      this._assessmentSpeakHold = true;
      this._nonAnswerInterruptionActive = true;
      this._suppressSilenceUntil = Date.now() + 30000;
      this.cancelReengagement('assessment_abort');
      window.InterviewVoice?.stop?.();
      dbg('abort_for_assessment_speak', {
        qid: this._currentQuestionId(),
        state: this.state,
        flow: this._flowGeneration,
      });
    }

    async resumeAfterAssessmentSpeak() {
      this._assessmentSpeakHold = false;
      this._nonAnswerInterruptionActive = false;
      await window.InterviewVoice?.waitUntilIdle?.();
      this._suppressSilenceUntil = Date.now() + 5000;

      if (this._destroyed || this.proctorHold) return;

      dbg('resume_after_assessment_speak', {
        qid: this._currentQuestionId(),
        state: this.state,
        flow: this._flowGeneration,
      });

      if (this.state === STATES.RECORDING) {
        this._speechActivityAt = Date.now();
        if (this._questionAudioFinished) {
          void this._startAudioLevelMonitor();
        }
      }
    }

    _stripUtteranceFromTranscript(utterance) {
      const u = String(utterance || '').trim();
      if (!u) return;
      const full = this.getTranscript();
      const idx = full.toLowerCase().lastIndexOf(u.toLowerCase());
      if (idx >= 0) {
        this.transcript = (full.slice(0, idx) + full.slice(idx + u.length)).replace(/\s+/g, ' ').trim();
      }
      this.interimTranscript = '';
      this.ui?.updateTranscript?.(this.getTranscript());
    }

    _scheduleUtteranceClassify(finalText, { fast = false } = {}) {
      const text = String(finalText || '').trim();
      if (!text || text.length < 3 || !this.onCandidateUtterance) return;

      if (this.isPostRepeatAnswerGrace()) {
        const words = text.split(/\s+/).filter(Boolean).length;
        const repeatCheck = window.QuestionRepeatRequest?.classify?.(text);
        const isHighConfidenceRepeat =
          repeatCheck?.isRepeatRequest && Number(repeatCheck.confidence) >= 0.72;
        if (words >= 5 && !isHighConfidenceRepeat) {
          return;
        }
      }

      const debounceMs = fast ? META_UTTERANCE_CLASSIFY_DEBOUNCE_MS : UTTERANCE_CLASSIFY_DEBOUNCE_MS;
      if (this._utteranceClassifyTimer) clearTimeout(this._utteranceClassifyTimer);
      this._utteranceClassifyTimer = setTimeout(() => {
        this._utteranceClassifyTimer = null;
        if (this.state !== STATES.RECORDING && !this._nonAnswerInterruptionActive && !this._assessmentSpeakHold) {
          return;
        }
        if (this._utteranceClassifyInFlight) return;
        this._utteranceClassifyInFlight = true;
        void Promise.resolve(this.onCandidateUtterance(text))
          .then((result) => {
            if (result?.handled && result?.removeFromTranscript) {
              this._stripUtteranceFromTranscript(text);
            }
            if (!result?.handled) {
              this._nonAnswerInterruptionActive = false;
            }
            return result;
          })
          .catch(() => {
            this._nonAnswerInterruptionActive = false;
          })
          .finally(() => {
            this._utteranceClassifyInFlight = false;
          });
      }, debounceMs);
    }

    markSuspiciousEvent(eventType = 'suspicious') {
      dbg('mark_suspicious_event', {
        qid: this._currentQuestionId(),
        eventType,
        state: this.state,
        flow: this._flowGeneration,
      });
    }

    _setState(next, message) {
      const prev = this.state;
      this.state = next;
      dbg('state_change', {
        from: prev,
        to: next,
        message: message || '',
        qid: this._currentQuestionId(),
        flow: this._flowGeneration,
      });
      this.ui?.setState?.(next, message);
    }

    _stopRecognition(rec) {
      if (!rec) return;
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.stop();
      } catch (_) {}
      try {
        rec.abort();
      } catch (_) {}
    }

    _createRecognition(continuous, interim) {
      const Ctor = getSpeechRecognitionCtor();
      if (!Ctor) return null;
      const r = new Ctor();
      r.lang = SPEECH_RECOGNITION_LANG;
      r.continuous = continuous;
      r.interimResults = interim;
      r.maxAlternatives = interim ? 5 : 1;
      return r;
    }

    async _ensureSilenceDetector() {
      if (this.state !== STATES.RECORDING || this.proctorHold) return;
      if (!this._questionAudioFinished) return;
      if (this.silenceDetector && !this.silenceDetector._stopped) return;

      if (this.silenceDetector) {
        this.silenceDetector.stop();
        this.silenceDetector = null;
      }
      if (!this.getMicStream) return;

      try {
        const stream = this.getMicStream();
        if (!stream?.getAudioTracks?.().some((t) => t.readyState === 'live')) return;
        this.silenceDetector = new SilenceDetector(stream, {
          silenceThreshold: SILENCE_THRESHOLD,
          levelMonitorOnly: true,
          frequencyMonitor: true,
          pollIntervalMs: AUDIO_LEVEL_POLL_MS,
          onLevel: (level) => this._onAudioLevelChange(level),
          onFrequencyLevel: (avgLevel) => this._onAudioLevelTick(avgLevel),
        });
        await this.silenceDetector.start();
      } catch (e) {
        console.warn('[AutoSubmit] silence detector recreate failed:', e.message);
      }
    }

    _startRecordingHealthWatch() {
      if (this._recordingHealthInterval) clearInterval(this._recordingHealthInterval);
      this._recordingHealthInterval = setInterval(() => {
        if (this._destroyed || this.proctorHold || this.state !== STATES.RECORDING) return;
        if (this._intentListenActive) return;
        if (!this.silenceDetector || this.silenceDetector._stopped) {
          void this._ensureSilenceDetector();
        }
        if (!this.recognition && !this.intentionalRecognitionStop) {
          this._restartMainRecognition();
        }
      }, RECORDING_HEALTH_CHECK_MS);
    }

    async holdForProctor({ force = false } = {}) {
      if (this._assessmentSpeakHold && !force) return;
      if (this._assessmentSpeakHold && force) {
        this._assessmentSpeakHold = false;
        this._nonAnswerInterruptionActive = false;
        this._suppressSilenceUntil = 0;
      }
      if (this._proctorHoldDepth > 0) {
        this._proctorHoldDepth += 1;
        return;
      }
      this._proctorHoldDepth = 1;
      this.proctorHold = true;

      if (!this._stateBeforeProctor) {
        this._stateBeforeProctor = this.state;
      }

      this._bumpFlowGeneration();
      this._proctorHoldGeneration = this._flowGeneration;
      this.cancelReengagement('proctor_hold');
      this._clearTimers();
      this.intentionalRecognitionStop = true;
      this._stopRecognition(this.recognition);
      this.recognition = null;
      if (this.silenceDetector) {
        this.silenceDetector.stop();
        this.silenceDetector = null;
      }
      dbg('hold_for_proctor', {
        qid: this._currentQuestionId(),
        state: this.state,
        flow: this._flowGeneration,
      });
    }

    abortForExternalSubmit() {
      this._proctorHoldDepth = 0;
      this._proctorHoldGeneration = 0;
      this.proctorHold = false;
      this._stateBeforeProctor = null;
      this._bumpFlowGeneration();
      this._clearTimers();
      this.cancelReengagement('external_submit');
      this.intentionalRecognitionStop = true;
      this._stopRecognition(this.recognition);
      this.recognition = null;
      if (this.silenceDetector) {
        this.silenceDetector.stop();
        this.silenceDetector = null;
      }
    }

    async releaseProctorHold() {
      if (this._proctorHoldDepth <= 0) return;
      this._proctorHoldDepth -= 1;
      if (this._proctorHoldDepth > 0) return;

      this.proctorHold = false;
      const holdGen = this._proctorHoldGeneration;
      this._proctorHoldGeneration = 0;
      const prev = this._stateBeforeProctor;
      this._stateBeforeProctor = null;

      dbg('release_proctor_hold', {
        qid: this._currentQuestionId(),
        state: this.state,
        prev,
        holdGen,
        flow: this._flowGeneration,
      });

      if (this._destroyed || this.state === STATES.SUBMITTING || this.state === STATES.GIVE_UP) {
        return;
      }
      if (holdGen && holdGen !== this._flowGeneration) return;

      await window.InterviewVoice?.waitUntilIdle?.();

      if (prev === STATES.RECORDING) {
        await this._resumeRecordingAfterProctor();
      }
    }

    async pauseForQuestionRepeat() {
      this._pausedForRepeat = true;
      this._repeatFlowPhase = 'REPEAT_REQUEST_DETECTED';
      this._clearTimers();
      this._clearVoiceFlowGuards();
      this.cancelReengagement('question_repeat');

      dbg('repeat_flow_pause', {
        qid: this._currentQuestionId(),
        state: this.state,
        flow: this._flowGeneration,
      });

      this.intentionalRecognitionStop = true;
      this._stopRecognition(this.recognition);
      this.recognition = null;
      if (this.silenceDetector) {
        this.silenceDetector.stop();
        this.silenceDetector = null;
      }
    }

    async resumeAfterQuestionRepeat() {
      if (!this._pausedForRepeat) return;

      this._pausedForRepeat = false;
      this._repeatFlowPhase = 'ANSWER_WAITING';
      this._clearVoiceFlowGuards();
      this.transcript = '';
      this.interimTranscript = '';
      this.ui?.updateTranscript?.('');
      this._postRepeatAnswerGraceUntil = Date.now() + 60000;

      dbg('repeat_flow_answer_waiting', {
        qid: this._currentQuestionId(),
        flow: this._flowGeneration,
      });

      await this._enterRecording({ preserveTranscript: false, context: 'repeat' });
      this._repeatFlowPhase = 'ANSWER_WAITING';
    }

    async startAfterQuestion({ skipIdleCountdown = false } = {}) {
      if (this._destroyed) return;
      if (!isSpeechRecognitionSupported()) {
        this._setState(STATES.GIVE_UP, 'manual_only');
        this.onGiveUp?.();
        return;
      }

      this.resetForNextQuestion();
      this._submitInFlight = false;
      this._submitLockQuestionId = null;
      this._pausedForRepeat = false;
      this.ui?.setPanelVisible?.(true);
      this._setState(STATES.IDLE, 'Get ready to answer…');

      if (!skipIdleCountdown) {
        await delay(1200);
        if (this._destroyed || this.state !== STATES.IDLE) return;
      }

      await this._enterRecording();
    }

    async _enterRecording({ preserveTranscript = false, context = 'normal' } = {}) {
      if (this._destroyed || this.proctorHold) return;

      if (context === 'normal') {
        this.resetForNextQuestion({ preserveTranscript });
      } else {
        this._resetForRecordingResume({
          preserveTranscript,
          preserveRepeatContext: context === 'repeat',
          invalidateFlow: true,
        });
      }

      dbg('enter_recording', {
        qid: this._currentQuestionId(),
        context,
        preserveTranscript,
        flow: this._flowGeneration,
      });

      this._setState(STATES.RECORDING, 'Recording — speak your answer');
      this.recordingStartedAt = Date.now();

      if (preserveTranscript) {
        this.ui?.updateTranscript?.(this.getTranscript());
      } else {
        this.ui?.updateTranscript?.('');
      }

      this.recognition = this._createRecognition(true, true);
      if (!this.recognition) {
        this._enterGiveUp();
        return;
      }

      this._attachMainRecognitionHandlers(this.recognition);

      try {
        this.intentionalRecognitionStop = false;
        this.recognition.start();
      } catch (e) {
        console.warn('[AutoSubmit] recognition start failed', e);
        this._restartMainRecognition();
      }

      try {
        this.onRecordingStart?.();
      } catch (e) {
        console.warn('[AutoSubmit] onRecordingStart failed', e.message);
      }

      if (this._pendingQuestionAudioEnd) {
        this._applyQuestionAudioEnd();
      }

      await this._startAudioLevelMonitor();
      this._speechActivityAt = Date.now();
      this._startRecordingHealthWatch();
      this._startMaxTimer();
      this._bindVisibilityPause();
    }

    async _resumeRecordingAfterProctor() {
      if (this._destroyed || this.proctorHold || this.state !== STATES.RECORDING) return;
      this._clearVoiceFlowGuards();

      dbg('resume_recording_after_proctor', {
        qid: this._currentQuestionId(),
        flow: this._flowGeneration,
      });

      if (!this.recognition) {
        this.recognition = this._createRecognition(true, true);
        if (this.recognition) {
          this._attachMainRecognitionHandlers(this.recognition);
          try {
            this.intentionalRecognitionStop = false;
            this.recognition.start();
          } catch (_) {
            this._restartMainRecognition();
          }
        }
      }

      if (this._questionAudioFinished) {
        void this._startAudioLevelMonitor();
      }
      this._speechActivityAt = Date.now();
      this._startRecordingHealthWatch();
      if (!this.maxTimer && this.recordingStartedAt) {
        this._startMaxTimer();
      }
    }

    _attachMainRecognitionHandlers(rec) {
      if (!rec) return;
      rec.onresult = (ev) => {
        if (this._assessmentSpeakHold) return;
        if (window.InterviewVoice?.isSpeaking?.()) return;

        if (this._processIntentSpeechEvent(ev)) return;

        this._speechActivityAt = Date.now();
        let interim = '';
        let hadSpeech = false;
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const part = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) {
            const trimmed = part.trim();
            if (trimmed) hadSpeech = true;
            this.transcript += (this.transcript ? ' ' : '') + trimmed;
            this._onFinalUtterance(trimmed);
          } else {
            interim += part;
            if (part.trim()) hadSpeech = true;
          }
        }
        if (hadSpeech) {
          this.onCandidateStartedSpeaking();
        }
        this.interimTranscript = interim.trim();
        const combined = this.getTranscript();
        this.ui?.updateTranscript?.(combined);
        this.onTranscriptUpdate?.(combined);
      };

      rec.onerror = (ev) => {
        if (ev.error === 'not-allowed') {
          this.ui?.setStatusLine?.('Microphone speech recognition was blocked.');
          this._enterGiveUp();
          return;
        }
        if (this.state === STATES.RECORDING) {
          this.ui?.setStatusLine?.('Reconnecting speech recognition…');
          setTimeout(() => {
            if (this.state === STATES.RECORDING && this.recognition) {
              try {
                this.recognition.start();
              } catch (_) {
                this._restartMainRecognition();
              }
            }
          }, RECOGNITION_RETRY_MS);
        }
      };

      rec.onend = () => {
        if (this.intentionalRecognitionStop || this.state !== STATES.RECORDING) return;
        try {
          rec.start();
        } catch (_) {
          this._restartMainRecognition();
        }
      };
    }

    _restartMainRecognition() {
      if (this.state !== STATES.RECORDING) return;
      if (this._intentListenActive) return;
      this._stopRecognition(this.recognition);
      this.recognition = this._createRecognition(true, true);
      if (!this.recognition) return;
      this._attachMainRecognitionHandlers(this.recognition);
      try {
        this.intentionalRecognitionStop = false;
        this.recognition.start();
      } catch (e) {
        console.warn('[AutoSubmit] recognition restart failed', e);
        setTimeout(() => {
          if (this.state === STATES.RECORDING) this._restartMainRecognition();
        }, RECOGNITION_RETRY_MS);
      }
    }

    _startMaxTimer() {
      const tick = () => {
        if (this.state !== STATES.RECORDING) return;
        const elapsed = Date.now() - this.recordingStartedAt;
        const remaining = Math.max(0, MAX_RECORDING_DURATION_MS - elapsed);
        this.ui?.setTimerRemaining?.(formatTimeRemaining(remaining));
      };
      tick();
      this.countdownTimer = setInterval(tick, 1000);
      this.maxTimer = setTimeout(() => {
        if (this.state === STATES.RECORDING) {
          this.ui?.setTimerRemaining?.('0:00');
        }
      }, MAX_RECORDING_DURATION_MS);
    }

    _bindVisibilityPause() {
      if (this._visibilityHandler) return;
      this._visibilityHandler = () => {
        if (this.proctorHold || this.state !== STATES.RECORDING) return;
        if (document.hidden) {
          this.pausedAt = Date.now();
          this._clearTimers();
          if (this.silenceDetector) {
            this.silenceDetector.stop();
            this.silenceDetector = null;
          }
          this.ui?.setStatusLine?.('Interview paused — return to this tab to continue');
        } else if (this.pausedAt) {
          const pauseDur = Date.now() - this.pausedAt;
          this.recordingStartedAt += pauseDur;
          this.pausedAt = null;
          this._startMaxTimer();
          this._startRecordingHealthWatch();
          this.ui?.setStatusLine?.('Recording resumed');
          if (this._questionAudioFinished) {
            void this._startAudioLevelMonitor();
          }
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }

    async _enterSubmitting() {
      if (this.state === STATES.SUBMITTING) return;
      if (!this._submitInFlight) {
        this._submitInFlight = true;
        this._submitLockQuestionId = this._currentQuestionId();
      }

      dbg('enter_submitting', {
        qid: this._currentQuestionId(),
        flow: this._flowGeneration,
      });

      this._bumpFlowGeneration();
      this.proctorHold = false;
      this._proctorHoldDepth = 0;
      this._clearTimers();
      this.cancelReengagement('submitting');
      this.ui?.hideNextButton?.();
      this.intentionalRecognitionStop = true;
      this._stopRecognition(this.recognition);
      this.recognition = null;
      if (this.silenceDetector) {
        this.silenceDetector.stop();
        this.silenceDetector = null;
      }

      this._setState(STATES.SUBMITTING, 'Submitting your answer…');
      this.ui?.showSubmittingOverlay?.(true);
      this.flushInterimTranscript();
      const finalText = this.transcript.trim();

      try {
        const data = await this.onSubmitAnswer(finalText);
        dbg('submit_success', {
          qid: this._currentQuestionId(),
          submittedQuestionId: data?.question_id,
          flow: this._flowGeneration,
        });
        this.ui?.showSubmittingOverlay?.(false);
        this.ui?.setPanelVisible?.(false);

        const outcome = await this.onAfterSubmit?.(data);
        if (outcome?.completed) {
          this.stop();
        } else {
          this._isAdvancing = false;
        }
        this._submitInFlight = false;
        this._submitLockQuestionId = null;
      } catch (e) {
        dbg('submit_failed', {
          qid: this._currentQuestionId(),
          error: e?.message || String(e),
          flow: this._flowGeneration,
        });
        this._submitInFlight = false;
        this._submitLockQuestionId = null;
        this._isAdvancing = false;
        this.ui?.showSubmittingOverlay?.(false);
        this.onError?.(e.message || 'Submit failed');
        this.ui?.setPanelVisible?.(true);
        await this._enterRecording({ preserveTranscript: true, context: 'resume' });
      }
    }

    _enterGiveUp() {
      this.resetForNextQuestion();
      this._setState(STATES.GIVE_UP, 'Please use the Submit button');
      this.onGiveUp?.();
    }
  }

  return {
    STATES,
    isSpeechRecognitionSupported,
    estimateQuestionDurationMs,
    matchesAdvanceIntent,
    create: (options) => new AutoSubmitController(options),
    constants: {
      SILENCE_THRESHOLD,
      SILENCE_FLOOR,
      SILENCE_THRESHOLD_MS,
      NEXT_QUESTION_DELAY_MS,
      MAX_RECORDING_DURATION_MS,
      RECORDING_HEALTH_CHECK_MS,
      SPEECH_RECOGNITION_LANG,
      INTENT_LISTEN_MS,
    },
  };
})();
