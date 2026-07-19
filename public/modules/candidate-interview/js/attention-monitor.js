/**
 * Eye gaze + head pose attention monitoring over rolling 10s windows.
 * Requires MediaPipe FaceMesh with refineLandmarks: true.
 */
window.InterviewAttentionMonitor = (function () {
  const DEFAULTS = {
    analysisWindowMs: 12_000,
    /** Iris relative to eye center — on-screen band (wider = more tolerant) */
    gazeOnScreenYaw: 0.14,
    gazeOnScreenPitch: 0.14,
    gazeDownPitch: 0.20,
    gazeSideYaw: 0.18,
    gazeUpPitch: 0.15,
    /** Head pose degrees — higher = only sustained turns count as away */
    headYawAway: 28,
    headPitchDown: 32,
    headPitchUp: 22,
    /** Debounce: consecutive off-screen samples before streak timer starts */
    debounceSamples: 4,
    /** Pre-answer glance: ms looking off-screen before answer starts (brief thinking is OK) */
    preAnswerGlanceMs: 2800,
    /** Scanning: min distinct off-screen zones + moves in window */
    gazeScanMinZones: 4,
    gazeScanMinMoves: 6,
    headScanMinZones: 4,
    headScanMinMoves: 5,
  };

  function eyeGazeFromLandmarks(landmarks) {
    if (!landmarks?.length) return { gazeYaw: 0, gazePitch: 0, valid: false };

    const leftInner = landmarks[133];
    const leftOuter = landmarks[33];
    const leftTop = landmarks[159];
    const leftBottom = landmarks[145];
    const rightInner = landmarks[362];
    const rightOuter = landmarks[263];
    const rightTop = landmarks[386];
    const rightBottom = landmarks[374];
    const leftIris = landmarks[468];
    const rightIris = landmarks[473];

    if (!leftInner || !leftOuter || !rightInner || !rightOuter) {
      return { gazeYaw: 0, gazePitch: 0, valid: false };
    }

    const irisL = leftIris || {
      x: (leftInner.x + leftOuter.x) / 2,
      y: (leftTop.y + leftBottom.y) / 2,
    };
    const irisR = rightIris || {
      x: (rightInner.x + rightOuter.x) / 2,
      y: (rightTop.y + rightBottom.y) / 2,
    };

    const leftW = Math.hypot(leftOuter.x - leftInner.x, leftOuter.y - leftInner.y) || 0.001;
    const leftH = Math.abs(leftBottom.y - leftTop.y) || 0.001;
    const rightW = Math.hypot(rightOuter.x - rightInner.x, rightOuter.y - rightInner.y) || 0.001;
    const rightH = Math.abs(rightBottom.y - rightTop.y) || 0.001;

    const leftGx = (irisL.x - (leftInner.x + leftOuter.x) / 2) / leftW;
    const leftGy = (irisL.y - (leftTop.y + leftBottom.y) / 2) / leftH;
    const rightGx = (irisR.x - (rightInner.x + rightOuter.x) / 2) / rightW;
    const rightGy = (irisR.y - (rightTop.y + rightBottom.y) / 2) / rightH;

    return {
      gazeYaw: (leftGx + rightGx) / 2,
      gazePitch: (leftGy + rightGy) / 2,
      valid: true,
    };
  }

  function classifyGaze(gaze, thresholds) {
    const gY = gaze.gazeYaw || 0;
    const gP = gaze.gazePitch || 0;
    const onScreen =
      Math.abs(gY) < thresholds.gazeOnScreenYaw && Math.abs(gP) < thresholds.gazeOnScreenPitch;

    if (onScreen) {
      return { zone: 'screen', onScreen: true, lookingDown: false };
    }

    let zone = 'off_screen';
    let lookingDown = false;
    if (gP >= thresholds.gazeDownPitch) {
      lookingDown = true;
      zone = gY < -0.05 ? 'down_left' : gY > 0.05 ? 'down_right' : 'down';
      // Downward gaze is natural when thinking — do not treat as off-screen.
      return { zone: 'screen', onScreen: true, lookingDown: true };
    } else if (gY >= thresholds.gazeSideYaw) {
      zone = 'right';
    } else if (gY <= -thresholds.gazeSideYaw) {
      zone = 'left';
    } else if (gP <= -thresholds.gazeUpPitch) {
      zone = 'up';
    }

    return { zone, onScreen: false, lookingDown };
  }

  function classifyHead(headPose, thresholds) {
    const yaw = headPose.yaw || 0;
    const pitch = headPose.pitch || 0;
    const absYaw = Math.abs(yaw);

    const away =
      absYaw >= thresholds.headYawAway ||
      pitch <= -thresholds.headPitchUp ||
      (pitch >= thresholds.headPitchDown && absYaw >= thresholds.headYawAway);

    if (!away) {
      const lookingDown = pitch >= thresholds.headPitchDown;
      return { zone: 'forward', onScreen: true, lookingDown, away: false, yaw, pitch };
    }

    let zone = 'away';
    let lookingDown = pitch >= thresholds.headPitchDown;
    if (lookingDown) {
      zone = yaw > 12 ? 'down_right' : yaw < -12 ? 'down_left' : 'down';
    } else if (absYaw >= thresholds.headYawAway) {
      zone = yaw > 0 ? 'right' : 'left';
    } else if (pitch <= -thresholds.headPitchUp) {
      zone = 'up';
    }

    return { zone, onScreen: false, lookingDown, away: true, yaw, pitch };
  }

  function countZoneChanges(samples, key) {
    let changes = 0;
    let prev = 'screen';
    for (const s of samples) {
      const z = s[key];
      if (z !== prev && z !== 'screen' && prev !== 'screen') changes += 1;
      if (z !== prev) prev = z;
    }
    return changes;
  }

  function countOffScreenMoves(samples, key) {
    let moves = 0;
    let prev = null;
    for (const s of samples) {
      const z = s[key];
      const isOff = z !== 'screen' && z !== 'forward';
      if (isOff && prev != null && prev !== z) moves += 1;
      if (isOff) prev = z;
      else if (z === 'screen' || z === 'forward') prev = null;
    }
    return moves;
  }

  function countMoves(samples, key) {
    let moves = 0;
    let prev = null;
    for (const s of samples) {
      const z = s[key];
      if (prev != null && z !== prev) moves += 1;
      prev = z;
    }
    return moves;
  }

  function pctOffScreen(samples, key) {
    if (!samples.length) return 0;
    const off = samples.filter((s) => s[key] !== 'screen' && s[key] !== 'forward').length;
    return Math.round((off / samples.length) * 100);
  }

  function uniqueZones(samples, key) {
    const set = new Set();
    for (const s of samples) {
      const z = s[key];
      if (z !== 'screen' && z !== 'forward') set.add(z);
    }
    return set.size;
  }

  class AttentionMonitor {
    constructor(options = {}) {
      this.thresholds = { ...DEFAULTS, ...options };
      this.reset();
    }

    reset() {
      this.samples = [];
      this.gazeOffDebounced = 0;
      this.gazeDownDebounced = 0;
      this.headOffDebounced = 0;
      this.headDownDebounced = 0;
      this.combinedDownDebounced = 0;
      this.gazeOffSince = null;
      this.gazeDownSince = null;
      this.headOffSince = null;
      this.headDownSince = null;
      this.combinedDownSince = null;
      this.gazeFixedZone = null;
      this.gazeFixedSince = null;
      this.lastGazeZone = 'screen';
      this.lastHeadZone = 'forward';
      this.answerPhaseActive = false;
      this.answerSamples = [];
      this.preAnswerOffMs = 0;
      this.lastOffGlanceAt = null;
      this.preAnswerGlanceDown = false;
      this.preSpeechGlanceCount = 0;
      this.lastUpdateAt = null;
    }

    markAnswerPhaseStart() {
      const now = Date.now();
      this.answerPhaseActive = true;
      this.answerSamples = [];

      const gazeOffMs = this.gazeOffSince ? now - this.gazeOffSince : 0;
      const headOffMs = this.headOffSince ? now - this.headOffSince : 0;
      const recentGlanceMs = this.lastOffGlanceAt ? now - this.lastOffGlanceAt : Infinity;
      const offMs = Math.max(gazeOffMs, headOffMs, this.preAnswerOffMs);

      if (
        offMs >= this.thresholds.preAnswerGlanceMs ||
        recentGlanceMs <= this.thresholds.preAnswerGlanceMs
      ) {
        this.preAnswerGlanceDown = true;
        this.preSpeechGlanceCount += 1;
      }
      this.preAnswerOffMs = 0;
    }

    markAnswerPhaseEnd() {
      this.answerPhaseActive = false;
      this.answerSamples = [];
      this.preAnswerGlanceDown = false;
    }

    _debouncedStreak(isActive, debounceKey, sinceKey, now) {
      if (isActive) {
        this[debounceKey] += 1;
        if (this[debounceKey] >= this.thresholds.debounceSamples && !this[sinceKey]) {
          this[sinceKey] = now;
        }
      } else {
        this[debounceKey] = 0;
        this[sinceKey] = null;
      }
      return this[sinceKey] ? (now - this[sinceKey]) / 1000 : 0;
    }

    update(landmarks, headPose, { speaking = false } = {}) {
      const now = Date.now();
      const gaze = eyeGazeFromLandmarks(landmarks);
      const gazeCls = classifyGaze(gaze, this.thresholds);
      const headCls = classifyHead(headPose, this.thresholds);
      const combinedDown = gazeCls.lookingDown && headCls.lookingDown;

      if (!gazeCls.onScreen || headCls.away) {
        this.lastOffGlanceAt = now;
        this.preAnswerOffMs = (this.preAnswerOffMs || 0) + (this.lastUpdateAt ? now - this.lastUpdateAt : 0);
      } else if (!this.answerPhaseActive) {
        this.preAnswerOffMs = 0;
      }

      const gazeOffSec = this._debouncedStreak(!gazeCls.onScreen, 'gazeOffDebounced', 'gazeOffSince', now);
      const gazeDownSec = this._debouncedStreak(
        gazeCls.lookingDown,
        'gazeDownDebounced',
        'gazeDownSince',
        now
      );
      const headOffSec = this._debouncedStreak(headCls.away, 'headOffDebounced', 'headOffSince', now);
      const headDownSec = this._debouncedStreak(
        headCls.lookingDown,
        'headDownDebounced',
        'headDownSince',
        now
      );
      const combinedDownSec = this._debouncedStreak(
        combinedDown,
        'combinedDownDebounced',
        'combinedDownSince',
        now
      );

      if (!gazeCls.onScreen && gazeCls.zone === this.gazeFixedZone) {
        if (!this.gazeFixedSince) this.gazeFixedSince = now;
      } else {
        this.gazeFixedZone = !gazeCls.onScreen ? gazeCls.zone : null;
        this.gazeFixedSince = !gazeCls.onScreen ? now : null;
      }
      const gazeFixedOffSec = this.gazeFixedSince ? (now - this.gazeFixedSince) / 1000 : 0;

      this.samples.push({
        at: now,
        gazeZone: gazeCls.zone,
        headZone: headCls.zone,
        gazeOnScreen: gazeCls.onScreen,
        headOnScreen: headCls.onScreen,
        combinedDown,
        speaking,
      });
      const cutoff = now - this.thresholds.analysisWindowMs;
      this.samples = this.samples.filter((s) => s.at >= cutoff);

      if (this.answerPhaseActive) {
        this.answerSamples.push({
          gazeOnScreen: gazeCls.onScreen,
          headOnScreen: headCls.onScreen,
        });
      }

      this.lastGazeZone = gazeCls.zone;
      this.lastHeadZone = headCls.zone;
      this.lastUpdateAt = now;

      return {
        gaze_yaw: Number((gaze.gazeYaw || 0).toFixed(4)),
        gaze_pitch: Number((gaze.gazePitch || 0).toFixed(4)),
        gaze_valid: gaze.valid,
        yaw: Number((headCls.yaw || 0).toFixed(1)),
        pitch: Number((headCls.pitch || 0).toFixed(1)),
        gaze_zone: gazeCls.zone,
        head_zone: headCls.zone,
        attention_direction: gazeCls.zone,
        looking_down: gazeCls.lookingDown || headCls.lookingDown,
        on_screen: gazeCls.onScreen && headCls.onScreen,
      };
    }

    buildTelemetrySnapshot() {
      const now = Date.now();
      const windowMs = this.thresholds.analysisWindowMs;
      const windowSamples = this.samples.filter((s) => s.at >= now - windowMs);
      const windowSec = windowMs / 1000;

      const gazeMoves10s = countOffScreenMoves(windowSamples, 'gazeZone');
      const headTurns10s = countOffScreenMoves(windowSamples, 'headZone');
      const gazeOffPct10s = pctOffScreen(windowSamples, 'gazeZone');
      const headOffPct10s = pctOffScreen(windowSamples, 'headZone');
      const gazeDirections10s = uniqueZones(windowSamples, 'gazeZone');
      const headDirections10s = uniqueZones(windowSamples, 'headZone');
      const t = this.thresholds;
      const gazeScanning10s =
        this.answerPhaseActive &&
        gazeDirections10s >= (t.gazeScanMinZones || 4) &&
        gazeMoves10s >= (t.gazeScanMinMoves || 6);
      const headScanning10s =
        this.answerPhaseActive &&
        headDirections10s >= (t.headScanMinZones || 4) &&
        headTurns10s >= (t.headScanMinMoves || 5);

      const answerGazeOffPct =
        this.answerSamples.length > 0
          ? Math.round(
              (this.answerSamples.filter((s) => !s.gazeOnScreen).length /
                this.answerSamples.length) *
                100
            )
          : 0;
      const answerHeadOffPct =
        this.answerSamples.length > 0
          ? Math.round(
              (this.answerSamples.filter((s) => !s.headOnScreen).length /
                this.answerSamples.length) *
                100
            )
          : 0;

      const gazeOffSec = this.gazeOffSince ? (now - this.gazeOffSince) / 1000 : 0;
      const gazeDownSec = this.gazeDownSince ? (now - this.gazeDownSince) / 1000 : 0;
      const headOffSec = this.headOffSince ? (now - this.headOffSince) / 1000 : 0;
      const headDownSec = this.headDownSince ? (now - this.headDownSince) / 1000 : 0;
      const combinedDownSec = this.combinedDownSince ? (now - this.combinedDownSince) / 1000 : 0;
      const gazeFixedOffSec = this.gazeFixedSince ? (now - this.gazeFixedSince) / 1000 : 0;

      const pre = this.preAnswerGlanceDown;
      const preSpeechCount = this.preSpeechGlanceCount;
      this.preAnswerGlanceDown = false;

      return {
        attention_window_sec: windowSec,
        attention_sample_count: windowSamples.length,
        gaze_off_screen_seconds: Number(gazeOffSec.toFixed(2)),
        gaze_down_seconds: 0,
        gaze_fixed_off_seconds: Number(gazeFixedOffSec.toFixed(2)),
        gaze_fixed_zone: this.gazeFixedZone,
        head_off_screen_seconds: Number(headOffSec.toFixed(2)),
        head_down_seconds: 0,
        combined_down_seconds: 0,
        gaze_moves_10s: gazeMoves10s,
        head_turns_10s: headTurns10s,
        gaze_off_screen_pct_10s: gazeOffPct10s,
        head_off_screen_pct_10s: headOffPct10s,
        gaze_scanning_10s: gazeScanning10s,
        head_scanning_10s: headScanning10s,
        answer_phase_active: this.answerPhaseActive,
        answer_gaze_off_pct: answerGazeOffPct,
        answer_head_off_pct: answerHeadOffPct,
        pre_answer_glance_down: false,
        pre_speech_glance_count: preSpeechCount,
        // legacy fields kept for compatibility
        downward_gaze_seconds: 0,
        off_screen_gaze_seconds: Number(gazeOffSec.toFixed(2)),
        off_screen_direction: this.gazeFixedZone || this.lastGazeZone,
        side_glance_count: windowSamples.filter((s) => s.gazeZone === 'left' || s.gazeZone === 'right')
          .length,
        gaze_shift_count: gazeMoves10s,
        screen_attention_pct: 100 - gazeOffPct10s,
        reading_pattern_score: gazeScanning10s ? 0.7 : headScanning10s ? 0.65 : 0,
      };
    }
  }

  return { AttentionMonitor, eyeGazeFromLandmarks, classifyGaze, classifyHead };
})();
