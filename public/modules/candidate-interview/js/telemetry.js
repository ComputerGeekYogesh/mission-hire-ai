/**
 * Posts face telemetry to server — red alerts come from server rules + tab-switch client events.
 */
window.InterviewTelemetry = (function () {
  let token = '';
  let intervalId = null;
  let blinkCount = 0;
  let lastBlinkState = false;
  let faceAbsentSince = null;
  let onServerFlag = null;
  let onProctoringEscalation = null;
  let headphonesDetected = true;
  let liveQuestionId = null;
  let liveQuestionText = '';
  let lastSpeechReportAt = 0;
  let lastSpeechPayload = '';
  let onFaceRotation = null;
  let faceMeshRef = null;
  let mediaStreamRef = null;
  let faceRotIntervalId = null;
  let faceRotStreak = 0;
  let lastFaceRotAlertAt = 0;
  let attentionMonitor = null;
  let gazeDetector = null;
  let lastGazeFrame = null;
  let optionsOnGazeFlag = null;
  let answerPhaseActive = false;
  let lastAttentionSample = null;
  const FACE_ROT_YAW_ALERT = 30;
  const FACE_ROT_PITCH_ALERT = 34;
  const FACE_ROT_ALERT_COOLDOWN_MS = 20_000;
  const FACE_ROT_STREAK_REQUIRED = 6;
  const faceStabilizer = window.InterviewFaceDetect?.createStabilizer?.({
    presentStreakRequired: 2,
    absentStreakRequired: 5,
  }) || null;

  function estimateHeadPose(landmarks) {
    if (!landmarks?.length) return { yaw: 0, pitch: 0 };
    const nose = landmarks[1];
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const leftCheek = landmarks[234];
    const rightCheek = landmarks[454];
    const forehead = landmarks[10];
    const chin = landmarks[152];
    if (!nose || !leftCheek || !rightCheek) return { yaw: 0, pitch: 0 };

    const midX = (leftCheek.x + rightCheek.x) / 2;
    const cheekSpan = Math.hypot(rightCheek.x - leftCheek.x, rightCheek.y - leftCheek.y) || 0.001;
    const noseOffsetRatio = Math.abs(nose.x - midX) / (cheekSpan * 0.5);
    const yawFromCheek = noseOffsetRatio * 62;

    let yawFromEyes = 0;
    if (leftEye && rightEye) {
      const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) || 0.001;
      const midEyeX = (leftEye.x + rightEye.x) / 2;
      yawFromEyes = Math.abs((nose.x - midEyeX) / eyeDist) * 92;
    }

    const yaw = Math.min(90, Math.max(yawFromCheek, yawFromEyes, Math.abs(nose.x - midX) * 180));

    const faceHeight = forehead && chin ? Math.abs(chin.y - forehead.y) || 0.001 : 0.001;
    const midY = forehead && chin ? (forehead.y + chin.y) / 2 : nose.y;
    const pitchRatio = Math.abs(nose.y - midY) / faceHeight;
    const pitch = Math.min(90, pitchRatio * 105);

    return { yaw, pitch };
  }

  function checkClientFaceRotation(landmarks, faceDetected) {
    if (!faceDetected || !landmarks?.length || !onFaceRotation) return;
    const pose = estimateHeadPose(landmarks);
    const offAngle = pose.yaw >= FACE_ROT_YAW_ALERT || pose.pitch >= FACE_ROT_PITCH_ALERT;
    if (offAngle) faceRotStreak += 1;
    else faceRotStreak = 0;

    const now = Date.now();
    if (faceRotStreak >= FACE_ROT_STREAK_REQUIRED && now - lastFaceRotAlertAt >= FACE_ROT_ALERT_COOLDOWN_MS) {
      lastFaceRotAlertAt = now;
      faceRotStreak = 0;
      onFaceRotation(pose);
    }
  }

  function pollGazeAndAttention(landmarks, headPose) {
    if (!landmarks?.length) return;

    if (gazeDetector) {
      // Full-rate inference runs from room.js faceMesh.onResults (rAF).
      lastGazeFrame = gazeDetector.tracker?.getLastFrame?.() || null;
    } else if (attentionMonitor) {
      const sample = attentionMonitor.update(landmarks, headPose, {
        speaking: answerPhaseActive,
      });
      lastAttentionSample = sample;
    }
  }

  function pollFaceRotation() {
    const results = faceMeshRef?._lastResults;
    if (!results?.multiFaceLandmarks?.length) return;
    const landmarks = results.multiFaceLandmarks[0];
    const headPose = estimateHeadPose(landmarks);
    pollGazeAndAttention(landmarks, headPose);
    checkClientFaceRotation(landmarks, results.multiFaceLandmarks.length === 1);
  }

  function buildFaceSignature(landmarks) {
    if (!landmarks?.length) return '';
    const nose = landmarks[1];
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const chin = landmarks[152];
    const forehead = landmarks[10];
    const leftCheek = landmarks[234];
    const rightCheek = landmarks[454];
    if (!nose || !leftEye || !rightEye || !chin || !forehead || !leftCheek || !rightCheek) return '';

    const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
    const faceHeight = Math.abs(chin.y - forehead.y);
    if (!eyeDist || !faceHeight) return '';

    const midEyeX = (leftEye.x + rightEye.x) / 2;
    const midEyeY = (leftEye.y + rightEye.y) / 2;
    const yaw = (nose.x - midEyeX) / eyeDist;
    const pitch = (nose.y - midEyeY) / faceHeight;
    const cheekRatio =
      Math.hypot(rightCheek.x - leftCheek.x, rightCheek.y - leftCheek.y) / eyeDist;
    const noseToChin = Math.hypot(chin.x - nose.x, chin.y - nose.y) / faceHeight;
    return [yaw, pitch, cheekRatio, noseToChin].map((n) => Number(n).toFixed(4)).join(',');
  }

  async function post(payload) {
    try {
      const res = await fetch(`/interview/${token}/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch {
      return null;
    }
  }

  function onFaceResults(results) {
    const stable = faceStabilizer
      ? faceStabilizer.update(results)
      : {
          faceDetected: (results.multiFaceLandmarks?.length || 0) === 1,
          faceCount: results.multiFaceLandmarks?.length || 0,
          multipleFaces: (results.multiFaceLandmarks?.length || 0) > 1,
        };

    const landmarks = results.multiFaceLandmarks?.[0];
    const faceDetected = stable.faceDetected;
    const faceCount = stable.faceCount;

    const pose = estimateHeadPose(landmarks);
    checkClientFaceRotation(landmarks, faceDetected);
    pollGazeAndAttention(landmarks, pose);

    if (landmarks && landmarks[159] && landmarks[145]) {
      const eyeOpen = Math.abs(landmarks[159].y - landmarks[145].y) > 0.01;
      if (!eyeOpen && !lastBlinkState) blinkCount += 1;
      lastBlinkState = !eyeOpen;
    }

    if (!faceDetected) {
      if (!faceAbsentSince) faceAbsentSince = Date.now();
    } else {
      faceAbsentSince = null;
    }

    const faceAbsentSeconds = faceAbsentSince ? (Date.now() - faceAbsentSince) / 1000 : 0;

    const micActive = mediaStreamRef
      ? mediaStreamRef.getAudioTracks().some((t) => t.readyState === 'live' && t.enabled)
      : true;
    const cameraActive = mediaStreamRef
      ? mediaStreamRef.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled)
      : true;

    const attentionPayload =
      (gazeDetector || attentionMonitor) && faceDetected
        ? {
            ...(lastAttentionSample || {}),
            ...(gazeDetector
              ? gazeDetector.buildTelemetrySnapshot()
              : attentionMonitor?.buildTelemetrySnapshot?.() || {}),
            gaze_valid: gazeDetector
              ? lastGazeFrame?.valid === true
              : lastAttentionSample?.gaze_valid === true,
          }
        : {};

    return post({
      yaw: pose.yaw,
      pitch: pose.pitch,
      blink: blinkCount,
      faceDetected,
      face_detected: faceDetected,
      face_count: faceCount,
      mic_active: micActive,
      camera_active: cameraActive,
      tab_visible: !document.hidden,
      window_blur: typeof document.hasFocus === 'function' ? !document.hasFocus() : false,
      face_absent_seconds: faceAbsentSeconds,
      headphone_status: headphonesDetected ? 'detected' : 'not_detected',
      headphones_detected: headphonesDetected,
      face_signature: buildFaceSignature(landmarks),
      timestamp: new Date().toISOString(),
      ...attentionPayload,
      ...(window.InterviewWebcamObstructionDetect?.getTelemetrySnapshot?.() || {}),
    }).then(handleTelemetryResponse);
  }

  function handleTelemetryResponse(data) {
    const flags = data?.flags || [];
    const action = data?.proctoring_action || (data?.terminate ? 'terminate' : null);
    if (action && action !== 'none') {
      window.ProctoringClientLog?.log?.('Telemetry response includes escalation', {
        activity: window.ProctoringClientLog?.activityKey?.(
          data.trigger_flag_type || flags[0]?.type
        ),
        action,
        warning_count: data.proctoring?.warning_count,
      });
    }
    if (flags.length && onServerFlag) {
      onServerFlag(flags, {
        source: 'server',
        proctoring: data.proctoring,
        proctoring_action: data.proctoring_action,
        trigger_flag_type: data.trigger_flag_type || flags[0]?.type,
        terminate: data.terminate,
      });
    } else if ((data?.proctoring || data?.terminate || data?.proctoring_action) && onProctoringEscalation) {
      onProctoringEscalation(data);
    }
    return data;
  }

  function reportSpeechTranscript(speechText) {
    const text = String(speechText || '').trim();
    if (!text || text.length < 6 || !liveQuestionText || liveQuestionText.length < 12) return;
    const now = Date.now();
    if (text === lastSpeechPayload && now - lastSpeechReportAt < 2500) return;
    lastSpeechPayload = text;
    lastSpeechReportAt = now;

    post({
      speech_transcript: text.slice(0, 2000),
      current_question_text: liveQuestionText.slice(0, 2000),
      current_question_id: liveQuestionId,
      faceDetected: true,
      mic_active: true,
      camera_active: true,
      tab_visible: !document.hidden,
      timestamp: new Date().toISOString(),
    }).then(handleTelemetryResponse);
  }

  return {
    setHeadphonesDetected(ok) {
      headphonesDetected = ok !== false;
    },
    setLiveQuestionContext(questionId, questionText) {
      liveQuestionId = questionId ?? null;
      liveQuestionText = String(questionText || '');
      lastSpeechPayload = '';
      lastSpeechReportAt = 0;
    },
    reportSpeechTranscript,
    markAnswerPhaseStart() {
      answerPhaseActive = true;
      attentionMonitor?.markAnswerPhaseStart?.();
    },
    markAnswerPhaseEnd() {
      answerPhaseActive = false;
      attentionMonitor?.markAnswerPhaseEnd?.();
    },
    getGazeDetector() {
      return gazeDetector;
    },
    start(t, faceMeshInstance, options = {}) {
      token = t;
      onServerFlag = options.onServerFlag || null;
      onProctoringEscalation = options.onProctoringEscalation || null;
      onFaceRotation = options.onFaceRotation || null;
      optionsOnGazeFlag = options.onGazeFlag || null;
      faceMeshRef = faceMeshInstance;
      mediaStreamRef = options.mediaStream || null;
      headphonesDetected = options.headphonesDetected !== false;
      answerPhaseActive = false;
      lastAttentionSample = null;
      lastGazeFrame = null;

      if (window.GazeTracking?.GazeCheatDetector) {
        gazeDetector = options.gazeDetector || new window.GazeTracking.GazeCheatDetector({
          sessionId: t,
          videoEl: options.videoEl || null,
          debug: options.gazeDebug === true,
          onFlag: optionsOnGazeFlag,
          behaviorOptions: options.gazeBehaviorOptions || {},
        });
      } else {
        gazeDetector = null;
      }

      attentionMonitor =
        !gazeDetector && window.InterviewAttentionMonitor?.AttentionMonitor
          ? new window.InterviewAttentionMonitor.AttentionMonitor(options.attentionConfig || {})
          : null;
      faceStabilizer?.reset?.();
      faceAbsentSince = null;
      faceRotStreak = 0;
      lastFaceRotAlertAt = 0;
      if (intervalId) clearInterval(intervalId);
      if (faceRotIntervalId) clearInterval(faceRotIntervalId);
      intervalId = setInterval(() => {
        if (faceMeshInstance?._lastResults) {
          onFaceResults(faceMeshInstance._lastResults);
        }
      }, 3000);
      faceRotIntervalId = setInterval(pollFaceRotation, 800);
    },
    getBlinkCount() {
      return blinkCount;
    },
    stop() {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
      if (faceRotIntervalId) clearInterval(faceRotIntervalId);
      faceRotIntervalId = null;
      onServerFlag = null;
      onProctoringEscalation = null;
      onFaceRotation = null;
      faceMeshRef = null;
      mediaStreamRef = null;
      attentionMonitor = null;
      gazeDetector?.reset?.();
      gazeDetector = null;
      answerPhaseActive = false;
      lastAttentionSample = null;
      lastGazeFrame = null;
      optionsOnGazeFlag = null;
      faceStabilizer?.reset?.();
      faceAbsentSince = null;
      faceRotStreak = 0;
    },
  };
})();
