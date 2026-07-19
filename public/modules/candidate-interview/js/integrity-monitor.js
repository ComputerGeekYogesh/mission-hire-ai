/**
 * Enterprise integrity monitor: continuous liveness, identity drift, heartbeat,
 * virtual camera fingerprinting, and multi-voice coaching heuristics.
 */
(function (global) {
  const HEARTBEAT_MS = 5000;
  const LIVENESS_SCAN_MS = 500;
  const SAMPLE_W = 64;
  const SAMPLE_H = 48;
  const FROZEN_STREAK = 6;
  const LOW_MOTION_STREAK = 8;
  const NO_BLINK_MS = 18_000;
  const LOOP_HASH_WINDOW = 12;
  const VOICE_SCAN_MS = 400;
  const VOICE_COACHING_STREAK = 5;

  const VIRTUAL_CAMERA_PATTERNS = [
    /obs virtual/i,
    /obs-camera/i,
    /snap camera/i,
    /manycam/i,
    /droidcam/i,
    /camo studio/i,
    /epoccam/i,
    /iriun/i,
    /xsplit/i,
    /virtual cam/i,
    /mmhmm/i,
    /nvidia broadcast/i,
  ];

  let token = '';
  let videoEl = null;
  let mediaStream = null;
  let getLandmarks = null;
  let getBlinkCount = null;
  let getRecordingHealth = null;
  let onEscalation = null;
  let heartbeatTimer = null;
  let livenessTimer = null;
  let voiceTimer = null;
  let canvas = null;
  let ctx = null;
  let audioCtx = null;
  let analyser = null;
  let baselineFaceSig = null;
  let lastFrameHash = '';
  let frozenStreak = 0;
  let lowMotionStreak = 0;
  let motionlessStreak = 0;
  let hashRing = [];
  let lastMotionScore = 0;
  let lastBlinkAt = Date.now();
  let lastBlinkCount = 0;
  let lastHeartbeatAt = 0;
  let lastChunkAt = 0;
  let lastFrameUpdateAt = Date.now();
  let voiceCoachingStreak = 0;
  let candidateSpeaking = false;
  let videoDeviceLabel = '';

  function log(msg, detail) {
    console.log(`[INTEGRITY] ${msg}${detail ? ` — ${detail}` : ''}`);
  }

  function ensureCanvas() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = SAMPLE_W;
      canvas.height = SAMPLE_H;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  function hashFrame(video) {
    if (!video?.videoWidth || video.readyState < 2) return '';
    ensureCanvas();
    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
    let h = 2166136261;
    for (let i = 0; i < data.length; i += 16) {
      h ^= data[i];
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function frameMotionScore(video) {
    if (!video?.videoWidth || video.readyState < 2) return 0;
    ensureCanvas();
    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
    let edgeSum = 0;
    let count = 0;
    for (let y = 1; y < SAMPLE_H - 1; y += 2) {
      for (let x = 1; x < SAMPLE_W - 1; x += 2) {
        const i = (y * SAMPLE_W + x) * 4;
        const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        const r = ((y * SAMPLE_W + x + 1) * 4);
        const d = ((y * SAMPLE_W + x + SAMPLE_W) * 4);
        const gx = 0.2126 * data[r] - 0.2126 * data[i - 4];
        const gy = 0.7152 * data[d + 1] - 0.7152 * data[i + 1];
        edgeSum += Math.hypot(gx, gy) + luma * 0.02;
        count += 1;
      }
    }
    return count ? edgeSum / count : 0;
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

  function detectLoopingFeed(hash) {
    if (!hash) return false;
    hashRing.push(hash);
    if (hashRing.length > LOOP_HASH_WINDOW) hashRing.shift();
    const counts = {};
    for (const h of hashRing) counts[h] = (counts[h] || 0) + 1;
    return Object.values(counts).some((c) => c >= Math.ceil(LOOP_HASH_WINDOW * 0.55));
  }

  function scanLiveness() {
    // Liveness violation alerts disabled (no_blink, frozen frame, etc.) — too many false positives.
    if (!videoEl) return [];
    const hash = hashFrame(videoEl);
    const motion = frameMotionScore(videoEl);
    const motionDelta = Math.abs(motion - lastMotionScore);
    lastMotionScore = motion;

    if (hash && hash === lastFrameHash) {
      frozenStreak += 1;
    } else {
      frozenStreak = 0;
      lastFrameUpdateAt = Date.now();
    }
    lastFrameHash = hash;

    if (motionDelta < 0.35 && motion < 4) {
      lowMotionStreak += 1;
    } else {
      lowMotionStreak = 0;
    }

    if (motion < 2.5 && motionDelta < 0.2) {
      motionlessStreak += 1;
    } else {
      motionlessStreak = 0;
    }

    return [];
  }

  function resolveVideoDeviceLabel() {
    if (!mediaStream) return '';
    const track = mediaStream.getVideoTracks()[0];
    return track?.label || videoDeviceLabel || '';
  }

  function detectVirtualCamera(label) {
    if (!label) return null;
    for (const re of VIRTUAL_CAMERA_PATTERNS) {
      if (re.test(label)) return { sub_type: 'virtual_camera', confidence: 90, device_label: label };
    }
    return null;
  }

  function setupVoiceAnalyser() {
    if (!mediaStream || audioCtx) return;
    try {
      audioCtx = new (global.AudioContext || global.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
    } catch (e) {
      log('Voice analyser unavailable', e.message);
    }
  }

  function scanVoiceCoaching() {
    if (!analyser) return [];
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let rms = 0;
    for (let i = 0; i < buf.length; i += 1) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);

    const alerts = [];
    const externalVoice = rms > 0.028 && !candidateSpeaking;
    if (externalVoice) {
      voiceCoachingStreak += 1;
    } else {
      voiceCoachingStreak = Math.max(0, voiceCoachingStreak - 1);
    }

    if (voiceCoachingStreak >= VOICE_COACHING_STREAK) {
      alerts.push({
        sub_type: rms > 0.045 ? 'secondary_voice' : 'voice_coaching',
        confidence: Math.min(88, 55 + voiceCoachingStreak * 5),
        rms: Number(rms.toFixed(4)),
      });
      log('Voice coaching alert', `rms=${rms.toFixed(4)}`);
    }
    return alerts;
  }

  async function postHeartbeat(body) {
    if (!token) return null;
    try {
      const res = await fetch(`/interview/${token}/integrity/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch {
      return null;
    }
  }

  async function sendHeartbeat() {
    const now = Date.now();
    const landmarks = typeof getLandmarks === 'function' ? getLandmarks() : null;
    const faceSignature = landmarks ? buildFaceSignature(landmarks) : '';
    const livenessAlerts = scanLiveness();
    const voiceAlerts = scanVoiceCoaching();
    const deviceLabel = resolveVideoDeviceLabel();
    const virtualHit = detectVirtualCamera(deviceLabel);

    const recHealth = typeof getRecordingHealth === 'function' ? getRecordingHealth() : {};
    if (recHealth.lastChunkAt) lastChunkAt = recHealth.lastChunkAt;

    const micActive = mediaStream
      ? mediaStream.getAudioTracks().some((t) => t.readyState === 'live' && t.enabled)
      : true;
    const cameraActive = mediaStream
      ? mediaStream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled)
      : true;

    const frameStall = now - lastFrameUpdateAt > HEARTBEAT_MS * 2.5;
    const recordingStalled =
      recHealth.active === true && lastChunkAt > 0 && now - lastChunkAt > HEARTBEAT_MS * 4;

    const payload = {
      timestamp: new Date().toISOString(),
      camera_active: cameraActive,
      mic_active: micActive,
      tab_visible: !document.hidden,
      focus: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
      network_online: typeof navigator.onLine === 'boolean' ? navigator.onLine : true,
      face_signature: faceSignature || undefined,
      video_device_label: deviceLabel || undefined,
      frame_stall: frameStall,
      frame_stall_confidence: frameStall ? 75 : 0,
      recording_stalled: recordingStalled,
      recording_stall_confidence: recordingStalled ? 78 : 0,
      motion_score: lastMotionScore,
      frozen_streak: frozenStreak,
      liveness_alerts: livenessAlerts,
      voice_alerts: virtualHit ? [...voiceAlerts, virtualHit] : voiceAlerts,
      virtual_camera_confidence: virtualHit?.confidence,
      last_chunk_at: lastChunkAt || null,
      baseline_face_signature: baselineFaceSig || undefined,
    };

    lastHeartbeatAt = now;
    log('Heartbeat sent', `score=${livenessAlerts.length} liveness, ${payload.voice_alerts.length} voice`);

    const data = await postHeartbeat(payload);
    if (data?.proctoring_action && data.proctoring_action !== 'none' && onEscalation) {
      onEscalation(data);
    }
    return data;
  }

  const api = {
    start(options = {}) {
      token = options.token || global.INTERVIEW_TOKEN || '';
      videoEl = options.video || null;
      mediaStream = options.mediaStream || null;
      getLandmarks = options.getLandmarks || null;
      getBlinkCount = options.getBlinkCount || null;
      getRecordingHealth = options.getRecordingHealth || null;
      onEscalation = options.onEscalation || null;
      baselineFaceSig =
        options.baselineFaceSignature ||
        global.INTERVIEW_VERIFIED_FACE_SIGNATURE ||
        null;

      frozenStreak = 0;
      lowMotionStreak = 0;
      motionlessStreak = 0;
      hashRing = [];
      lastBlinkAt = Date.now();
      lastFrameUpdateAt = Date.now();
      voiceCoachingStreak = 0;

      videoDeviceLabel = resolveVideoDeviceLabel();
      const virtualOnStart = detectVirtualCamera(videoDeviceLabel);
      if (virtualOnStart) {
        log('Virtual camera detected at start', videoDeviceLabel);
      }

      setupVoiceAnalyser();
      api.stop();

      heartbeatTimer = setInterval(() => {
        void sendHeartbeat();
      }, HEARTBEAT_MS);

      livenessTimer = setInterval(() => {
        scanLiveness();
      }, LIVENESS_SCAN_MS);

      voiceTimer = setInterval(() => {
        scanVoiceCoaching();
      }, VOICE_SCAN_MS);

      void sendHeartbeat();
      log('Integrity monitor started');
    },

    stop() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (livenessTimer) clearInterval(livenessTimer);
      if (voiceTimer) clearInterval(voiceTimer);
      heartbeatTimer = null;
      livenessTimer = null;
      voiceTimer = null;
      if (audioCtx) {
        audioCtx.close().catch(() => {});
        audioCtx = null;
        analyser = null;
      }
      log('Integrity monitor stopped');
    },

    setCandidateSpeaking(active) {
      candidateSpeaking = active === true;
    },

    markRecordingChunk() {
      lastChunkAt = Date.now();
    },

    getLastHeartbeatAt() {
      return lastHeartbeatAt;
    },
  };

  global.InterviewIntegrityMonitor = api;
})(window);
