/**
 * Real-time eye-tracking cheat detection (MediaPipe FaceMesh + iris landmarks).
 * Client-side only — no raw video stored; optional single-frame screenshot on HARD_FLAG.
 */
(function (global) {
  const LANDMARKS = {
    NOSE_TIP: 1,
    CHIN: 199,
    LEFT_TEMPLE: 234,
    RIGHT_TEMPLE: 454,
    LEFT_IRIS: 468,
    RIGHT_IRIS: 473,
    LEFT_EYE_INNER: 33,
    LEFT_EYE_OUTER: 133,
    RIGHT_EYE_INNER: 362,
    RIGHT_EYE_OUTER: 263,
    LEFT_EYE_TOP: 159,
    LEFT_EYE_BOTTOM: 145,
    RIGHT_EYE_TOP: 386,
    RIGHT_EYE_BOTTOM: 374,
  };

  const GAZE_ZONE = {
    H_MIN: 0.3,
    H_MAX: 0.7,
    V_MIN: 0.25,
    V_MAX: 0.75,
    DOWN_Y: 0.72,
    LEFT_X: 0.25,
    RIGHT_X: 0.75,
  };

  const HEAD_POSE_LIMITS = { PITCH_DOWN_DEG: 20, YAW_SIDE_DEG: 30 };

  const BEHAVIOR_DEFAULTS = {
    WINDOW_MS: 3000,
    TARGET_FPS: 15,
    SOFT_OFF_SCREEN_RATIO: 0.6,
    HARD_CONTINUOUS_MS: 5000,
    FLAG_DEBOUNCE_MS: 10_000,
  };

  function clamp01(n) {
    return Math.min(1, Math.max(0, n));
  }

  function lm(landmarks, idx) {
    return landmarks?.[idx] || null;
  }

  function eyeGazeRatio(inner, outer, top, bottom, iris) {
    if (!inner || !outer || !iris) return null;
    const minX = Math.min(inner.x, outer.x);
    const maxX = Math.max(inner.x, outer.x);
    const width = maxX - minX || 0.001;
    let hRatio = (iris.x - minX) / width;
    if (outer.x < inner.x) hRatio = 1 - hRatio;
    let vRatio = 0.5;
    if (top && bottom) {
      const minY = Math.min(top.y, bottom.y);
      const maxY = Math.max(top.y, bottom.y);
      vRatio = (iris.y - minY) / ((maxY - minY) || 0.001);
    }
    return { x: clamp01(hRatio), y: clamp01(vRatio) };
  }

  function estimateHeadPose(landmarks) {
    const nose = lm(landmarks, LANDMARKS.NOSE_TIP);
    const chin = lm(landmarks, LANDMARKS.CHIN);
    const leftTemple = lm(landmarks, LANDMARKS.LEFT_TEMPLE);
    const rightTemple = lm(landmarks, LANDMARKS.RIGHT_TEMPLE);
    const leftInner = lm(landmarks, LANDMARKS.LEFT_EYE_INNER);
    const rightInner = lm(landmarks, LANDMARKS.RIGHT_EYE_INNER);
    if (!nose || !chin || !leftTemple || !rightTemple) {
      return { yaw: 0, pitch: 0, valid: false };
    }
    const midTempleX = (leftTemple.x + rightTemple.x) / 2;
    const templeSpan = Math.abs(rightTemple.x - leftTemple.x) || 0.001;
    const yaw = ((nose.x - midTempleX) / templeSpan) * 90;
    const refY = leftInner && rightInner ? (leftInner.y + rightInner.y) / 2 : nose.y;
    const faceHeight = Math.abs(chin.y - refY) || 0.001;
    const pitch = ((chin.y - nose.y) / faceHeight - 0.55) * 120;
    return { yaw: Number(yaw.toFixed(2)), pitch: Number(pitch.toFixed(2)), valid: true };
  }

  function applyCalibration(ratio, calibration) {
    if (!calibration?.center) return ratio;
    const cx = calibration.center.x ?? 0.5;
    const cy = calibration.center.y ?? 0.5;
    return { x: clamp01(0.5 + (ratio.x - cx)), y: clamp01(0.5 + (ratio.y - cy)) };
  }

  function classifyDirection(ratio, headPose) {
    const yawSide = headPose.valid && Math.abs(headPose.yaw) >= HEAD_POSE_LIMITS.YAW_SIDE_DEG;
    if (ratio.x < GAZE_ZONE.LEFT_X || (yawSide && headPose.yaw < 0)) return 'left';
    if (ratio.x > GAZE_ZONE.RIGHT_X || (yawSide && headPose.yaw > 0)) return 'right';
    // Downward gaze is intentionally not flagged — natural when thinking or reading notes.
    return 'center';
  }

  class GazeTracker {
    constructor(options = {}) {
      this.calibration = options.calibration || null;
      this._lastFrame = null;
    }

    setCalibration(calibration) {
      this.calibration = calibration;
    }

    analyzeLandmarks(landmarks) {
      const now = Date.now();
      if (!landmarks?.length) {
        this._lastFrame = { valid: false, timestamp: now };
        return this._lastFrame;
      }

      const left = eyeGazeRatio(
        lm(landmarks, LANDMARKS.LEFT_EYE_INNER),
        lm(landmarks, LANDMARKS.LEFT_EYE_OUTER),
        lm(landmarks, LANDMARKS.LEFT_EYE_TOP),
        lm(landmarks, LANDMARKS.LEFT_EYE_BOTTOM),
        lm(landmarks, LANDMARKS.LEFT_IRIS)
      );
      const right = eyeGazeRatio(
        lm(landmarks, LANDMARKS.RIGHT_EYE_INNER),
        lm(landmarks, LANDMARKS.RIGHT_EYE_OUTER),
        lm(landmarks, LANDMARKS.RIGHT_EYE_TOP),
        lm(landmarks, LANDMARKS.RIGHT_EYE_BOTTOM),
        lm(landmarks, LANDMARKS.RIGHT_IRIS)
      );

      if (!left || !right) {
        this._lastFrame = { valid: false, timestamp: now };
        return this._lastFrame;
      }

      let gazeRatio = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
      gazeRatio = applyCalibration(gazeRatio, this.calibration);
      const headPose = estimateHeadPose(landmarks);
      const direction = classifyDirection(gazeRatio, headPose);

      this._lastFrame = {
        valid: true,
        gazeRatio,
        headPose,
        onScreen: direction === 'center',
        direction,
        timestamp: now,
      };
      return this._lastFrame;
    }

    getLastFrame() {
      return this._lastFrame;
    }
  }

  function avgRatio(frames) {
    if (!frames.length) return { x: 0.5, y: 0.5 };
    const sum = frames.reduce(
      (acc, f) => {
        acc.x += f.gazeRatio?.x ?? 0.5;
        acc.y += f.gazeRatio?.y ?? 0.5;
        return acc;
      },
      { x: 0, y: 0 }
    );
    return { x: Number((sum.x / frames.length).toFixed(4)), y: Number((sum.y / frames.length).toFixed(4)) };
  }

  function dominantDirection(frames) {
    const counts = { left: 0, right: 0 };
    for (const f of frames) {
      if (f.direction === 'left') counts.left += 1;
      else if (f.direction === 'right') counts.right += 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top && top[1] > 0 ? top[0] : null;
  }

  class BehaviorAnalyzer {
    constructor(options = {}) {
      this.sessionId = options.sessionId || '';
      this.windowMs = options.windowMs ?? BEHAVIOR_DEFAULTS.WINDOW_MS;
      this.targetFps = options.targetFps ?? BEHAVIOR_DEFAULTS.TARGET_FPS;
      this.softOffScreenRatio =
        options.softOffScreenRatio ?? BEHAVIOR_DEFAULTS.SOFT_OFF_SCREEN_RATIO;
      this.hardContinuousMs = options.hardContinuousMs ?? BEHAVIOR_DEFAULTS.HARD_CONTINUOUS_MS;
      this.flagDebounceMs = options.flagDebounceMs ?? BEHAVIOR_DEFAULTS.FLAG_DEBOUNCE_MS;
      this.captureScreenshot = options.captureScreenshot || null;
      this._frames = [];
      this._offScreenSince = null;
      this._lastFlagAt = 0;
      this._activeFlag = null;
      this._minFrameGapMs = Math.floor(1000 / this.targetFps);
      this._lastSampleAt = 0;
    }

    reset() {
      this._frames = [];
      this._offScreenSince = null;
      this._activeFlag = null;
      this._lastSampleAt = 0;
    }

    async pushFrame(frame) {
      if (!frame?.valid) return null;
      const now = frame.timestamp || Date.now();
      if (now - this._lastSampleAt < this._minFrameGapMs) return null;
      this._lastSampleAt = now;

      this._frames.push(frame);
      const cutoff = now - this.windowMs;
      this._frames = this._frames.filter((f) => f.timestamp >= cutoff);

      if (frame.onScreen) {
        this._offScreenSince = null;
        this._activeFlag = null;
        return null;
      }

      if (!this._offScreenSince) this._offScreenSince = now;
      const continuousMs = now - this._offScreenSince;
      const offFrames = this._frames.filter((f) => !f.onScreen);
      const offRatio = this._frames.length ? offFrames.length / this._frames.length : 0;

      let flagType = null;
      if (continuousMs >= this.hardContinuousMs) flagType = 'HARD_FLAG';
      else if (offRatio >= this.softOffScreenRatio && this._frames.length >= 8) flagType = 'SOFT_FLAG';

      if (!flagType) return null;
      if (now - this._lastFlagAt < this.flagDebounceMs) return null;
      if (this._activeFlag === flagType) return null;

      this._lastFlagAt = now;
      this._activeFlag = flagType;

      const event = {
        eventType: flagType,
        timestamp: new Date(now).toISOString(),
        sessionId: this.sessionId,
        durationMs: continuousMs,
        gazeDirection: dominantDirection(offFrames),
        averageGazeRatio: avgRatio(offFrames),
        headPitch: Number((frame.headPose?.pitch ?? 0).toFixed(2)),
        headYaw: Number((frame.headPose?.yaw ?? 0).toFixed(2)),
      };

      if (flagType === 'HARD_FLAG' && this.captureScreenshot) {
        try {
          const shot = await this.captureScreenshot();
          if (shot) event.screenshotBase64 = shot;
        } catch (_) {}
      }
      return event;
    }

    buildTelemetrySnapshot() {
      const now = Date.now();
      const windowFrames = this._frames.filter((f) => f.timestamp >= now - this.windowMs);
      const offFrames = windowFrames.filter((f) => !f.onScreen);
      const offPct = windowFrames.length
        ? Math.round((offFrames.length / windowFrames.length) * 100)
        : 0;
      const continuousSec = this._offScreenSince ? (now - this._offScreenSince) / 1000 : 0;
      const last = windowFrames[windowFrames.length - 1];

      return {
        gaze_valid: !!last?.valid,
        gaze_yaw: last?.gazeRatio?.x != null ? Number((last.gazeRatio.x - 0.5).toFixed(4)) : 0,
        gaze_pitch: last?.gazeRatio?.y != null ? Number((last.gazeRatio.y - 0.5).toFixed(4)) : 0,
        gaze_ratio_x: last?.gazeRatio?.x ?? null,
        gaze_ratio_y: last?.gazeRatio?.y ?? null,
        gaze_zone: last?.direction === 'center' ? 'screen' : last?.direction || 'screen',
        yaw: last?.headPose?.yaw ?? 0,
        pitch: last?.headPose?.pitch ?? 0,
        gaze_off_screen_seconds: Number(continuousSec.toFixed(2)),
        gaze_down_seconds: 0,
        gaze_off_screen_pct_10s: offPct,
        off_screen_direction: last?.direction === 'center' ? null : last?.direction,
        downward_gaze_seconds: 0,
        off_screen_gaze_seconds: Number(continuousSec.toFixed(2)),
        screen_attention_pct: 100 - offPct,
        gaze_cheat_active_flag: this._activeFlag,
      };
    }
  }

  class GazeCalibration {
    constructor() {
      this.points = [
        { id: 'top_left', label: 'Look at the top-left corner of your screen' },
        { id: 'top_right', label: 'Look at the top-right corner of your screen' },
        { id: 'bottom_left', label: 'Look at the bottom-left corner of your screen' },
        { id: 'bottom_right', label: 'Look at the bottom-right corner of your screen' },
        { id: 'center', label: 'Look at the center of your screen' },
      ];
      this.samples = {};
      this.index = 0;
      this.complete = false;
    }

    get currentStep() {
      return this.complete ? null : this.points[this.index] || null;
    }

    recordSample(gazeRatio) {
      const step = this.currentStep;
      if (!step || !gazeRatio) return false;
      if (!this.samples[step.id]) this.samples[step.id] = [];
      this.samples[step.id].push({ x: gazeRatio.x, y: gazeRatio.y });
      if (this.samples[step.id].length < 12) return false;
      this.index += 1;
      if (this.index >= this.points.length) this.complete = true;
      return true;
    }

    finish() {
      const centerSamples = this.samples.center;
      if (!centerSamples?.length) return null;
      const avg = (arr) => ({
        x: arr.reduce((s, v) => s + v.x, 0) / arr.length,
        y: arr.reduce((s, v) => s + v.y, 0) / arr.length,
      });
      const center = avg(centerSamples);
      const points = {};
      for (const p of this.points) {
        if (this.samples[p.id]?.length) points[p.id] = avg(this.samples[p.id]);
      }
      return { center, points };
    }
  }

  class GazeCheatDetector {
    constructor(options = {}) {
      this.sessionId = options.sessionId || '';
      this.onFlag = options.onFlag || null;
      this.videoEl = options.videoEl || null;
      this.debug = !!options.debug;
      this.tracker = new GazeTracker({ calibration: options.calibration });
      this.analyzer = new BehaviorAnalyzer({
        sessionId: this.sessionId,
        captureScreenshot: () => this.captureScreenshot(),
        ...(options.behaviorOptions || {}),
      });
      this.calibration = options.enableCalibration ? new GazeCalibration() : null;
      this._busy = false;
    }

    setSessionId(id) {
      this.sessionId = id || '';
      this.analyzer.sessionId = this.sessionId;
    }

    setVideoElement(el) {
      this.videoEl = el || null;
    }

    applyCalibration(calibration) {
      this.tracker.setCalibration(calibration);
    }

    async processLandmarks(landmarks) {
      if (this._busy || !landmarks?.length) return null;
      this._busy = true;
      try {
        const frame = this.tracker.analyzeLandmarks(landmarks);
        if (this.calibration && !this.calibration.complete && frame.valid) {
          this.calibration.recordSample(frame.gazeRatio);
          if (this.calibration.complete) {
            const baseline = this.calibration.finish();
            if (baseline) this.applyCalibration(baseline);
          }
        }
        if (this.debug && frame.valid) {
          console.log('[GazeTracker]', frame.gazeRatio, frame.direction, frame.headPose);
        }
        const event = await this.analyzer.pushFrame(frame);
        if (event && this.onFlag) this.onFlag(event);
        return event;
      } finally {
        this._busy = false;
      }
    }

    buildTelemetrySnapshot() {
      return this.analyzer.buildTelemetrySnapshot();
    }

    reset() {
      this.analyzer.reset();
      this.calibration?.reset?.();
    }

    captureScreenshot() {
      const video = this.videoEl;
      if (!video?.videoWidth || video.readyState < 2) return null;
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(640, video.videoWidth);
      canvas.height = Math.round((canvas.width / video.videoWidth) * video.videoHeight);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return (canvas.toDataURL('image/jpeg', 0.72).split(',')[1] || null);
    }
  }

  /** Standalone webcam demo — logs gaze ratios to console. */
  class AssessmentCamera {
    constructor(videoEl, options = {}) {
      this.video = videoEl;
      this.detector = new GazeCheatDetector({
        debug: options.debug !== false,
        videoEl,
        behaviorOptions: options.behaviorOptions,
        onFlag: options.onFlag,
      });
      this.faceMesh = null;
      this.running = false;
      this._stream = null;
    }

    async start() {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      this.video.srcObject = this._stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();

      if (typeof FaceMesh === 'undefined') throw new Error('FaceMesh not loaded');
      this.faceMesh = new FaceMesh({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });
      this.faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      this.running = true;
      this.faceMesh.onResults((results) => {
        const landmarks = results.multiFaceLandmarks?.[0];
        if (landmarks) void this.detector.processLandmarks(landmarks);
      });

      const loop = async () => {
        if (!this.running) return;
        try {
          if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            await this.faceMesh.send({ image: this.video });
          }
        } catch (_) {}
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    stop() {
      this.running = false;
      this._stream?.getTracks?.().forEach((t) => t.stop());
      this.faceMesh?.close?.();
    }
  }

  global.GazeTracking = {
    LANDMARKS,
    GAZE_ZONE,
    HEAD_POSE_LIMITS,
    BEHAVIOR_DEFAULTS,
    GazeTracker,
    BehaviorAnalyzer,
    GazeCalibration,
    GazeCheatDetector,
    AssessmentCamera,
    estimateHeadPose,
    createDetector: (opts) => new GazeCheatDetector(opts),
  };
})(window);
