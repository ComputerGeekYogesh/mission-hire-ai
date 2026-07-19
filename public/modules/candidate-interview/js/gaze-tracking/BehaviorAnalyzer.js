import { BEHAVIOR_DEFAULTS } from './types.js';

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
  return {
    x: Number((sum.x / frames.length).toFixed(4)),
    y: Number((sum.y / frames.length).toFixed(4)),
  };
}

function dominantDirection(frames) {
  const counts = { left: 0, right: 0 };
  for (const f of frames) {
    if (f.direction === 'left') counts.left += 1;
    else if (f.direction === 'right') counts.right += 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] === 0) return 'center';
  return top[0];
}

/**
 * Rolling-window gaze behavior analysis with SOFT/HARD cheat flags.
 */
export class BehaviorAnalyzer {
  /**
   * @param {{
   *   sessionId?: string,
   *   windowMs?: number,
   *   targetFps?: number,
   *   softOffScreenRatio?: number,
   *   hardContinuousMs?: number,
   *   flagDebounceMs?: number,
   *   captureScreenshot?: () => Promise<string|null>|string|null,
   * }} [options]
   */
  constructor(options = {}) {
    this.sessionId = options.sessionId || '';
    this.windowMs = options.windowMs ?? BEHAVIOR_DEFAULTS.WINDOW_MS;
    this.targetFps = options.targetFps ?? BEHAVIOR_DEFAULTS.TARGET_FPS;
    this.softOffScreenRatio =
      options.softOffScreenRatio ?? BEHAVIOR_DEFAULTS.SOFT_OFF_SCREEN_RATIO;
    this.hardContinuousMs =
      options.hardContinuousMs ?? BEHAVIOR_DEFAULTS.HARD_CONTINUOUS_MS;
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

  /**
   * @param {import('./types.js').GazeFrameResult} frame
   * @returns {Promise<import('./types.js').GazeCheatEvent|null>}
   */
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
    if (continuousMs >= this.hardContinuousMs) {
      flagType = 'HARD_FLAG';
    } else if (offRatio >= this.softOffScreenRatio && this._frames.length >= 8) {
      flagType = 'SOFT_FLAG';
    }

    if (!flagType) return null;
    if (now - this._lastFlagAt < this.flagDebounceMs) return null;
    if (this._activeFlag === flagType) return null;

    this._lastFlagAt = now;
    this._activeFlag = flagType;

    const direction = dominantDirection(offFrames);
    /** @type {import('./types.js').GazeCheatEvent} */
    const event = {
      eventType: flagType,
      timestamp: new Date(now).toISOString(),
      sessionId: this.sessionId,
      durationMs: continuousMs,
      gazeDirection: direction,
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
