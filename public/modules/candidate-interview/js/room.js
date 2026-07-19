(function () {
  let token = window.INTERVIEW_TOKEN;
  const MIN_ANSWER_MS = 2500;
  const MIN_ANSWER_BYTES = 2500;
  const ALERT_COOLDOWN_MS = 20000;
  const PROCTOR_ALERT_HIDE_MS = 8000;
  const HEADPHONE_POLL_MS = 4000;

  const PROCTOR_FINAL_WARNING_STRIKE =
    window.INTERVIEW_PROCTORING_STRIKES?.finalWarning ?? 4;
  const PROCTOR_TERMINATION_STRIKE =
    window.INTERVIEW_PROCTORING_STRIKES?.termination ?? 5;
  const proctorMessages = () => window.InterviewProctorMessages || {};
  const sessionLabels = () => window.INTERVIEW_SESSION_LABELS || {};
  const proctorLog = (message, meta) => window.ProctoringClientLog?.log?.(message, meta);

  let deferredProctorDrainTimer = null;

  function isProctorStrikeAction(action) {
    return action === 'warning' || action === 'final_warning' || action === 'terminate';
  }

  function scheduleDeferredProctorDrain() {
    if (deferredProctorDrainTimer) return;
    deferredProctorDrainTimer = setInterval(() => {
      if (interviewFinished || proctorTerminationInProgress) {
        clearInterval(deferredProctorDrainTimer);
        deferredProctorDrainTimer = null;
        return;
      }
      if (!pendingProctorEscalations.length) {
        clearInterval(deferredProctorDrainTimer);
        deferredProctorDrainTimer = null;
        return;
      }
      if (!isInterviewSpeechPlaying()) {
        void drainDeferredProctorEscalations();
      }
    }, 400);
  }

  const video = document.getElementById('room-video');
  const btnStart = document.getElementById('btn-start');
  const btnNextQuestion = document.getElementById('btn-next-question');
  const btnSubmit = document.getElementById('btn-submit-answer');
  const btnEnd = document.getElementById('btn-end');
  const btnPlayQuestion = document.getElementById('btn-play-question');
  const statusEl = document.getElementById('room-status');
  const msgEl = document.getElementById('room-msg');
  const roomAlert = document.getElementById('room-alert');
  const answerRecStatus = document.getElementById('answer-rec-status');
  const logEl = document.getElementById('proctor-log');
  const recIndicator = document.getElementById('rec-indicator');
  const roomLiveBadge = document.getElementById('room-live-badge');
  const roomWaveform = document.getElementById('room-waveform');
  const roomSessionFill = document.getElementById('room-session-fill');
  const roomSessionTime = document.getElementById('room-session-time');
  const qProgressEl = document.getElementById('q-progress');
  const qIndexEl = document.getElementById('q-index');
  const qTotalEl = document.getElementById('q-total');
  const qAudioStatusEl = document.getElementById('q-audio-status');
  const flagCountEl = document.getElementById('flag-count');
  const proctorAlert = document.getElementById('proctor-alert');
  const connectionBanner = document.getElementById('connection-banner');
  const completionScreen = document.getElementById('completion-screen');
  const proctoringTerminationScreen = document.getElementById('proctoring-termination-screen');
  const integrityBadge = document.getElementById('integrity-status-badge');
  const integrityScoreEl = document.getElementById('integrity-confidence-score');

  let videoStream = null;
  let sessionVideoRecorder = null;
  let answerAudioRecorder = null;
  let faceMesh = null;
  let faceMeshRunning = false;
  let snapshotTimer = null;
  let callActive = false;
  let startCallInFlight = false;
  let sessionPreparePromise = null;
  let sessionPrepareReady = false;
  let sessionPrepareData = null;
  let sessionPrepareError = '';
  let sessionPrepareInFlight = false;
  let interviewFinished = false;
  let currentQuestion = null;
  let lastCallStateForUi = null;
  let flagCount = 0;
  let answering = false;
  let presentingQuestion = false;
  const alertCooldown = new Map();
  let proctorAlertAudioChain = Promise.resolve();
  const pendingProctorEscalations = [];
  const PROCTOR_AUDIO_ENABLED = true;
  let proctorWarningIssued = false;
  let lastHandledWarningCount = 0;
  let proctorTerminationInProgress = false;
  let uiClickUntil = 0;
  let proctorAlertHideTimer = null;
  const FOCUS_LOSS_FLAG = 'suspicious_activity_tab_switch';
  const FOCUS_LOSS_COALESCE_MS = 2500;
  const FOCUS_POLL_MS = 400;
  /** Ignore focus-loss flags briefly after call start (TTS loading, window setup). */
  const CALL_START_FOCUS_GRACE_MS = 12_000;
  let lastFocusLossReportAt = 0;
  let focusLossReportInFlight = false;
  let lastDocumentFocused = true;
  let focusPollInterval = null;
  let headphonesOk = false;
  let headphonesScanComplete = false;
  let headphonesBlocked = false;
  let headphonePollTimer = null;
  let headphoneDeviceChangeTimer = null;
  let headphoneRemovalMissCount = 0;
  const HEADPHONE_DEVICE_CHANGE_DEBOUNCE_MS = 1500;
  const HEADPHONE_REMOVAL_MISS_THRESHOLD = 3;
  const HEADPHONE_DEVICE_CHANGE_RETRY_MS = 1200;
  let greetingPlayed = false;
  let autoSubmit = null;
  let autoSubmitEnabled = false;
  let lastSpokenQuestionText = '';
  let questionRepeatInFlight = false;
  let lastRepeatTriggerAt = 0;
  let interviewAgentPaused = false;
  const QUESTION_REPEAT_COOLDOWN_MS = 8000;
  let sessionTimerInterval = null;
  let callStartedAt = 0;
  const NEXT_QUESTION_DELAY_MS =
    window.AutoSubmitAnswer?.constants?.NEXT_QUESTION_DELAY_MS ?? 2000;

  let assessmentCompleted = false;
  let completionInFlight = false;
  let completionRetryTimer = null;
  let endInterviewApiSucceeded = false;
  let interviewUiFinalized = false;
  const END_INTERVIEW_MAX_RETRIES = 5;
  /** Safety cap only — we await full recording stop, not a fixed grace race. */
  const RECORDING_STOP_TIMEOUT_MS = 90000;
  const PENDING_STATUS_KEY = 'pendingInterviewEnd';
  const START_FETCH_TIMEOUT_MS = 15000;
  const START_FETCH_MAX_ATTEMPTS = 3;
  const START_FETCH_RETRY_DELAY_MS = 1500;
  const CONNECTION_BANNER_DELAY_MS = 3500;
  const PREPARE_FETCH_TIMEOUT_MS = 120000;
  const PREPARE_FETCH_MAX_ATTEMPTS = 2;

  let connectionBannerTimer = null;
  let prepareStatusTimer = null;
  let prepareStatusStartedAt = 0;
  let callConnectivityMonitor = null;
  let startButtonReadyMarked = false;
  let questionTtsPrefetchStarted = false;

  function getQuestionPosition(state = lastCallStateForUi) {
    const total = Number(state?.total_questions) || 0;
    const answered = Number(state?.answered_count) || 0;
    const index = Math.min(answered + 1, total || answered + 1);
    return {
      total,
      answered,
      index,
      isLastQuestion: total > 0 && index >= total,
    };
  }

  function isLastQuestion(state = lastCallStateForUi) {
    return getQuestionPosition(state).isLastQuestion;
  }

  function isAssessmentComplete(state) {
    if (!state) return false;
    if (state.completed) return true;
    const total = Number(state.total_questions) || 0;
    const answered = Number(state.answered_count) || 0;
    return total > 0 && answered >= total;
  }

  async function resolveAdvancedState(initialState, submittedQuestionId) {
    let state = initialState || null;
    if (!submittedQuestionId) return state;

    // Defensive retry: occasionally call_state can briefly reflect the previous question.
    for (let i = 0; i < 8; i += 1) {
      if (!state) return state;
      if (isAssessmentComplete(state)) return state;
      if (state.current_question?.id !== submittedQuestionId) return state;
      await new Promise((r) => setTimeout(r, 300));
      state = await refreshCallState();
    }
    return state;
  }

  const autoSubmitUi = {
    panel: document.getElementById('auto-submit-panel'),
    status: document.getElementById('auto-submit-status'),
    timer: document.getElementById('auto-submit-timer'),
    transcript: document.getElementById('auto-submit-transcript'),
    prompt: document.getElementById('auto-submit-prompt'),
    hint: document.getElementById('auto-submit-hint'),
    countdown: document.getElementById('auto-submit-countdown'),
    countdownOverlay: document.getElementById('answer-start-countdown-overlay'),
    countdownNum: document.getElementById('answer-start-countdown-num'),
    volumeBar: document.getElementById('auto-submit-volume-bar'),
    overlay: document.getElementById('auto-submit-overlay'),
    speechBanner: document.getElementById('speech-unsupported-banner'),
    setPanelVisible(show) {
      autoSubmitUi.panel?.classList.toggle('d-none', !show);
    },
    setState(state, message) {
      if (autoSubmitUi.status && message) autoSubmitUi.status.textContent = message;
    },
    setTimerRemaining(text) {
      if (autoSubmitUi.timer) {
        const t = String(text).replace(/\s*remaining\s*/i, '').trim();
        autoSubmitUi.timer.textContent = t.includes('/') ? t : `${t} / 5:00`;
      }
    },
    updateTranscript(text) {
      if (autoSubmitUi.transcript) {
        autoSubmitUi.transcript.textContent = text || '(listening…)';
        autoSubmitUi.transcript.scrollTop = autoSubmitUi.transcript.scrollHeight;
      }
    },
    setVolumeLevel(level) {
      const pct = Math.round(level * 100);
      if (autoSubmitUi.volumeBar) {
        autoSubmitUi.volumeBar.style.width = `${pct}%`;
      }
      const bars = document.querySelectorAll('#room-wave-bars .wave-bar');
      bars.forEach((bar, i) => {
        const h = 6 + Math.abs(Math.sin(i * 0.65 + level * 12)) * 30 * Math.max(0.15, level);
        bar.style.height = `${Math.round(h)}px`;
      });
    },
    showPrompt(text) {
      if (autoSubmitUi.prompt) {
        autoSubmitUi.prompt.textContent = text;
        autoSubmitUi.prompt.classList.remove('d-none');
      }
    },
    showNextButton() {
      btnNextQuestion?.classList.remove('d-none');
      const pos = getQuestionPosition();
      if (btnNextQuestion && pos.isLastQuestion) {
        btnNextQuestion.innerHTML = `${sessionLabels().finishButton || 'Finish Assessment'} <i class="bi bi-check-lg" aria-hidden="true"></i>`;
        btnNextQuestion.title = sessionLabels().finishButtonTitle || 'Submit your final answer and complete the assessment';
      } else if (btnNextQuestion) {
        btnNextQuestion.innerHTML = 'Next Question <i class="bi bi-arrow-right" aria-hidden="true"></i>';
        btnNextQuestion.title = 'Submit your answer and go to the next question';
      }
    },
    hideNextButton() {
      btnNextQuestion?.classList.add('d-none');
    },
    showCountdown() {},
    hideCountdown() {
      document.body.classList.remove('answer-countdown-active');
    },
    showSubmittingOverlay(show) {
      autoSubmitUi.overlay?.classList.toggle('d-none', !show);
    },
    setStatusLine(text) {
      if (autoSubmitUi.status) autoSubmitUi.status.textContent = text;
    },
  };

  function handleCompletionError(error) {
    console.error('[Assessment] Completion error — showing retry UI', error);
    showCompletionUI(
      'Almost done',
      sessionLabels().finalizingError || 'We encountered an issue finalising your assessment. Retrying automatically…'
    );
    if (completionRetryTimer) clearTimeout(completionRetryTimer);
    completionRetryTimer = setTimeout(() => {
      if (!endInterviewApiSucceeded) {
        console.log('[Assessment] Silent retry of completion API');
        void completeInterviewFlow().then(() => {
          assessmentCompleted = true;
          showCompletionUI(
            sessionLabels().completionTitle || 'Assessment completed',
            'Thank you for your time.'
          );
          console.log('[Assessment] Completion retry succeeded — feedback email should trigger');
        }).catch((retryErr) => {
          console.error('[Assessment] Completion retry failed:', retryErr);
        });
      }
    }, 5000);
  }

  async function resolveCompleteCallState(state, submittedQuestionId, { forceComplete = false } = {}) {
    let callState = state || (await refreshCallState());
    callState = await resolveAdvancedState(callState, submittedQuestionId);

    if (!isAssessmentComplete(callState)) {
      for (let i = 0; i < 8; i += 1) {
        await new Promise((r) => setTimeout(r, 400));
        callState = await refreshCallState();
        if (isAssessmentComplete(callState)) break;
      }
    }

    if (!isAssessmentComplete(callState) && forceComplete) {
      console.warn('[Assessment] Forcing completion after last-question submit', {
        answered: callState?.answered_count,
        total: callState?.total_questions,
        completed: callState?.completed,
      });
    } else if (!isAssessmentComplete(callState)) {
      throw new Error('Assessment state is not complete after final answer submit');
    }

    return callState;
  }

  async function waitForRecordingStop() {
    const stats = await Promise.race([
      stopSessionVideoRecording(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Recording stop timed out after ${RECORDING_STOP_TIMEOUT_MS / 1000}s`)),
          RECORDING_STOP_TIMEOUT_MS
        )
      ),
    ]).catch((err) => {
      console.error('[room] Recording stop error:', err.message || err);
      return null;
    });

    if (stats) {
      console.log('[room] Session video recording stopped', stats);
      if (stats.failedCount > 0) {
        console.error(
          `[room] WARNING: Recording finished with ${stats.failedCount} failed chunk(s) — merged video may be truncated`
        );
      }
      if (window.INTERVIEW_RECORDING_TRACE) {
        console.log('[recording-trace] stop_final', JSON.stringify(stats));
      }
    }
    return stats;
  }

  async function callEndInterviewApi(recordingStats = null) {
    let lastError = null;
    for (let attempt = 0; attempt < END_INTERVIEW_MAX_RETRIES; attempt += 1) {
      try {
        if (attempt > 0) {
          console.log(`[Assessment] Retrying POST /end (${attempt + 1}/${END_INTERVIEW_MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
        const res = await fetch(`/interview/${token}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            suspicious: flagCount > 4,
            recording: recordingStats
              ? {
                  parts: recordingStats.parts,
                  acked: recordingStats.ackedChunkCount,
                  failed: recordingStats.failedCount,
                  total_bytes: recordingStats.totalBytes,
                  failed_indexes: recordingStats.failedIndexes || [],
                }
              : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to finalize');
        endInterviewApiSucceeded = true;
        try {
          localStorage.removeItem(PENDING_STATUS_KEY);
        } catch (_) {}
        log('Interview saved — completion webhook dispatched if configured');
        console.log('[room] Interview /end succeeded', data);
        if (data.webhook) {
          try {
            localStorage.setItem(
              `webhookLog_${window.INTERVIEW_SESSION_ID || token}`,
              JSON.stringify({
                status: data.webhook.delivered ? 'success' : 'failed',
                savedAt: new Date().toISOString(),
                attempts: data.webhook.attempt_log || [],
                skipped: data.webhook.skipped === true,
                reason: data.webhook.reason || null,
              })
            );
          } catch (_) {}
        }
        return data;
      } catch (e) {
        lastError = e;
        console.error('[room] Interview /end attempt failed:', e.message || e);
      }
    }
    try {
      localStorage.setItem(
        PENDING_STATUS_KEY,
        JSON.stringify({
          token,
          sessionId: window.INTERVIEW_SESSION_ID || null,
          completedAt: new Date().toISOString(),
        })
      );
    } catch (_) {}
    throw lastError || new Error('Failed to finalize assessment');
  }

  async function recoverPendingInterviewEnd() {
    let pending = null;
    try {
      pending = JSON.parse(localStorage.getItem(PENDING_STATUS_KEY) || 'null');
    } catch (_) {
      pending = null;
    }
    if (!pending?.token || pending.token !== token) return;
    console.log('[Assessment] Recovering pending interview end for session');
    try {
      await callEndInterviewApi();
      console.log('[Assessment] Pending interview end recovered successfully');
    } catch (err) {
      console.error('[Assessment] Pending interview end recovery failed:', err.message);
    }
  }

  async function handleAssessmentCompletion({ state, submittedData, forceComplete = false } = {}) {
    if (assessmentCompleted && endInterviewApiSucceeded) {
      console.warn('[Assessment] Completion already triggered — ignoring duplicate call');
      return;
    }
    if (completionInFlight) {
      console.warn('[Assessment] Completion already in flight — ignoring duplicate call');
      return;
    }
    completionInFlight = true;

    console.log('[Assessment] Assessment complete — starting completion flow', { forceComplete });

    try {
      const submittedQuestionId = Number(submittedData?.question_id) || currentQuestion?.id || null;
      let callState = state || submittedData?.call_state || null;
      callState = await resolveCompleteCallState(callState, submittedQuestionId, { forceComplete });
      lastCallStateForUi = callState;

      try {
        if (window.InterviewVoice) {
          await window.InterviewVoice.speak(
            sessionLabels().completionAudio || 'You have completed all questions. Thank you for your assessment.'
          );
        }
      } catch (ttsErr) {
        console.warn('[Assessment] Completion TTS failed:', ttsErr.message);
      }

      await completeInterviewFlow();
      assessmentCompleted = true;
      console.log('[Assessment] Full completion flow finished — feedback email should trigger');
    } catch (error) {
      assessmentCompleted = false;
      console.error('[Assessment] Completion flow failed:', error);
      handleCompletionError(error);
    } finally {
      completionInFlight = false;
    }
  }

  function initAutoSubmit() {
    autoSubmitEnabled = window.AutoSubmitAnswer?.isSpeechRecognitionSupported?.() ?? false;
    if (!autoSubmitEnabled) {
      autoSubmitUi.speechBanner?.classList.remove('d-none');
      return;
    }
    autoSubmit = window.AutoSubmitAnswer.create({
      token,
      ui: autoSubmitUi,
      getCurrentQuestionId: () => currentQuestion?.id ?? null,
      getQuestionPosition: () => getQuestionPosition(),
      getMicStream: createAnswerAudioStream,
      onRecordingStart: () => startAnswerRecording(),
      onSubmitAnswer: async (transcript) => submitCurrentAnswer(transcript, { forceSubmit: true }),
      onAfterSubmit: async (data) => {
        const submittedQuestionId = Number(data?.question_id) || null;
        const wasLastQuestion = isLastQuestion();
        let state = data.call_state || (await refreshCallState());
        state = await resolveAdvancedState(state, submittedQuestionId);
        lastCallStateForUi = state;

        const shouldComplete =
          isAssessmentComplete(state) ||
          !state.current_question ||
          state.completed ||
          wasLastQuestion;

        if (shouldComplete) {
          console.log('[Assessment] Post-submit completion route', {
            wasLastQuestion,
            answered: state.answered_count,
            total: state.total_questions,
            completed: state.completed,
          });
          await handleAssessmentCompletion({
            state,
            submittedData: data,
            forceComplete: wasLastQuestion,
          });
          return { completed: true };
        }

        if (msgEl) msgEl.textContent = 'Moving to next question…';
        await new Promise((r) => setTimeout(r, NEXT_QUESTION_DELAY_MS));
        if (!state.completed && state.current_question?.id === submittedQuestionId) {
          state = await refreshCallState();
          lastCallStateForUi = state;
        }
        await showQuestionForAnswer(state);
        return { completed: false };
      },
      onError: (message) => showError(message),
      onTranscriptUpdate: (text) => {
        window.InterviewTelemetry?.reportSpeechTranscript?.(text);
      },
      onCandidateUtterance: (text) => handleCandidateUtterance(text),
      onRepeatQuestion: async ({ spokenText, skipPause }) => {
        await handleQuestionRepeat({
          spokenText: spokenText || 'please repeat the question',
          source: 'voice',
          fromConfirmation: false,
          skipPause: !!skipPause,
        });
      },
      onGiveUp: () => {
        autoSubmitUi.setPanelVisible(false);
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.classList.remove('room-btn-muted');
          btnSubmit.title = 'Submit your answer manually';
        }
        setAnswerRecStatus('Auto-submit unavailable — use Submit when ready.');
        if (callActive && currentQuestion && !headphonesBlocked) {
          startAnswerRecording();
        }
        window.InterviewVoice?.speak(
          "I couldn't understand your response. Please use the Submit button to continue."
        );
        log('Manual submit enabled (auto-submit gave up)', true);
      },
    });
    btnNextQuestion?.addEventListener('click', () => {
      const pos = getQuestionPosition();
      if (pos.isLastQuestion) {
        console.log('[Assessment] Manual NEXT on last question — submitting and triggering completion');
      } else {
        console.log('[Assessment] Manual NEXT — loading next question after submit');
      }
      autoSubmit?.handleNextQuestion?.();
    });
  }

  async function submitCurrentAnswer(transcript = '', { forceSubmit = false } = {}) {
    if (!callActive || !currentQuestion || interviewFinished) {
      throw new Error('Cannot submit right now');
    }
    if (headphonesBlocked) {
      throw new Error('Reconnect your headphones before submitting an answer.');
    }
    if (sessionStorage.getItem(`mission_hp_${token}`)) {
      const hp = await scanHeadphones({ requireVerifiedDevice: true });
      if (!hp.ok) {
        throw new Error('Headphones are required to submit answers.');
      }
    }

    answering = true;
    if (btnSubmit) btnSubmit.disabled = true;
    if (btnPlayQuestion) btnPlayQuestion.disabled = true;
    window.InterviewVoice?.stop?.();
    try {
      window.speechSynthesis?.cancel();
    } catch (_) {}
    if (autoSubmit?.abortForExternalSubmit && autoSubmit?.state !== 'SUBMITTING') {
      autoSubmit.abortForExternalSubmit();
    }

    const finalTranscript = (transcript || autoSubmit?.flushInterimTranscript?.() || autoSubmit?.getTranscript?.() || '').trim();

    try {
      if (msgEl) msgEl.textContent = 'Transcribing and scoring your answer…';

      const { blob, elapsed } = await stopAnswerRecording();
      const hasText = finalTranscript.length >= 10;

      if (!forceSubmit && !hasText) {
        if (elapsed && elapsed < MIN_ANSWER_MS) {
          throw new Error(`Please speak for at least ${MIN_ANSWER_MS / 1000} seconds before submitting.`);
        }
        if (!blob || blob.size < MIN_ANSWER_BYTES) {
          throw new Error('Answer too short or not captured. Speak clearly, then try again.');
        }
      }

      const fd = new FormData();
      fd.append('question_id', String(currentQuestion.id));
      // Browser STT hint only — server transcribes answer_audio with Whisper for scoring.
      if (finalTranscript) fd.append('text_answer', finalTranscript);
      if (blob && blob.size > 0) {
        fd.append('answer_audio', blob, `answer_q${currentQuestion.id}.webm`);
      } else if (!forceSubmit && !hasText) {
        throw new Error('No answer captured. Speak your answer or record audio.');
      }

      const res = await fetch(`/interview/${token}/call/answer`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submit failed');

      const preview = (data.transcript || finalTranscript || '').slice(0, 120);
      const sourceLabel = data.transcript_source === 'whisper' ? ' (Whisper)' : '';
      log(
        `Answer saved (score ${data.score ?? '—'}/10)${sourceLabel}${preview ? ': "' + preview + (preview.length >= 120 ? '…' : '') + '"' : ''}`
      );
      if (msgEl) msgEl.textContent = '';
      autoSubmitUi.prompt?.classList.add('d-none');
      autoSubmitUi.hint?.classList.add('d-none');

      return data;
    } finally {
      window.InterviewTelemetry?.markAnswerPhaseEnd?.();
      window.InterviewIntegrityMonitor?.setCandidateSpeaking?.(false);
      answering = false;
    }
  }

  function applySessionToken(nextToken) {
    if (!nextToken || nextToken === token) return;
    const prev = token;
    token = nextToken;
    window.INTERVIEW_TOKEN = nextToken;
    if (sessionVideoRecorder?.setToken) {
      sessionVideoRecorder.setToken(nextToken);
    } else if (sessionVideoRecorder) {
      sessionVideoRecorder.token = nextToken;
    }
    if (prev !== nextToken) {
      console.log('[recording-client] session token rotated for uploads');
    }
    const path = window.location.pathname.replace(
      /\/interview\/[^/]+/,
      `/interview/${encodeURIComponent(nextToken)}`
    );
    window.history.replaceState(null, '', `${path}${window.location.search}${window.location.hash}`);
  }

  function updateIntegrityUI(proctoring) {
    if (!integrityBadge || !proctoring) return;
    const status = proctoring.integrity_status || 'ok';
    const count = proctoring.warning_count || 0;
    integrityBadge.className = 'integrity-status-badge integrity-' + status;
    const labels = {
      ok: 'Integrity OK',
      elevated: 'Integrity Elevated',
      warning:
        count >= PROCTOR_FINAL_WARNING_STRIKE
          ? 'Final Warning Issued'
          : count > 0
            ? `Warning ${count}`
            : 'Warning Issued',
      critical: 'Final Warning — comply now',
      terminated: 'Terminated',
    };
    integrityBadge.textContent = labels[status] || 'Integrity OK';
    if (integrityScoreEl && proctoring.confidence_score != null) {
      integrityScoreEl.textContent = String(proctoring.confidence_score);
    }
  }

  function proctorActivityLabel(eventType) {
    return proctorMessages().violationLabel?.(eventType) || String(eventType || 'unknown');
  }

  function proctorEscalationCopy(eventType, action, proctoring) {
    if (proctoring?.banner_text && proctoring?.audio_text) {
      return { banner: proctoring.banner_text, audio: proctoring.audio_text };
    }
    return (
      proctorMessages().buildEscalationMessages?.(eventType, action, sessionLabels()) || {
        banner: `Warning: ${proctorActivityLabel(eventType)} Detected`,
        audio: '',
      }
    );
  }

  function normalizeProctorEventType(eventType) {
    const raw = String(eventType || 'suspicious_activity')
      .toLowerCase()
      .replace(/\s+/g, '_');
    if (raw.startsWith('suspicious_activity_')) return raw;
    const legacyMap = {
      no_face: 'suspicious_activity_face_missing',
      face_absent_duration: 'suspicious_activity_face_missing',
      excessive_head_movement: 'suspicious_activity_head_movement',
      face_looking_away: 'suspicious_activity_off_screen_gaze',
      face_rotation: 'suspicious_activity_face_rotation',
      tab_switch: 'suspicious_activity_tab_switch',
      window_blur: 'suspicious_activity_window_blur',
      mic_muted: 'suspicious_activity_mic_muted',
      camera_disabled: 'suspicious_activity_camera_disabled',
      suspicious_pattern: 'suspicious_activity_pattern',
      headphones_removed: 'suspicious_activity_headphones_removed',
      question_repeated: 'suspicious_activity_question_repeated',
      identity_mismatch: 'suspicious_activity_identity_mismatch',
      mobile_phone_detected: 'suspicious_activity_mobile_detected',
      leaving_camera_frame: 'suspicious_activity_left_frame',
      excessive_eye_movement: 'suspicious_activity_eye_movement',
      downward_gaze: 'suspicious_activity_downward_gaze',
      off_screen_gaze: 'suspicious_activity_off_screen_gaze',
      reading_pattern_detected: 'suspicious_activity_reading_pattern',
      low_screen_attention: 'suspicious_activity_low_attention',
      pre_answer_downward_glance: 'suspicious_activity_pre_answer_glance',
      hidden_device_attention: 'suspicious_activity_hidden_device',
      attention_correlation: 'suspicious_activity_attention_correlation',
      webcam_obstruction: 'suspicious_activity_webcam_obstruction',
    };
    return legacyMap[raw] || `suspicious_activity_${raw}`;
  }

  function postFlowDebug(label, meta) {
    fetch(`/interview/${token}/flow-debug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, meta, ts: new Date().toISOString() }),
    }).catch(() => {});
  }

  /** True only while interview/question TTS is actively playing — not silence guards after repeat. */
  function isInterviewSpeechPlaying() {
    return (
      autoSubmit?.isAssessmentSpeakActive?.() ||
      presentingQuestion ||
      questionRepeatInFlight ||
      window.InterviewVoice?.isSpeaking?.()
    );
  }

  async function drainDeferredProctorEscalations() {
    while (pendingProctorEscalations.length) {
      const item = pendingProctorEscalations.shift();
      if (interviewFinished || proctorTerminationInProgress) break;
      if (item.action === 'warning' || item.action === 'final_warning') {
        const count = item.proctoring?.warning_count || 0;
        if (count > lastHandledWarningCount) {
          await issueProctorStrike(item.proctoring || {}, item.eventType, item.action);
        }
      }
    }
    if (!pendingProctorEscalations.length && deferredProctorDrainTimer) {
      clearInterval(deferredProctorDrainTimer);
      deferredProctorDrainTimer = null;
    }
  }

  async function speakProctoringMessage(_key, text) {
    if (!text) {
      proctorLog('Audio playback skipped: empty message');
      return false;
    }
    if (!PROCTOR_AUDIO_ENABLED) {
      proctorLog('Audio playback skipped: audio disabled');
      return false;
    }
    proctorLog('Attempting audio playback');
    try {
      proctorAlertAudioChain = proctorAlertAudioChain.then(async () => {
        try {
          window.InterviewVoice?.stop?.();
          try {
            window.speechSynthesis?.cancel?.();
          } catch (_) {}
          await window.InterviewVoice?.waitUntilIdle?.();
          let waitLoops = 0;
          while (isInterviewSpeechPlaying() && waitLoops < 30) {
            await new Promise((r) => setTimeout(r, 100));
            waitLoops += 1;
          }
          if (autoSubmit?.holdForProctor) await autoSubmit.holdForProctor({ force: true });
          if (!window.InterviewVoice?.canSpeak?.()) {
            throw new Error('Speech synthesis unavailable');
          }
          try {
            window.speechSynthesis?.resume?.();
          } catch (_) {}
          const ok = await window.InterviewVoice.speak(text, {
            interrupt: true,
            rate: 0.9,
            volume: 1,
            minGapMs: 0,
            proctor: true,
          });
          if (ok === false) {
            throw new Error('InterviewVoice.speak returned false');
          }
        } finally {
          if (autoSubmit?.releaseProctorHold) await autoSubmit.releaseProctorHold();
        }
      });
      await proctorAlertAudioChain;
      proctorLog('Audio playback successful');
      return true;
    } catch (e) {
      proctorLog('Audio playback failed', { error: e?.message || String(e) });
      return false;
    }
  }

  async function issueProctorStrike(proctoring, eventType, action) {
    if (proctorTerminationInProgress) return false;
    const warningCount = proctoring?.warning_count || 0;
    if (warningCount <= lastHandledWarningCount) {
      proctorLog('Warning audio skipped: already handled strike', {
        activity: proctorLogActivityKey(eventType),
        warning_count: warningCount,
      });
      return false;
    }
    lastHandledWarningCount = warningCount;
    proctorWarningIssued = true;

    const activity = proctorLogActivityKey(eventType);
    proctorLog('Warning received from server', {
      activity,
      warning_count: warningCount,
      action,
    });

    const { banner, audio } = proctorEscalationCopy(eventType, action, proctoring);
    showProctorAlert(banner);
    const logPrefix =
      action === 'final_warning'
        ? 'Proctoring final warning'
        : `Proctoring warning ${warningCount}`;
    log(`${logPrefix}: ${proctorActivityLabel(eventType)}`, true);
    updateIntegrityUI(proctoring);
    postFlowDebug(action === 'final_warning' ? 'proctor_final_warning_audio' : 'proctor_warning_audio', {
      event_type: eventType,
      activity: proctorActivityLabel(eventType),
      warning_count: warningCount,
    });
    if (PROCTOR_AUDIO_ENABLED && audio) {
      proctorLog('Warning audio triggered', {
        activity: proctorLogActivityKey(eventType),
        warning_count: warningCount,
        action,
      });
    }
    return speakProctoringMessage(null, audio);
  }

  function proctorLogActivityKey(eventType) {
    return (
      window.ProctoringClientLog?.activityKey?.(eventType) ||
      proctorActivityLabel(eventType).toLowerCase().replace(/\s+/g, '_')
    );
  }

  function isFocusLossEventType(eventType) {
    const normalized = normalizeProctorEventType(eventType);
    return normalized === FOCUS_LOSS_FLAG || normalized === 'suspicious_activity_window_blur';
  }

  function isAssessmentFocused() {
    return !document.hidden && document.hasFocus();
  }

  function reportFocusLoss(source) {
    if (!callActive || proctorTerminationInProgress) return;
    if (callStartedAt && Date.now() - callStartedAt < CALL_START_FOCUS_GRACE_MS) return;
    if (isAssessmentFocused()) return;

    const now = Date.now();
    if (now - lastFocusLossReportAt < FOCUS_LOSS_COALESCE_MS) return;
    if (focusLossReportInFlight) return;

    lastFocusLossReportAt = now;
    focusLossReportInFlight = true;

    console.log('[PROCTORING] Window blur detected');
    console.log('[PROCTORING] Visibility state:', document.visibilityState);
    console.log('[PROCTORING] Tab switch violation triggered');

    void logSuspicious(
      FOCUS_LOSS_FLAG,
      'Browser tab switching detected during assessment',
      { focus_source: source }
    ).finally(() => {
      focusLossReportInFlight = false;
    });
  }

  function tickFocusPoll() {
    if (!callActive || proctorTerminationInProgress) return;
    const focused = isAssessmentFocused();
    if (lastDocumentFocused && !focused) {
      reportFocusLoss('focus_poll');
    }
    lastDocumentFocused = focused;
  }

  function startFocusMonitor() {
    stopFocusMonitor();
    lastDocumentFocused = isAssessmentFocused();
    focusPollInterval = setInterval(tickFocusPoll, FOCUS_POLL_MS);
  }

  function stopFocusMonitor() {
    if (focusPollInterval) {
      clearInterval(focusPollInterval);
      focusPollInterval = null;
    }
  }

  async function terminateProctoringFlow(proctoring, eventType) {
    if (proctorTerminationInProgress || interviewFinished) return;
    proctorTerminationInProgress = true;
    interviewFinished = true;
    callActive = false;
    stopFocusMonitor();
    stopCallConnectivityMonitor();
    autoSubmit?.stop();
    stopSessionTimer();
    stopHeadphoneMonitor();
    window.InterviewPhoneDetector?.stop?.();
    stopWebcamObstructionMonitor();
    stopIntegrityMonitor();
    faceMeshRunning = false;
    window.speechSynthesis?.cancel();

    if (btnSubmit) btnSubmit.disabled = true;
    if (btnEnd) btnEnd.disabled = true;
    if (btnStart) btnStart.disabled = true;
    if (btnPlayQuestion) btnPlayQuestion.disabled = true;

    const { banner, audio } = proctorEscalationCopy(
      eventType,
      'terminate',
      proctoring
    );
    showProctorAlert(banner);
    document.body.classList.add('proctoring-terminated');
    if (proctoringTerminationScreen) {
      proctoringTerminationScreen.classList.add('is-visible');
      document.body.classList.add('interview-completing');
    } else {
      showCompletionUI(banner, audio);
    }
    updateIntegrityUI({ ...(proctoring || {}), integrity_status: 'terminated', confidence_score: 0 });
    log(
      `Assessment terminated — ${proctorActivityLabel(eventType)} (strike ${PROCTOR_TERMINATION_STRIKE})`,
      true
    );
    postFlowDebug('proctor_terminate_audio', {
      event_type: eventType,
      activity: proctorActivityLabel(eventType),
      warning_count: proctoring?.warning_count || PROCTOR_TERMINATION_STRIKE,
    });

    proctorLog('Assessment termination audio', {
      activity: proctorLogActivityKey(eventType),
      warning_count: proctoring?.warning_count || PROCTOR_TERMINATION_STRIKE,
      action: 'terminate',
    });

    // Persist recordings — wait for full upload drain before /end so merge sees all chunks.
    let proctorRecordingStats = null;
    try {
      await stopAnswerRecording();
      stopSnapshotCapture();
      if (window.InterviewTelemetry) InterviewTelemetry.stop();
      proctorRecordingStats = await waitForRecordingStop();
    } catch (e) {
      console.error('[room] Proctoring termination recording flush failed', e);
    }

    // Finalize on server BEFORE termination audio — webhook, call_ended, and feedback email must not wait on TTS.
    try {
      const res = await fetch(`/interview/${token}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          proctoring_terminated: true,
          suspicious: true,
          recording: proctorRecordingStats
            ? {
                parts: proctorRecordingStats.parts,
                acked: proctorRecordingStats.ackedChunkCount,
                failed: proctorRecordingStats.failedCount,
                total_bytes: proctorRecordingStats.totalBytes,
                failed_indexes: proctorRecordingStats.failedIndexes || [],
              }
            : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[room] Proctoring termination /end failed', data);
      } else {
        console.log('[room] Proctoring termination /end', data);
        if ((data.recording?.chunks_on_disk ?? data.recording?.chunks_in_db ?? 0) === 0) {
          console.error('[room] WARNING: No recording chunks persisted for terminated session');
        }
      }
    } catch (e) {
      console.error('[room] Proctoring termination save failed', e);
    }

    await speakProctoringMessage(null, audio);

    videoStream?.getTracks().forEach((t) => t.stop());
    setTimeout(() => {
      try {
        window.close();
      } catch (_) {}
    }, 4000);
  }

  async function handleProctoringEscalation(proctoring, action, eventType) {
    if (interviewFinished || proctorTerminationInProgress) return;

    const flagType =
      eventType ||
      proctoring?.trigger_flag_type ||
      proctoring?.last_flag_type ||
      'suspicious_activity';

    proctorLog('Escalation handler invoked', {
      activity: proctorLogActivityKey(flagType),
      action: action || (proctoring?.terminate ? 'terminate' : 'none'),
      warning_count: proctoring?.warning_count,
    });

    if (proctoring) {
      updateIntegrityUI(proctoring);
      if (proctoring.warning_issued) proctorWarningIssued = true;
    }

    if (action === 'terminate' || proctoring?.terminate) {
      if (pendingProctorEscalations.length) {
        await drainDeferredProctorEscalations();
      }
      pendingProctorEscalations.length = 0;
      if (deferredProctorDrainTimer) {
        clearInterval(deferredProctorDrainTimer);
        deferredProctorDrainTimer = null;
      }
      await terminateProctoringFlow(proctoring || {}, flagType);
      return;
    }

    const strikeAction =
      action === 'final_warning' ? 'final_warning' : action === 'warning' ? 'warning' : null;
    if (!strikeAction) return;

    const warningCount = proctoring?.warning_count || 0;
    if (warningCount <= lastHandledWarningCount) {
      proctorLog('Escalation skipped: strike already handled', {
        activity: proctorLogActivityKey(flagType),
        warning_count: warningCount,
      });
      return;
    }

    await issueProctorStrike(proctoring || {}, flagType, strikeAction);
  }

  async function speakProctorAlert(eventType, fallbackMessage) {
    if (!PROCTOR_AUDIO_ENABLED) return;
    const text =
      proctorMessages().buildWarningAudio?.(eventType) ||
      (fallbackMessage ? String(fallbackMessage).replace(/^⚠\s*/, '') : '');
    if (text && window.InterviewVoice) {
      await window.InterviewVoice.waitUntilIdle?.();
      await window.InterviewVoice.speak(text, {
        interrupt: false,
        minGapMs: 600,
        rate: 0.92,
        volume: 1,
      });
    }
  }

  function playRoomGreeting() {
    if (greetingPlayed) return;
    greetingPlayed = true;
    const text = sessionLabels().welcomeAudioText;
    if (!text) {
      console.warn('[interview-room] welcomeAudioText missing — greeting skipped');
      return;
    }
    window.InterviewVoice?.speak(text, {
      rate: 0.92,
      volume: 1,
      msPerChar: 55,
      maxMs: Math.min(90000, Math.max(15000, text.length * 55)),
    });
  }

  function showError(message) {
    const text = message || 'Something went wrong';
    roomAlert?.classList.remove('d-none');
    if (roomAlert) roomAlert.textContent = text;
    if (msgEl) msgEl.textContent = text;
    console.error('[interview-room]', text);
  }

  function clearError() {
    roomAlert?.classList.add('d-none');
    if (msgEl) msgEl.textContent = '';
  }

  function log(text, warn) {
    const li = document.createElement('li');
    li.className = 'list-group-item' + (warn ? ' flag-warn' : '');
    li.textContent = new Date().toLocaleTimeString() + ' — ' + text;
    if (logEl?.children.length === 1 && logEl.children[0].textContent.includes('Waiting')) {
      logEl.innerHTML = '';
    }
    logEl?.prepend(li);
  }

  function markUiClick() {
    uiClickUntil = Date.now() + 2500;
  }

  function showProctorAlert(message) {
    if (!proctorAlert) return;
    proctorAlert.textContent = '⚠ ' + message;
    proctorAlert.classList.remove('d-none');
    if (proctorAlertHideTimer) clearTimeout(proctorAlertHideTimer);
    proctorAlertHideTimer = setTimeout(() => {
      hideProctorAlert();
      proctorAlertHideTimer = null;
    }, PROCTOR_ALERT_HIDE_MS);
  }

  function hideProctorAlert() {
    if (proctorAlertHideTimer) {
      clearTimeout(proctorAlertHideTimer);
      proctorAlertHideTimer = null;
    }
    proctorAlert?.classList.add('d-none');
  }

  function hideCompletionUI() {
    document.body.classList.remove('interview-completing');
    completionScreen?.classList.remove('is-visible');
  }

  function showCompletionUI(title, message) {
    document.getElementById('completion-title').textContent = title;
    document.getElementById('completion-message').textContent = message;
    document.body.classList.add('interview-completing');
    completionScreen?.classList.add('is-visible');
  }

  function showInvalidLinkUI() {
    interviewFinished = true;
    callActive = false;
    stopFocusMonitor();
    autoSubmit?.stop();
    document.querySelector('.room-root')?.classList.add('d-none');
    proctoringTerminationScreen?.classList.remove('is-visible');
    hideProctorAlert();
    hideCompletionUI();
    showCompletionUI('Invalid Link', 'This assessment link is no longer valid.');
  }

  const recordingSaveOverlay = null;

  function setRecordingSaveOverlay(_show, _text) {
    /* Saving overlay disabled — completion screen shows immediately. */
  }

  function startupMark(label) {
    if (typeof performance !== 'undefined' && performance.mark) {
      performance.mark(`interview:${label}`);
    }
    console.log(`[interview-startup] ${label} +${Math.round(performance.now())}ms`);
  }

  function showConnectionBanner(message) {
    if (!connectionBanner) return;
    connectionBanner.textContent = message;
    connectionBanner.classList.remove('d-none');
  }

  function hideConnectionBanner() {
    if (connectionBannerTimer) {
      clearTimeout(connectionBannerTimer);
      connectionBannerTimer = null;
    }
    connectionBanner?.classList.add('d-none');
  }

  function startCallConnectivityMonitor() {
    if (!window.CallConnectivityMonitor?.create) return;
    stopCallConnectivityMonitor();
    callConnectivityMonitor = CallConnectivityMonitor.create({
      token,
      isCallActive: () => callActive && !interviewFinished,
      getUploadHealth: () => ({
        failedChunks: sessionVideoRecorder?.failedIndices?.size || 0,
        pendingUploads: sessionVideoRecorder?.uploadQueue?.pending || 0,
      }),
      onManualRetry: async () => {
        await refreshCallState().catch(() => {});
      },
    });
    callConnectivityMonitor.start();
  }

  function stopCallConnectivityMonitor() {
    callConnectivityMonitor?.stop();
    callConnectivityMonitor = null;
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = START_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error('Request timed out. Check your connection and try again.');
        err.code = 'FETCH_TIMEOUT';
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function startPrepareStatusTicker() {
    stopPrepareStatusTicker();
    prepareStatusStartedAt = Date.now();
    prepareStatusTimer = setInterval(() => {
      if (sessionPrepareReady || callActive || interviewFinished) {
        stopPrepareStatusTicker();
        return;
      }
      const sec = Math.floor((Date.now() - prepareStatusStartedAt) / 1000);
      if (!msgEl || startCallInFlight) return;
      const hasCamera = !!videoStream?.getVideoTracks?.().length;
      if (!headphonesOk || !hasCamera) return;
      msgEl.textContent =
        sec < 8
          ? 'Preparing assessment questions…'
          : `Still preparing questions… (${sec}s)`;
    }, 1000);
  }

  function stopPrepareStatusTicker() {
    if (prepareStatusTimer) {
      clearInterval(prepareStatusTimer);
      prepareStatusTimer = null;
    }
  }

  async function prefetchFirstQuestionTtsFromServer() {
    if (questionTtsPrefetchStarted) return null;
    questionTtsPrefetchStarted = true;
    try {
      const state = await refreshCallState();
      if (state?.current_question?.question_text) {
        return prefetchFirstQuestionTts(state);
      }
    } catch (_) {}
    questionTtsPrefetchStarted = false;
    return null;
  }

  async function ensureSessionPrepared() {
    if (sessionPrepareReady) return sessionPrepareData;
    if (sessionPreparePromise) {
      await sessionPreparePromise.catch(() => {});
      if (sessionPrepareReady) return sessionPrepareData;
    }
    sessionPrepareReady = false;
    sessionPreparePromise = null;
    const data = await prefetchSessionPrepare({ force: true });
    if (!sessionPrepareReady) {
      throw new Error('Assessment is still preparing. Please wait and try again.');
    }
    return data;
  }

  async function attemptStartInterview(attempt) {
    let bannerDelay;
    try {
      bannerDelay = setTimeout(() => {
        const msg =
          attempt > 1
            ? `Poor connection — retrying start (${attempt}/${START_FETCH_MAX_ATTEMPTS})…`
            : 'Still connecting — this is taking longer than usual…';
        showConnectionBanner(msg);
      }, CONNECTION_BANNER_DELAY_MS);

      const { res, data } = await fetchJsonWithTimeout(
        `/interview/${token}/start`,
        { method: 'POST' },
        START_FETCH_TIMEOUT_MS
      );

      if (res.status === 409 && data.code === 'SESSION_NOT_PREPARED') {
        const err = new Error(data.error || 'Assessment is still preparing.');
        err.code = 'SESSION_NOT_PREPARED';
        throw err;
      }
      if (!res.ok) {
        throw new Error(data.error || `Cannot start (${res.status})`);
      }
      return data;
    } finally {
      clearTimeout(bannerDelay);
    }
  }

  async function postStartInterview() {
    let lastErr;
    for (let attempt = 1; attempt <= START_FETCH_MAX_ATTEMPTS; attempt += 1) {
      try {
        const data = await attemptStartInterview(attempt);
        hideConnectionBanner();
        return data;
      } catch (e) {
        lastErr = e;
        if (e.code === 'SESSION_NOT_PREPARED') {
          hideConnectionBanner();
          sessionPrepareReady = false;
          sessionPreparePromise = null;
          if (msgEl) msgEl.textContent = 'Finishing preparation…';
          await ensureSessionPrepared();
          const data = await attemptStartInterview(attempt);
          hideConnectionBanner();
          return data;
        }
        if (attempt < START_FETCH_MAX_ATTEMPTS) {
          showConnectionBanner(
            e.code === 'FETCH_TIMEOUT'
              ? 'Connection timed out — retrying…'
              : `Could not start — retrying (${attempt + 1}/${START_FETCH_MAX_ATTEMPTS})…`
          );
          await new Promise((r) => setTimeout(r, START_FETCH_RETRY_DELAY_MS));
        }
      }
    }
    hideConnectionBanner();
    throw lastErr || new Error('Could not start assessment');
  }

  function updateStartButtonState() {
    if (!btnStart || callActive || interviewFinished) return;
    const hasCamera = !!videoStream?.getVideoTracks?.().length;

    if (!sessionPrepareReady) {
      btnStart.disabled = true;
      if (sessionPrepareError) {
        showError(sessionPrepareError);
        if (msgEl) {
          msgEl.textContent = `${sessionPrepareError} Refresh the page or contact your recruiter if this continues.`;
        }
      } else if (sessionPrepareInFlight && headphonesOk && hasCamera && msgEl) {
        msgEl.textContent = 'Preparing assessment questions…';
      } else if (!sessionPrepareInFlight && !sessionPrepareError && headphonesOk && hasCamera) {
        if (msgEl) msgEl.textContent = 'Loading assessment questions…';
      }
      if (!headphonesOk) {
        if (headphonesScanComplete) {
          showError('Headphones are required. Connect your headset before you can start the call.');
        }
      } else if (!hasCamera) {
        showError('Camera is not ready. Allow permissions and refresh the page.');
      }
      return;
    }

    const canStart = headphonesOk && hasCamera && sessionPrepareReady;
    btnStart.disabled = !canStart;
    if (canStart && !startButtonReadyMarked) {
      startButtonReadyMarked = true;
      startupMark('start-ready');
    }
    if (!canStart) {
      if (!headphonesOk) {
        if (headphonesScanComplete) {
          showError('Headphones are required. Connect your headset before you can start the call.');
        }
      } else if (!hasCamera) {
        showError('Camera is not ready. Allow permissions and refresh the page.');
      }
    } else {
      clearError();
      if (msgEl && !startCallInFlight) msgEl.textContent = '';
    }
  }

  function resetReadyUI() {
    hideCompletionUI();
    hideProctorAlert();
    hideConnectionBanner();
    stopCallConnectivityMonitor();
    stopPrepareStatusTicker();
    interviewFinished = false;
    callActive = false;
    stopFocusMonitor();
    updateStartButtonState();
    if (btnSubmit) btnSubmit.disabled = true;
    if (btnEnd) btnEnd.disabled = true;
    if (statusEl) {
      statusEl.textContent = 'Ready';
      statusEl.className = 'room-ready-badge';
    }
    stopSessionTimer();
    roomWaveform?.classList.remove('is-active');
    setAnswerRecStatus('');
  }

  function setAnswerRecStatus(text) {
    if (answerRecStatus) answerRecStatus.textContent = text || '';
  }

  function setRecordingActive(active) {
    recIndicator?.classList.toggle('d-none', !active);
    roomLiveBadge?.classList.toggle('d-none', !active);
    roomWaveform?.classList.toggle('is-active', !!active);
  }

  function startSessionTimer() {
    callStartedAt = Date.now();
    if (sessionTimerInterval) clearInterval(sessionTimerInterval);
    sessionTimerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - callStartedAt) / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      if (roomSessionTime) roomSessionTime.textContent = `${m}:${String(s).padStart(2, '0')}`;
      if (roomSessionFill) {
        roomSessionFill.style.width = `${Math.min(100, (sec / (30 * 60)) * 100)}%`;
      }
    }, 1000);
  }

  function stopSessionTimer() {
    if (sessionTimerInterval) {
      clearInterval(sessionTimerInterval);
      sessionTimerInterval = null;
    }
    if (roomSessionFill) roomSessionFill.style.width = '0%';
    if (roomSessionTime) roomSessionTime.textContent = '0:00';
  }

  function setAudioQuestionStatus(message) {
    if (!qAudioStatusEl) return;
    const t = String(message || '').trim();
    qAudioStatusEl.textContent = t || 'Questions are audio only — listen carefully';
  }

  function clearQuestionDisplay() {
    setAudioQuestionStatus('Questions are audio only — listen carefully');
  }

  function maybeDetectRepeatRequest(transcript) {
    if (!callActive || !currentQuestion?.id || questionRepeatInFlight || presentingQuestion) return;
    if (Date.now() - lastRepeatTriggerAt < QUESTION_REPEAT_COOLDOWN_MS) return;
    const text = String(transcript || '').trim();
    if (text.length < 8) return;
    const tail = text.slice(-140);
    const check = window.QuestionRepeatRequest?.classify?.(tail);
    if (!check?.isRepeatRequest) return;
    lastRepeatTriggerAt = Date.now();
    void handleQuestionRepeat({ spokenText: tail, source: 'voice' });
  }

  async function speakAssessmentResponse(text) {
    if (!text) return;
    autoSubmit?.beginAssessmentSpeak?.();
    if (autoSubmit?.abortConfirmationForAssessmentSpeak) {
      await autoSubmit.abortConfirmationForAssessmentSpeak();
    }
    setAnswerRecStatus('🔊 Interviewer responding…');
    await window.InterviewVoice?.waitUntilIdle?.();
    await window.InterviewVoice?.speak(text, {
      interrupt: false,
      rate: 0.95,
      volume: 1,
      minGapMs: 400,
    });
    if (autoSubmit?.resumeAfterAssessmentSpeak) {
      await autoSubmit.resumeAfterAssessmentSpeak();
    } else if (callActive && currentQuestion) {
      setAnswerRecStatus('Recording — speak your answer');
    }
    await drainDeferredProctorEscalations();
  }

  async function resumeCurrentQuestionVerbatim(questionText) {
    const text = String(questionText || currentQuestion?.question_text || '').trim();
    if (!text) return;
    interviewAgentPaused = false;
    await speakQuestionAloud(text, { isReplay: true });
  }

  function buildAssessmentStatePayload() {
    const state = lastCallStateForUi || {};
    return {
      phase: autoSubmit?.state === 'RECORDING' ? 'recording_answer' : autoSubmit?.state || 'recording_answer',
      question_index: (Number(state.answered_count) || 0) + 1,
      answered_count: Number(state.answered_count) || 0,
      is_paused: interviewAgentPaused,
      total_questions: Number(state.total_questions) || 0,
      recording: autoSubmit?.state === 'RECORDING',
    };
  }

  async function handleCandidateUtterance(spokenText) {
    if (!callActive || !currentQuestion?.id || presentingQuestion || questionRepeatInFlight) {
      return { handled: false };
    }
    const text = String(spokenText || '').trim();
    if (text.length < 3) return { handled: false };

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (autoSubmit?.isPostRepeatAnswerGrace?.() && wordCount >= 5) {
      const repeatOnly = window.QuestionRepeatRequest?.classify?.(text);
      const highConfidenceRepeat =
        repeatOnly?.isRepeatRequest && Number(repeatOnly.confidence) >= 0.72;
      if (!highConfidenceRepeat) {
        console.log('[repeat-flow] post-repeat grace — treating as answer', { words: wordCount });
        postFlowDebug('post_repeat_treat_as_answer', { words: wordCount, qid: currentQuestion.id });
        return { handled: false };
      }
    }

    const local = window.AssessmentIntentClient?.classify?.(text, {
      questionText: currentQuestion.question_text || '',
      isPaused: interviewAgentPaused,
    });
    const likelyNonAnswer =
      (local?.intent &&
        local.intent !== 'ANSWER' &&
        local.intent !== 'NOISE_OR_UNCLEAR_INPUT' &&
        (local.confidence ?? 0) >= 0.55) ||
      !!local?.edgeCase;
    const likelyAdvance = local?.intent === 'MOVE_TO_NEXT' && (local.confidence ?? 0) >= 0.72;
    const autoSubmitRecording = autoSubmit?.state === 'RECORDING';

    if (autoSubmitRecording && likelyAdvance) {
      return { handled: false };
    }

    if ((likelyNonAnswer || likelyAdvance) && autoSubmit?.abortConfirmationForAssessmentSpeak) {
      await autoSubmit.abortConfirmationForAssessmentSpeak();
    }
    if ((likelyNonAnswer || likelyAdvance) && autoSubmit?._armNonAnswerGuard) {
      autoSubmit._armNonAnswerGuard();
    }

    try {
      console.log('[voice-intent] classify-input request', {
        words: wordCount,
        preview: text.slice(0, 100),
      });
      const res = await fetch(`/interview/${token}/call/classify-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spoken_text: text,
          question_id: currentQuestion.id,
          question_text: currentQuestion.question_text || '',
          assessment_state: buildAssessmentStatePayload(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { handled: false };

      console.log('[voice-intent] classify-input result', {
        intent: data.intent,
        confidence: data.confidence,
        action: data.action,
        source: data.source,
      });
      postFlowDebug('voice_intent_classified', {
        intent: data.intent,
        confidence: data.confidence,
        action: data.action,
        qid: currentQuestion.id,
      });

      if (data.agentState && typeof data.agentState.isPaused === 'boolean') {
        interviewAgentPaused = data.agentState.isPaused;
      }

      if (data.action === 'continue_recording') {
        return { handled: false };
      }

      if (data.action === 'repeat_question') {
        await handleQuestionRepeat({ spokenText: text, source: 'intent' });
        return { handled: true, removeFromTranscript: data.removeFromTranscript !== false };
      }

      if (data.action === 'request_advance') {
        if (autoSubmit?.state === 'RECORDING') {
          autoSubmit.handleNextQuestion();
          return { handled: true, removeFromTranscript: data.removeFromTranscript !== false };
        }
        if (data.responseText) {
          await speakAssessmentResponse(data.responseText);
        }
        interviewAgentPaused = false;
        await submitCurrentAnswer(autoSubmit?.getTranscript?.() || '', { forceSubmit: true });
        return { handled: true, removeFromTranscript: data.removeFromTranscript !== false };
      }

      if (data.action === 'resume_current_question') {
        if (data.agentState?.isPaused === false) {
          interviewAgentPaused = false;
        }
        if (data.responseText) {
          await speakAssessmentResponse(data.responseText);
        }
        await resumeCurrentQuestionVerbatim(data.resumeQuestionText);
        return { handled: true, removeFromTranscript: data.removeFromTranscript !== false };
      }

      if (data.action === 'speak_with_resume_offer') {
        if (data.agentState?.isPaused) {
          interviewAgentPaused = true;
        }
        if (data.responseText) {
          await speakAssessmentResponse(data.responseText);
        }
        return { handled: true, removeFromTranscript: data.removeFromTranscript !== false };
      }

      if (data.action === 'speak' && data.responseText) {
        await speakAssessmentResponse(data.responseText);
        return { handled: true, removeFromTranscript: data.removeFromTranscript !== false };
      }

      return { handled: false };
    } catch (e) {
      console.warn('[assessment-intent]', e.message);
      return { handled: false };
    }
  }

  async function logQuestionDispatchedToServer(state) {
    const q = state?.current_question;
    if (!q?.id) return;
    try {
      await fetch(`/interview/${token}/call/question-dispatched`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question_id: q.id,
          question_index: (state.answered_count ?? 0) + 1,
          question_text: q.question_text || '',
        }),
      });
    } catch (_) {}
  }

  async function requestQuestionRephrase({ spokenText = 'please repeat the question', source = 'button' } = {}) {
    const res = await fetch(`/interview/${token}/call/repeat-question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question_id: currentQuestion.id,
        spoken_text: spokenText,
        source,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not repeat question');
    return data;
  }

  async function handleQuestionRepeat({
    spokenText = '',
    source = 'voice',
    fromConfirmation = false,
    skipPause = false,
  } = {}) {
    if (!currentQuestion?.id || questionRepeatInFlight) return;
    questionRepeatInFlight = true;
    const prevAutoState = autoSubmit?.state;
    postFlowDebug('repeat_flow_start', {
      source,
      fromConfirmation,
      skipPause,
      prevState: prevAutoState,
      qid: currentQuestion.id,
    });
    console.log('[repeat-flow] start', { source, fromConfirmation, skipPause, prevState: prevAutoState });

    try {
      if (!skipPause) {
        if (autoSubmit?.pauseForQuestionRepeat) {
          await autoSubmit.pauseForQuestionRepeat();
        } else {
          await stopAnswerRecording();
        }
      }

      setAudioQuestionStatus('Repeating question…');
      const data = await requestQuestionRephrase({ spokenText, source });
      console.log('[repeat-flow] server', {
        ok: data.ok,
        reason: data.reason,
        repeat_count: data.repeat_count,
        limit_reached: data.limit_reached,
      });
      postFlowDebug('repeat_flow_server', {
        ok: data.ok,
        reason: data.reason,
        repeat_count: data.repeat_count,
        limit_reached: data.limit_reached,
      });

      if (!data.ok && data.reason === 'not_repeat_request') {
        log('Repeat not detected — continue your answer');
        if (autoSubmit?.resumeAfterQuestionRepeat) {
          await autoSubmit.resumeAfterQuestionRepeat();
        } else {
          startAnswerRecording();
        }
        return;
      }

      const toSpeak = data.spoken_text || data.rephrased_text || lastSpokenQuestionText;
      if (toSpeak) {
        lastSpokenQuestionText = toSpeak;
        window.speechSynthesis?.cancel();
        setAnswerRecStatus(data.limit_reached ? '🔊 Listen carefully…' : '🔊 Question repeated…');
        const speechPromise = speakQuestionOnce(toSpeak, {
          onPlaybackStart: () => autoSubmit?.onQuestionAudioStart?.(),
        });
        if (autoSubmit?.holdSilenceForQuestionTts && autoSubmit.state === 'RECORDING') {
          autoSubmit.holdSilenceForQuestionTts(speechPromise, {
            expectedDurationMs: estimateQuestionAudioMs(toSpeak),
          });
        }
        await speechPromise;
        postFlowDebug('repeat_flow_question_spoken', {
          qid: currentQuestion.id,
          repeat_count: data.repeat_count,
        });
      }

      if (data.limit_reached) {
        log(`Question repeat limit reached (${data.repeat_count}/${data.max_repeats})`, true);
        setAudioQuestionStatus('Repeat limit reached — please answer from what you heard');
      } else if (data.repeat_count) {
        log(`Question repeated (${data.repeat_count}/${data.max_repeats})`);
        setAudioQuestionStatus('Listen carefully — question is audio only');
      }

      if (autoSubmit?.resumeAfterQuestionRepeat) {
        await autoSubmit.resumeAfterQuestionRepeat();
        postFlowDebug('repeat_flow_answer_waiting', {
          qid: currentQuestion.id,
          state: autoSubmit.state,
        });
        console.log('[repeat-flow] answer waiting', { state: autoSubmit?.state });
      } else {
        startAnswerRecording();
        if (btnSubmit) btnSubmit.disabled = false;
        if (btnPlayQuestion) btnPlayQuestion.disabled = false;
      }
    } catch (e) {
      showError(e.message);
      console.error('[repeat-flow] error', e.message);
      postFlowDebug('repeat_flow_error', { error: e.message, qid: currentQuestion?.id });
      if (autoSubmit?.resumeAfterQuestionRepeat) {
        await autoSubmit.resumeAfterQuestionRepeat();
      }
    } finally {
      questionRepeatInFlight = false;
      if (btnPlayQuestion && callActive) btnPlayQuestion.disabled = false;
      void drainDeferredProctorEscalations();
    }
  }

  function updateQuestionProgressDots(state) {
    if (!qProgressEl) return;
    const total = Math.max(Number(state.total_questions) || 0, 1);
    const current = state.completed
      ? total
      : Math.min((Number(state.answered_count) || 0) + 1, total);
    qProgressEl.innerHTML = '';
    for (let i = 1; i <= total; i++) {
      const dot = document.createElement('div');
      dot.className = 'q-dot';
      if (i < current) dot.classList.add('done');
      else if (i === current) dot.classList.add('active');
      qProgressEl.appendChild(dot);
    }
  }

  function canFireAlert(eventType) {
    const last = alertCooldown.get(eventType) || 0;
    if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
    alertCooldown.set(eventType, Date.now());
    return true;
  }

  async function bumpFlagCount(message, warn, eventType, { skipBanner = false } = {}) {
    flagCount += 1;
    if (flagCountEl) flagCountEl.textContent = String(flagCount);
    if (!skipBanner) {
      showProctorAlert(message);
      log(message, warn !== false);
    } else {
      log(`Proctor flag: ${proctorActivityLabel(eventType)}`, warn !== false);
    }
  }

  async function processProctoringEvent(eventType, message, severity, escalationMeta, { bannersOnly = false, skipBanner = false } = {}) {
    if (!callActive || proctorTerminationInProgress) return;
    const normalized = normalizeProctorEventType(eventType);
    const escalationAction =
      escalationMeta?.proctoring_action ||
      (escalationMeta?.terminate ? 'terminate' : null);
    const isStrike = isProctorStrikeAction(escalationAction);

    const cooldownKey = isFocusLossEventType(normalized)
      ? 'focus_loss'
      : escalationMeta?.source === 'client'
        ? normalized
        : `server:${normalized}`;
    if (!isStrike && !canFireAlert(cooldownKey)) {
      proctorLog('Banner suppressed by client cooldown', { activity: proctorLogActivityKey(normalized) });
      return;
    }

    autoSubmit?.markSuspiciousEvent?.(normalized);

    const willEscalate = !!(escalationMeta?.proctoring || escalationAction);
    const bannerText =
      willEscalate && escalationMeta?.proctoring
        ? proctorEscalationCopy(
            escalationMeta.trigger_flag_type || normalized,
            escalationAction,
            escalationMeta.proctoring
          ).banner
        : message || `Warning: ${proctorActivityLabel(normalized)} Detected`;

    await bumpFlagCount(bannerText, severity !== 'low', normalized, {
      skipBanner: skipBanner || (willEscalate && bannersOnly),
    });

    if (bannersOnly) {
      postFlowDebug('proctor_banner_shown', {
        event_type: normalized,
        severity: severity || 'medium',
        proctoring_action: escalationAction || null,
      });
      return;
    }

    if (escalationMeta && (escalationMeta.proctoring || escalationAction)) {
      await handleProctoringEscalation(
        escalationMeta.proctoring || {},
        escalationAction,
        escalationMeta.trigger_flag_type || normalized
      );
    }

    postFlowDebug('proctor_banner_shown', {
      event_type: normalized,
      severity: severity || 'medium',
      proctoring_action: escalationAction || null,
    });
  }

  async function onServerProctorBatch(flags, escalationMeta) {
    if (!callActive || proctorTerminationInProgress || !flags?.length) return;

    const action =
      escalationMeta?.proctoring_action ||
      (escalationMeta?.terminate ? 'terminate' : null);
    const hasEscalation = !!(escalationMeta?.proctoring || action);

    for (const f of flags) {
      if (!f?.message) continue;
      await processProctoringEvent(f.type, f.message, f.severity, escalationMeta, {
        bannersOnly: true,
        skipBanner: hasEscalation,
      });
    }

    if (action === 'terminate') {
      postFlowDebug('proctor_termination_strike', {
        event_type: escalationMeta?.trigger_flag_type || flags[0]?.type,
        activity: proctorActivityLabel(escalationMeta?.trigger_flag_type || flags[0]?.type),
        warning_count: escalationMeta?.proctoring?.warning_count,
        termination_strike: PROCTOR_TERMINATION_STRIKE,
      });
    } else if (action === 'final_warning') {
      postFlowDebug('proctor_final_warning_strike', {
        event_type: escalationMeta?.trigger_flag_type || flags[0]?.type,
        activity: proctorActivityLabel(escalationMeta?.trigger_flag_type || flags[0]?.type),
        warning_count: escalationMeta?.proctoring?.warning_count,
        final_warning_strike: PROCTOR_FINAL_WARNING_STRIKE,
      });
    }

    if (escalationMeta?.proctoring || action) {
      await handleProctoringEscalation(
        escalationMeta.proctoring || {},
        action,
        escalationMeta.trigger_flag_type || flags[0]?.type
      );
    }
  }

  function onGazeCheatFlag(event) {
    if (!callActive || proctorTerminationInProgress) return;

    const direction = event?.gazeDirection || 'center';
    if (!direction || direction === 'down' || direction === 'center') return;

    const eventType = 'suspicious_activity_off_screen_gaze';

    const label =
      direction === 'left'
        ? 'Looking away to the left'
        : direction === 'right'
          ? 'Looking away to the right'
          : 'Looking away from the screen';

    const severity = event?.eventType === 'HARD_FLAG' ? 'high' : 'medium';
    const durationSec = Math.round((event?.durationMs || 0) / 100) / 10;
    const msg = `${label} for ${durationSec}s (${event?.eventType || 'FLAG'})`;

    showProctorAlert(msg);
    void logSuspicious(eventType, msg, {
      source: 'gaze_tracker',
      gaze_event: event,
      screenshot_base64: event?.screenshotBase64 || null,
      confidence: severity === 'high' ? 0.92 : 0.78,
    });

    postFlowDebug('gaze_cheat_flag', {
      event_type: eventType,
      flag: event?.eventType,
      direction,
      duration_ms: event?.durationMs,
    });
  }

  function isFaceCurrentlyDetected() {
    const results = faceMesh?._lastResults;
    return (results?.multiFaceLandmarks?.length || 0) === 1;
  }

  function scheduleDeferredCallMonitors() {
    const startMonitors = () => {
      startHeadphoneMonitor();
      if (window.InterviewPhoneDetector && video) {
        InterviewPhoneDetector.start(video, ({ message }) => {
          void logSuspicious('suspicious_activity_mobile_detected', message);
        });
      }
      startWebcamObstructionMonitor();
      startIntegrityMonitor();
      if (window.InterviewTelemetry) {
        const gazeDebug =
          typeof URLSearchParams !== 'undefined' &&
          new URLSearchParams(window.location.search).get('gaze_debug') === '1';
        InterviewTelemetry.start(token, faceMesh, {
          onServerFlag: onServerProctorFlag,
          onProctoringEscalation: onTelemetryProctoring,
          onFaceRotation: onClientFaceRotation,
          onGazeFlag: onGazeCheatFlag,
          videoEl: video,
          gazeDebug,
          headphonesDetected: headphonesOk,
          mediaStream: videoStream,
          attentionConfig: window.INTERVIEW_ATTENTION_CONFIG || {},
        });
      }
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(startMonitors, { timeout: 800 });
    } else {
      setTimeout(startMonitors, 30);
    }
  }

  function startWebcamObstructionMonitor() {
    if (!window.InterviewWebcamObstructionDetect || !video) return;
    window.InterviewWebcamObstructionDetect.start(
      video,
      ({ message, confidence, signals }) => {
        void logSuspicious('suspicious_activity_webcam_obstruction', message, {
          confidence,
          obstruction_confidence: confidence,
          signals,
        });
      },
      { getFaceDetected: isFaceCurrentlyDetected }
    );
  }

  function stopWebcamObstructionMonitor() {
    window.InterviewWebcamObstructionDetect?.stop?.();
  }

  function startIntegrityMonitor() {
    if (!window.InterviewIntegrityMonitor || !video) return;
    window.InterviewIntegrityMonitor.start({
      token,
      video,
      mediaStream: videoStream,
      baselineFaceSignature: window.INTERVIEW_VERIFIED_FACE_SIGNATURE || null,
      getLandmarks: () => faceMesh?._lastResults?.multiFaceLandmarks?.[0] || null,
      getBlinkCount: () => window.InterviewTelemetry?.getBlinkCount?.() ?? 0,
      getRecordingHealth: () => ({
        active: sessionVideoRecorder?.recorder?.state === 'recording',
        lastChunkAt: sessionVideoRecorder?.lastChunkAt || 0,
        lastAckAt: sessionVideoRecorder?.lastAckAt || 0,
        chunkCount: sessionVideoRecorder?.chunkCount || 0,
        ackedChunkCount: sessionVideoRecorder?.ackedChunkCount || 0,
        failedCount: sessionVideoRecorder?.failedIndices?.size || 0,
      }),
      onEscalation: (data) => {
        void processProctoringEvent(
          data.trigger_flag_type || data.escalations?.[0]?.flag_type || 'suspicious_activity_integrity_anomaly',
          'Integrity monitoring escalation',
          'high',
          {
            source: 'integrity_heartbeat',
            proctoring: data.proctoring,
            proctoring_action: data.proctoring_action,
            trigger_flag_type: data.trigger_flag_type || data.escalations?.[0]?.flag_type,
            terminate: data.terminate,
          }
        );
        if (data.integrity_score != null) {
          updateIntegrityUI({
            ...(data.proctoring || {}),
            confidence_score: data.liveness_confidence ?? data.proctoring?.confidence_score,
            integrity_status:
              data.risk_level === 'CRITICAL'
                ? 'critical'
                : data.risk_level === 'HIGH'
                  ? 'elevated'
                  : data.proctoring?.integrity_status || 'ok',
          });
        }
      },
    });
  }

  function stopIntegrityMonitor() {
    window.InterviewIntegrityMonitor?.stop?.();
  }

  async function logSuspicious(eventType, message, extra = {}) {
    if (!callActive) return;
    const normalized = isFocusLossEventType(eventType) ? FOCUS_LOSS_FLAG : normalizeProctorEventType(eventType);
    try {
      const res = await fetch(`/interview/${token}/suspicious`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: normalized,
          message,
          source: extra.source || 'client',
          focus_source: extra.focus_source || null,
          confidence: extra.confidence ?? extra.obstruction_confidence ?? null,
          webcam_obstruction_confidence: extra.obstruction_confidence ?? extra.confidence ?? null,
          signals: extra.signals || null,
          gaze_event: extra.gaze_event || null,
          screenshot_base64: extra.screenshot_base64 || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.deduped) {
        proctorLog('Focus loss coalesced on server', {
          activity: proctorLogActivityKey(data.trigger_flag_type || normalized),
          warning_count: data.proctoring?.warning_count,
        });
        return;
      }
      proctorLog('Suspicious event posted to server', {
        activity: proctorLogActivityKey(data.trigger_flag_type || normalized),
        action: data.proctoring_action || 'none',
        warning_count: data.proctoring?.warning_count,
      });
      await processProctoringEvent(
        data.trigger_flag_type || normalized,
        data.message || message,
        'medium',
        {
          source: 'client',
          proctoring: data.proctoring,
          proctoring_action: data.proctoring_action,
          trigger_flag_type: data.trigger_flag_type || normalized,
          terminate: data.terminate,
        }
      );
      postFlowDebug('proctor_client_posted', {
        event_type: normalized,
        proctoring_action: data.proctoring_action || null,
      });
    } catch (_) {}
  }

  function onServerProctorFlag(flagsOrMessage, eventType, severity, escalationMeta) {
    if (Array.isArray(flagsOrMessage)) {
      void onServerProctorBatch(flagsOrMessage, eventType);
      return;
    }
    void processProctoringEvent(flagsOrMessage, eventType, severity, escalationMeta);
  }

  function onTelemetryProctoring(data) {
    if (!data?.proctoring && !data?.terminate && !data?.proctoring_action) return;
    proctorLog('Warning received from server (telemetry)', {
      activity: proctorLogActivityKey(
        data.trigger_flag_type || data.proctoring?.trigger_flag_type || data.flags?.[0]?.type
      ),
      action: data.proctoring_action || (data.terminate ? 'terminate' : 'none'),
      warning_count: data.proctoring?.warning_count,
    });
    void handleProctoringEscalation(
      data.proctoring || {},
      data.proctoring_action || (data.terminate ? 'terminate' : null),
      data.trigger_flag_type ||
        data.proctoring?.trigger_flag_type ||
        (data.flags?.[0]?.type ?? null)
    );
  }

  function onClientFaceRotation(pose) {
    if (!callActive) return;
    const msg = `Face rotated away from camera (yaw ${Math.round(pose.yaw || 0)}°, pitch ${Math.round(pose.pitch || 0)}°)`;
    void logSuspicious('suspicious_activity_face_rotation', msg);
  }

  function bindProctoring() {
    document.addEventListener('visibilitychange', () => {
      console.log('[PROCTORING] Visibility state:', document.visibilityState);
      if (!callActive) return;
      if (document.hidden) {
        reportFocusLoss('visibility_hidden');
      } else {
        lastDocumentFocused = isAssessmentFocused();
      }
    });

    window.addEventListener('blur', () => {
      console.log('[PROCTORING] Window blur detected');
      if (!callActive) return;
      reportFocusLoss('window_blur');
    });

    window.addEventListener('focus', () => {
      lastDocumentFocused = true;
    });

    window.addEventListener('pagehide', () => {
      if (!callActive) return;
      reportFocusLoss('pagehide');
    });
  }

  function normalizeHeadphoneLabel(label) {
    return String(label || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function labelsMatchVerifiedHeadphone(currentLabel, savedLabel) {
    const current = normalizeHeadphoneLabel(currentLabel);
    const saved = normalizeHeadphoneLabel(savedLabel);
    if (!current || !saved) return false;
    if (current === saved) return true;
    if (current.length >= 8 && saved.length >= 8) {
      return current.includes(saved) || saved.includes(current);
    }
    return false;
  }

  function findVerifiedHeadphoneDevice(headphoneOnly, savedDeviceId, savedLabel) {
    if (savedDeviceId) {
      const byId = headphoneOnly.find((d) => d.deviceId === savedDeviceId);
      if (byId) return byId;
    }
    if (savedLabel) {
      const byLabel = headphoneOnly.find((d) => labelsMatchVerifiedHeadphone(d.label, savedLabel));
      if (byLabel) return byLabel;
    }
    return null;
  }

  function persistVerifiedHeadphoneDevice(device) {
    if (!device?.deviceId) return;
    sessionStorage.setItem(`mission_hp_${token}`, device.deviceId);
    if (device.label) {
      sessionStorage.setItem(`mission_hp_label_${token}`, device.label);
    }
  }

  async function scanHeadphones({ requireVerifiedDevice = false } = {}) {
    const detect = window.InterviewHeadphoneDetect;
    if (!detect?.enumerateHeadphoneOutputs) {
      return { ok: false, label: '', confidence: 'none' };
    }

    try {
      const allOutputs = await detect.enumerateAudioOutputs(videoStream);
      const headphoneOnly = await detect.enumerateHeadphoneOutputs(videoStream);
      const savedDeviceId = sessionStorage.getItem(`mission_hp_${token}`) || '';
      const savedLabel = sessionStorage.getItem(`mission_hp_label_${token}`) || '';
      const savedMethod = sessionStorage.getItem(`mission_hp_method_${token}`) || '';
      const verifiedInPreflight =
        savedMethod === 'test_tone_confirmed' && Boolean(savedDeviceId);

      if (verifiedInPreflight) {
        let verifiedDevice = findVerifiedHeadphoneDevice(
          headphoneOnly,
          savedDeviceId,
          savedLabel
        );
        if (!verifiedDevice) {
          verifiedDevice = findVerifiedHeadphoneDevice(allOutputs, savedDeviceId, savedLabel);
        }
        if (!verifiedDevice && savedDeviceId) {
          verifiedDevice = allOutputs.find((d) => d.deviceId === savedDeviceId) || null;
        }

        if (verifiedDevice) {
          const labelOk =
            detect.isAcceptableHeadphoneOutput(verifiedDevice.label) ||
            verifiedDevice.deviceId === savedDeviceId;
          if (labelOk) {
            if (verifiedDevice.deviceId !== savedDeviceId) {
              persistVerifiedHeadphoneDevice(verifiedDevice);
            }
            return {
              ok: true,
              label:
                detect.formatOutputLabel(verifiedDevice) ||
                verifiedDevice.label ||
                savedLabel ||
                '',
              confidence: 'high',
              deviceId: verifiedDevice.deviceId,
              recovered: verifiedDevice.deviceId !== savedDeviceId,
            };
          }
        }
        if (requireVerifiedDevice) {
          return {
            ok: false,
            label: '',
            confidence: 'none',
            verifiedDeviceMissing: true,
          };
        }
      }

      const pick = detect.pickHeadphoneOutput(headphoneOnly, savedDeviceId);
      const hadVerifiedMatch = Boolean(
        findVerifiedHeadphoneDevice(headphoneOnly, savedDeviceId, savedLabel) ||
          findVerifiedHeadphoneDevice(allOutputs, savedDeviceId, savedLabel) ||
          allOutputs.find((d) => d.deviceId === savedDeviceId)
      );

      if (pick.device && detect.isAcceptableHeadphoneOutput(pick.device.label)) {
        if (
          verifiedInPreflight &&
          pick.device.deviceId !== savedDeviceId &&
          !labelsMatchVerifiedHeadphone(pick.device.label, savedLabel)
        ) {
          return {
            ok: false,
            label: '',
            confidence: 'none',
            verifiedDeviceMissing: true,
          };
        }
        persistVerifiedHeadphoneDevice(pick.device);
        return {
          ok: true,
          label: detect.formatOutputLabel(pick.device) || pick.device.label || '',
          confidence: 'high',
          deviceId: pick.device.deviceId,
          recovered: !hadVerifiedMatch,
        };
      }

      return { ok: false, label: '', confidence: 'none' };
    } catch {
      return { ok: false, label: '', confidence: 'none' };
    }
  }

  function setHeadphonesBlocked(blocked, message) {
    headphonesBlocked = blocked;
    headphonesOk = !blocked;
    if (window.InterviewTelemetry?.setHeadphonesDetected) {
      InterviewTelemetry.setHeadphonesDetected(!blocked);
    }
    if (blocked) {
      showError(message || 'Headphones disconnected. Reconnect your headset to continue.');
      if (btnSubmit) btnSubmit.disabled = true;
      if (btnPlayQuestion) btnPlayQuestion.disabled = true;
    } else if (callActive && !answering && !presentingQuestion) {
      clearError();
      if (currentQuestion && btnSubmit) btnSubmit.disabled = false;
      if (currentQuestion && btnPlayQuestion) btnPlayQuestion.disabled = false;
    }
  }

  async function reportHeadphonesToServer(detected, label) {
    try {
      await fetch(`/interview/${token}/headphones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headphones_hardware_detected: detected,
          headphones_verified: detected,
          headphones_test_tone_passed: detected,
          headphones_leakage_passed: detected,
          headphones_detection_method: detected ? 'test_tone_confirmed' : 'none',
          device_label: label || '',
          device_id: sessionStorage.getItem(`mission_hp_${token}`) || '',
        }),
      });
    } catch (_) {}
  }

  async function recoverHeadphonesDetected(label) {
    headphonesOk = true;
    headphoneRemovalMissCount = 0;
    hideProctorAlert();
    clearError();
    await reportHeadphonesToServer(true, label);
    setHeadphonesBlocked(false);
    log('Headphones detected — interview can continue', true);
    if (
      callActive &&
      currentQuestion &&
      !answering &&
      !presentingQuestion &&
      !interviewFinished
    ) {
      if (autoSubmitEnabled && autoSubmit?.state !== 'RECORDING' && autoSubmit?.state !== 'SUBMITTING') {
        try {
          await autoSubmit.startAfterQuestion({ skipIdleCountdown: true });
        } catch (_) {
          startAnswerRecording();
        }
      } else if (!autoSubmitEnabled && autoSubmit?.state !== 'RECORDING') {
        startAnswerRecording();
      }
    }
  }

  async function blockHeadphonesRemoved(message) {
    headphonesOk = false;
    await logSuspicious('suspicious_activity_headphones_removed', message);
    await reportHeadphonesToServer(false, '');
    showProctorAlert(message);
    setHeadphonesBlocked(true, message);
    autoSubmit?.stop?.();
    try {
      await stopAnswerRecording();
    } catch (_) {}
  }

  async function checkHeadphonesDuringCall() {
    if (!callActive || interviewFinished) return;
    const { ok, label, recovered, verifiedDeviceMissing } = await scanHeadphones({
      requireVerifiedDevice: true,
    });

    if (ok) {
      headphoneRemovalMissCount = 0;
      if (!headphonesOk || headphonesBlocked) {
        await recoverHeadphonesDetected(label);
        return;
      }
      if (recovered) {
        log('Headphones reconnected — audio output updated automatically', true);
      }
      return;
    }

    if (!headphonesOk) return;

    headphoneRemovalMissCount += 1;
    if (headphoneRemovalMissCount < HEADPHONE_REMOVAL_MISS_THRESHOLD) {
      log('Headphones scan inconclusive — waiting for device list to stabilize', true);
      return;
    }

    const msg = verifiedDeviceMissing
      ? 'Your verified headphones were disconnected. Reconnect the same headset — interview is paused until headphones are detected again.'
      : 'Headphones disconnected or switched to speakers. Reconnect your headset — interview is paused until headphones are detected.';
    await blockHeadphonesRemoved(msg);
  }

  function onHeadphoneDeviceChange() {
    clearTimeout(headphoneDeviceChangeTimer);
    headphoneRemovalMissCount = 0;
    headphoneDeviceChangeTimer = setTimeout(async () => {
      await checkHeadphonesDuringCall();
      setTimeout(() => {
        if (callActive && !interviewFinished) void checkHeadphonesDuringCall();
      }, HEADPHONE_DEVICE_CHANGE_RETRY_MS);
    }, HEADPHONE_DEVICE_CHANGE_DEBOUNCE_MS);
  }

  function startHeadphoneMonitor() {
    stopHeadphoneMonitor();
    headphonePollTimer = setInterval(checkHeadphonesDuringCall, HEADPHONE_POLL_MS);
    navigator.mediaDevices?.addEventListener('devicechange', onHeadphoneDeviceChange);
    // Defer first in-call scan so it does not compete with question playback startup.
    setTimeout(() => {
      if (callActive && !interviewFinished) void checkHeadphonesDuringCall();
    }, 8000);
  }

  function stopHeadphoneMonitor() {
    if (headphonePollTimer) {
      clearInterval(headphonePollTimer);
      headphonePollTimer = null;
    }
    if (headphoneDeviceChangeTimer) {
      clearTimeout(headphoneDeviceChangeTimer);
      headphoneDeviceChangeTimer = null;
    }
    navigator.mediaDevices?.removeEventListener('devicechange', onHeadphoneDeviceChange);
  }

  function getSessionRecordStream() {
    if (!videoStream) return null;
    const videoTracks = videoStream.getVideoTracks?.() || [];
    const audioTracks = videoStream.getAudioTracks?.() || [];
    if (!videoTracks.length) return videoStream;
    return new MediaStream([...videoTracks, ...audioTracks]);
  }

  function createAnswerAudioStream() {
    const track = videoStream?.getAudioTracks?.()[0];
    if (!track || track.readyState !== 'live') {
      throw new Error('Microphone unavailable. Check your headset connection.');
    }
    return new MediaStream([track.clone()]);
  }

  function startFaceMeshLoop() {
    if (!faceMesh || !video || faceMeshRunning) return;
    faceMeshRunning = true;
    faceMesh.onResults((results) => {
      faceMesh._lastResults = results;
      const landmarks = results.multiFaceLandmarks?.[0];
      const detector = window.InterviewTelemetry?.getGazeDetector?.();
      if (landmarks && detector) {
        void detector.processLandmarks(landmarks);
      }
    });
    const loop = async () => {
      if (!faceMeshRunning) return;
      try {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          await faceMesh.send({ image: video });
        }
      } catch (_) {}
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  async function initMedia() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera/microphone not supported. Use Chrome or Edge.');
    }

    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    video.srcObject = videoStream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});

    if (typeof FaceMesh !== 'undefined') {
      faceMesh = new FaceMesh({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });
      faceMesh.setOptions({
        maxNumFaces: 2,
        refineLandmarks: true,
        minDetectionConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
      startFaceMeshLoop();
    }

    log('Camera and microphone ready');

    if (window.InterviewRecording) {
      sessionVideoRecorder = new InterviewRecording.SessionVideoRecorder(token, {
        sessionId: window.INTERVIEW_SESSION_ID,
        onLog: (t) => log(t),
        onError: (t) => log(t, true),
        timesliceMs: 5000,
      });
      answerAudioRecorder = new InterviewRecording.AnswerAudioRecorder();
      bindRecordingUnloadGuard();
    }

    await scanHeadphones().then(({ ok, label, recovered }) => {
      headphonesOk = ok;
      headphonesScanComplete = true;
      if (!ok) {
        log('Headphones not detected — connect headphones labeled Headphones/Headset/Earphone/Earbuds', true);
      } else {
        log(recovered ? `Headphones reconnected: ${label}` : `Headphones ready: ${label}`);
      }
      updateStartButtonState();
    });
  }

  function startSessionVideoRecording() {
    if (!videoStream || !sessionVideoRecorder) return;
    if (sessionVideoRecorder.token !== token) {
      sessionVideoRecorder.setToken(token);
    }
    sessionVideoRecorder.start(getSessionRecordStream());
    setRecordingActive(true);
    startSnapshotCapture();
  }

  async function stopSessionVideoRecording() {
    setRecordingActive(false);
    if (!sessionVideoRecorder) return null;
    const stats = await sessionVideoRecorder.stop();
    console.log('[room] Session video recording stopped', stats || {});
    return stats;
  }

  function bindRecordingUnloadGuard() {
    const flush = () => {
      try {
        sessionVideoRecorder?.emergencyFlush?.();
      } catch (e) {
        console.warn('[room] emergencyFlush failed', e);
      }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }

  async function stopAnswerRecording() {
    setAnswerRecStatus('');
    if (!answerAudioRecorder) return { blob: null, elapsed: 0 };
    try {
      return await answerAudioRecorder.stop();
    } catch {
      return { blob: null, elapsed: 0 };
    }
  }

  function startAnswerRecording() {
    if (!answerAudioRecorder || headphonesBlocked) return;
    try {
      window.InterviewTelemetry?.markAnswerPhaseStart?.();
      window.InterviewIntegrityMonitor?.setCandidateSpeaking?.(true);
      answerAudioRecorder.start(createAnswerAudioStream());
      setAnswerRecStatus(
        autoSubmitEnabled
          ? '🔴 Recording — speak your answer (auto-submit active)'
          : '🔴 Recording your answer — speak clearly, then Submit'
      );
      log('Answer microphone recording started');
    } catch (e) {
      showError(e.message);
    }
  }

  function prefetchFirstQuestionTts(state) {
    const text = state?.current_question?.question_text || '';
    if (!text || !window.InterviewVoice?.prefetchTts) return Promise.resolve();
    return window.InterviewVoice.prefetchTts(text);
  }

  function estimateQuestionAudioMs(text) {
    return (
      window.AutoSubmitAnswer?.estimateQuestionDurationMs?.(text) ??
      Math.min(60000, Math.max(10000, String(text || '').length * 55))
    );
  }

  function speakQuestionOnce(text, opts = {}) {
    if (window.InterviewVoice?.speak) {
      return window.InterviewVoice.speak(text, {
        interrupt: true,
        rate: 0.92,
        volume: 0.85,
        msPerChar: 55,
        maxMs: Math.min(60000, Math.max(10000, text.length * 55)),
        ...opts,
      });
    }
    return Promise.resolve();
  }

  function prepareQuestionSpeech(text, { isReplay = false, parallelAnswer = false } = {}) {
    if (!text) {
      return {
        speechPromise: Promise.resolve(),
        playbackStarted: Promise.resolve(),
      };
    }

    lastSpokenQuestionText = text;
    setAudioQuestionStatus(
      isReplay ? 'Listen carefully — question replaying…' : 'Listen carefully — question is audio only'
    );
    if (!parallelAnswer) {
      if (autoSubmit?.resetForNextQuestion) {
        autoSubmit.resetForNextQuestion();
      } else {
        autoSubmit?.stop();
      }
      autoSubmitUi.setPanelVisible(false);
      setAnswerRecStatus(isReplay ? '🔊 Replaying…' : '🔊 Listen to the question…');
    }
    if (btnSubmit) btnSubmit.disabled = true;
    if (btnPlayQuestion) btnPlayQuestion.disabled = true;

    window.speechSynthesis?.cancel();

    let playbackStartedResolve;
    const playbackStarted = new Promise((resolve) => {
      playbackStartedResolve = resolve;
      setTimeout(resolve, 4000);
    });

    const speechPromise = speakQuestionOnce(text, {
      onPlaybackStart: () => {
        startupMark('question-audio-playing');
        playbackStartedResolve();
        autoSubmit?.onQuestionAudioStart?.();
      },
    }).finally(() => {
      playbackStartedResolve();
    });

    return { speechPromise, playbackStarted };
  }

  async function runOverlayCountdown() {
    window.speechSynthesis?.cancel();
    window.InterviewVoice?.stop?.();
    autoSubmitUi.hideCountdown();
  }

  function updateQuestionUI(state) {
    const total = state.total_questions || 0;
    const answered = state.answered_count || 0;
    if (qTotalEl) qTotalEl.textContent = String(total);
    if (qIndexEl) {
      qIndexEl.textContent = String(state.completed ? total : Math.min(answered + 1, total || 0));
    }
    updateQuestionProgressDots(state);
    currentQuestion = state.current_question;

    if (state.completed) {
      if (btnSubmit) btnSubmit.disabled = true;
      if (btnEnd) btnEnd.disabled = false;
    }
  }

  async function speakQuestionAloud(text, { isReplay = false } = {}) {
    if (!text) return;
    if (isReplay && answerAudioRecorder?.recorder?.state === 'recording') {
      await stopAnswerRecording();
    }
    const { speechPromise } = prepareQuestionSpeech(text, { isReplay });
    await speechPromise;
  }

  async function showQuestionForAnswer(state) {
    if (presentingQuestion) return;
    presentingQuestion = true;
    try {
      lastCallStateForUi = state;
      updateQuestionUI(state);
      if (state.completed) return;
      if (!state.current_question) {
        showError('No question loaded for this step.');
        return;
      }
      currentQuestion = state.current_question;
      interviewAgentPaused = false;
      window.InterviewTelemetry?.setLiveQuestionContext?.(
        currentQuestion?.id,
        currentQuestion?.question_text || ''
      );

      await runOverlayCountdown();

      void logQuestionDispatchedToServer(state);
      startupMark('question-dispatch-logged');

      void prefetchFirstQuestionTts(state);
      const { speechPromise } = prepareQuestionSpeech(state.current_question.question_text, {
        parallelAnswer: true,
      });
      startupMark('question-audio-queued');

      void speechPromise.finally(() => {
        startupMark('question-audio-finished');
        setAudioQuestionStatus('Speak your answer clearly');
      });

      if (autoSubmitEnabled && autoSubmit) {
        autoSubmit.holdSilenceForQuestionTts(speechPromise, {
          expectedDurationMs: estimateQuestionAudioMs(state.current_question.question_text),
        });
        if (btnSubmit) {
          btnSubmit.disabled = true;
          btnSubmit.classList.add('room-btn-muted');
          btnSubmit.title = 'Auto-submit is active';
        }
        await autoSubmit.startAfterQuestion({ skipIdleCountdown: true });
      } else {
        startAnswerRecording();
        if (btnSubmit) btnSubmit.disabled = false;
        if (btnPlayQuestion) btnPlayQuestion.disabled = false;
      }
      log(`Question ${state.answered_count + 1} of ${state.total_questions} — speak your answer`);
    } finally {
      presentingQuestion = false;
      void drainDeferredProctorEscalations();
    }
  }

  async function refreshCallState() {
    const res = await fetch(`/interview/${token}/call/state`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load call state');
    if (data) lastCallStateForUi = data;
    return data;
  }

  async function completeInterviewFlow() {
    if (completionRetryTimer) {
      clearTimeout(completionRetryTimer);
      completionRetryTimer = null;
    }

    if (!interviewUiFinalized) {
      interviewUiFinalized = true;
      interviewFinished = true;
      clearQuestionDisplay();
      callActive = false;
      stopFocusMonitor();
      stopCallConnectivityMonitor();
      autoSubmit?.stop();
      stopSessionTimer();
      roomWaveform?.classList.remove('is-active');
      stopHeadphoneMonitor();
      faceMeshRunning = false;
      window.speechSynthesis?.cancel();

      if (btnSubmit) btnSubmit.disabled = true;
      if (btnEnd) btnEnd.disabled = true;
      if (btnStart) btnStart.disabled = true;

      clearError();
      showCompletionUI(
        sessionLabels().completionTitle || 'Assessment completed',
        'Thank you for your time.'
      );
      statusEl.textContent = 'Completed';
      statusEl.className = 'room-ready-badge';
    }

    if (endInterviewApiSucceeded) return;

    try {
      await stopAnswerRecording();

      stopSnapshotCapture();
      if (window.InterviewTelemetry) InterviewTelemetry.stop();

      const recordingStats = await waitForRecordingStop();
      await callEndInterviewApi(recordingStats);
    } catch (e) {
      console.error('[room] Interview finalize failed:', e);
      throw e;
    }

    stopHeadphoneMonitor();
    window.InterviewPhoneDetector?.stop?.();
    stopWebcamObstructionMonitor();
    stopIntegrityMonitor();
    videoStream?.getTracks().forEach((t) => t.stop());

    setTimeout(() => {
      try {
        window.close();
      } catch (_) {}
    }, 4000);
  }

  async function beginCall(startData) {
    if (interviewFinished) return;
    startupMark('beginCall');
    applySessionToken(startData?.session_token);
    clearError();
    hideCompletionUI();
    hideProctorAlert();

    if (!videoStream?.getVideoTracks?.().length) {
      throw new Error('Camera not ready. Refresh and allow permissions.');
    }

    // Preflight + page-load scan already verified headphones; only re-scan if state was lost.
    if (!headphonesOk) {
      const hp = await scanHeadphones();
      if (!hp.ok) {
        throw new Error('Headphones are required. Connect your headset, refresh devices, then start again.');
      }
      headphonesOk = true;
      headphonesBlocked = false;
    }
    startupMark('headphones-ready');

    const state = startData.call_state || (await refreshCallState());
    startupMark('call-state-ready');
    if (!state.total_questions) {
      throw new Error('No questions loaded. Schedule a new interview with question count 3–15.');
    }

    void prefetchFirstQuestionTts(state);

    callActive = true;
    startFocusMonitor();
    startCallConnectivityMonitor();
    integrityBadge?.classList.remove('d-none');
    updateIntegrityUI({ integrity_status: 'ok', confidence_score: 100 });
    statusEl.textContent = 'On call';
    statusEl.className = 'room-ready-badge is-on-call';
    if (msgEl) msgEl.textContent = 'Connecting your session…';
    btnStart.disabled = true;
    btnEnd.disabled = false;
    startSessionTimer();
    roomWaveform?.classList.add('is-active');

    try {
      startSessionVideoRecording();
    } catch (e) {
      callActive = false;
      stopFocusMonitor();
      throw new Error(e.message || 'Could not start session recording');
    }
    startupMark('recording-started');

    scheduleDeferredCallMonitors();

    if (msgEl) msgEl.textContent = '';
    log(`Call started — ${state.total_questions} questions`);
    startupMark('first-question-start');
    await showQuestionForAnswer(state);
    startupMark('first-question-ready');
  }

  [btnStart, btnSubmit, btnEnd, btnPlayQuestion].forEach((btn) => {
    btn?.addEventListener('mousedown', markUiClick);
  });

  if (btnPlayQuestion) {
    btnPlayQuestion.addEventListener('click', async () => {
      markUiClick();
      if (!currentQuestion?.id || presentingQuestion || questionRepeatInFlight) return;
      btnPlayQuestion.disabled = true;
      await handleQuestionRepeat({
        spokenText: 'please repeat the question',
        source: 'button',
      });
    });
  }

  if (btnStart) {
    btnStart.addEventListener('click', async () => {
      markUiClick();
      if (startCallInFlight || callActive || interviewFinished) return;
      if (!sessionPrepareReady) {
        showError('Assessment is still preparing. Please wait a moment.');
        void prefetchSessionPrepare({ force: true });
        return;
      }
      clearError();
      hideConnectionBanner();
      startCallInFlight = true;
      btnStart.disabled = true;
      if (msgEl) msgEl.textContent = 'Connecting…';
      statusEl.textContent = 'Connecting…';
      statusEl.className = 'room-ready-badge is-on-call';
      startupMark('start-click');
      try {
        if (!sessionPrepareReady) {
          await ensureSessionPrepared();
        }
        const data = await postStartInterview();
        startupMark('start-api-done');
        await beginCall(data);
      } catch (e) {
        showError(e.message);
        resetReadyUI();
      } finally {
        startCallInFlight = false;
        hideConnectionBanner();
      }
    });
  }

  if (btnSubmit) {
    btnSubmit.addEventListener('click', async () => {
      markUiClick();
      if (!callActive || !currentQuestion || answering || interviewFinished) return;
      if (autoSubmit?.resetForNextQuestion) {
        autoSubmit.resetForNextQuestion();
      } else {
        autoSubmit?.stop();
      }
      autoSubmitUi.setPanelVisible(false);
      try {
        const wasLastQuestion = isLastQuestion();
        const data = await submitCurrentAnswer(autoSubmit?.getTranscript?.() || '');
        let state = data.call_state || (await refreshCallState());
        state = await resolveAdvancedState(state, Number(data?.question_id) || currentQuestion?.id);
        lastCallStateForUi = state;
        if (isAssessmentComplete(state) || !state.current_question || state.completed || wasLastQuestion) {
          await handleAssessmentCompletion({
            state,
            submittedData: data,
            forceComplete: wasLastQuestion,
          });
        } else {
          await showQuestionForAnswer(state);
        }
      } catch (e) {
        showError(e.message);
        if (callActive && !interviewFinished) {
          if (!autoSubmitEnabled) {
            startAnswerRecording();
            btnSubmit.disabled = false;
            if (btnPlayQuestion) btnPlayQuestion.disabled = false;
          } else {
            await autoSubmit?.startAfterQuestion();
          }
        }
      }
    });
  }

  if (btnEnd) {
    btnEnd.addEventListener('click', () => {
      markUiClick();
      completeInterviewFlow();
    });
  }

  async function tryResume() {
    try {
      const statusRes = await fetch(`/interview/${token}/status`);
      if (!statusRes.ok) {
        window.location.reload();
        return;
      }
      const statusData = await statusRes.json();
      if (
        statusData.status === 'terminated_due_to_proctoring_violation' ||
        statusData.status === 'failed'
      ) {
        showInvalidLinkUI();
        return;
      }
      if (statusData.status === 'completed' || statusData.status === 'suspicious') {
        showCompletionUI('Assessment already completed', 'Thank you.');
        return;
      }
      if (statusData.status !== 'in_progress') return;

      const proctorRes = await fetch(`/interview/${token}/proctoring/state`);
      if (proctorRes.ok) {
        const proctorData = await proctorRes.json();
        if (proctorData.proctoring?.terminated) {
          showInvalidLinkUI();
          return;
        }
      }

      const state = await refreshCallState();
      if (!state.total_questions) {
        showError('No questions on this session. Use a new invite link.');
        resetReadyUI();
        return;
      }

      callActive = true;
      startFocusMonitor();
      startCallConnectivityMonitor();
      btnStart.disabled = true;
      btnEnd.disabled = false;
      statusEl.textContent = 'On call';
      statusEl.className = 'room-ready-badge is-on-call';
      try {
        startSessionVideoRecording();
      } catch (e) {
        showError(e.message);
        resetReadyUI();
        return;
      }
      scheduleDeferredCallMonitors();

      if (state.completed) return;
      await showQuestionForAnswer(state);
      log('Resumed interview');
    } catch (e) {
      showError('Resume failed: ' + e.message);
      resetReadyUI();
    }
  }

  function captureAndUploadSnapshot() {
    if (!video?.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.append('snapshot', blob, `snap_${Date.now()}.jpg`);
      fd.append('face_count', '1');
      fetch(`/interview/${token}/snapshot`, { method: 'POST', body: fd }).catch(() => {});
    }, 'image/jpeg', 0.85);
  }

  function startSnapshotCapture() {
    if (snapshotTimer) clearInterval(snapshotTimer);
    captureAndUploadSnapshot();
    snapshotTimer = setInterval(captureAndUploadSnapshot, 15000);
  }

  function stopSnapshotCapture() {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
  }

  function prefetchSessionPrepare({ force = false } = {}) {
    if (!force && (callActive || interviewFinished || sessionPrepareReady)) {
      return sessionPreparePromise || Promise.resolve(sessionPrepareData);
    }
    if (!force && sessionPreparePromise) return sessionPreparePromise;
    if (force && sessionPreparePromise) {
      return sessionPreparePromise.then((data) => {
        if (sessionPrepareReady) return data;
        sessionPreparePromise = null;
        return prefetchSessionPrepare({ force: true });
      });
    }

    startPrepareStatusTicker();

    sessionPreparePromise = (async () => {
      let lastErr;
      for (let i = 0; i < PREPARE_FETCH_MAX_ATTEMPTS; i += 1) {
        try {
          const { res, data } = await fetchJsonWithTimeout(
            `/interview/${token}/prepare-session`,
            { method: 'POST' },
            PREPARE_FETCH_TIMEOUT_MS
          );
          if (!res.ok) {
            throw new Error(data.error || `Could not prepare session (${res.status})`);
          }
          if (data?.total_questions) {
            sessionPrepareReady = true;
            sessionPrepareData = data;
            if (qTotalEl) qTotalEl.textContent = String(data.total_questions);
            console.log(
              `[interview-startup] prepare-session ready (${data.total_questions} questions) +${Math.round(performance.now())}ms`
            );
            stopPrepareStatusTicker();
            updateStartButtonState();
            // Do not block Start — TTS prefetch runs in background (was causing 8–10s frozen button).
            void prefetchFirstQuestionTtsFromServer().then(() => {
              startupMark('tts-prefetch-done');
            });
          } else {
            stopPrepareStatusTicker();
            updateStartButtonState();
          }
          return data;
        } catch (e) {
          lastErr = e;
          if (i < PREPARE_FETCH_MAX_ATTEMPTS - 1) {
            if (msgEl && !startCallInFlight) {
              msgEl.textContent = 'Connection slow — retrying preparation…';
            }
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
      stopPrepareStatusTicker();
      sessionPrepareReady = false;
      sessionPreparePromise = null;
      updateStartButtonState();
      if (lastErr && !startCallInFlight) {
        showError(lastErr.message || 'Could not prepare assessment. Refresh and try again.');
      }
      return {};
    })();

    return sessionPreparePromise;
  }

  bindProctoring();
  resetReadyUI();
  hideCompletionUI();
  if (typeof performance !== 'undefined' && performance.mark) {
    performance.mark('interview:page-load');
  }
  window.InterviewVoice?.ensureVoicesLoaded?.();
  if (window.INTERVIEW_SESSION_LABELS?.welcomeAudioText) {
    window.InterviewVoice?.prefetchTts?.(window.INTERVIEW_SESSION_LABELS.welcomeAudioText);
  }
  window.InterviewVoice?.addIdleListener?.(() => {
    void drainDeferredProctorEscalations();
  });

  // Prepare questions in parallel with camera/mic init — do not wait for initMedia.
  prefetchSessionPrepare();

  initMedia()
    .then(() => {
      startupMark('media-ready');
      void recoverPendingInterviewEnd();
      initAutoSubmit();
      playRoomGreeting();
      refreshCallState()
        .then((state) => {
          if (state?.total_questions) updateQuestionUI(state);
        })
        .catch(() => {});
      return tryResume();
    })
    .catch((e) => {
      showError(e.message || 'Allow camera & microphone, then refresh.');
      resetReadyUI();
    });
})();
