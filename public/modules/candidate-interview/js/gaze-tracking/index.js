import { GazeTracker } from './GazeTracker.js';
import { BehaviorAnalyzer } from './BehaviorAnalyzer.js';
import { GazeCalibration } from './GazeCalibration.js';

export { LANDMARKS, GAZE_ZONE, HEAD_POSE_LIMITS, BEHAVIOR_DEFAULTS } from './types.js';
export { GazeTracker, AssessmentCamera } from './GazeTracker.js';
export { estimateHeadPose } from './GazeTracker.js';
export { BehaviorAnalyzer } from './BehaviorAnalyzer.js';
export { GazeCalibration } from './GazeCalibration.js';

/**
 * Orchestrates gaze tracking + behavior analysis for proctoring integration.
 */
export class GazeCheatDetector {
  /**
   * @param {{
   *   sessionId?: string,
   *   onFlag?: (event: import('./types.js').GazeCheatEvent) => void,
   *   videoEl?: HTMLVideoElement,
   *   calibration?: object,
   *   behaviorOptions?: object,
   *   debug?: boolean,
   * }} options
   */
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
    this._processing = false;
  }

  setSessionId(id) {
    this.sessionId = id || '';
    this.analyzer.sessionId = this.sessionId;
  }

  setVideoElement(videoEl) {
    this.videoEl = videoEl || null;
  }

  applyCalibration(calibration) {
    this.tracker.setCalibration(calibration);
  }

  /**
   * Process one FaceMesh landmark set (call from existing face mesh loop).
   * @param {Array<{x:number,y:number}>} landmarks
   */
  async processLandmarks(landmarks) {
    if (this._processing || !landmarks?.length) return null;
    this._processing = true;
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
        console.log('[GazeCheatDetector]', {
          ratio: frame.gazeRatio,
          direction: frame.direction,
          onScreen: frame.onScreen,
          head: frame.headPose,
        });
      }

      const event = await this.analyzer.pushFrame(frame);
      if (event && this.onFlag) this.onFlag(event);
      return event;
    } finally {
      this._processing = false;
    }
  }

  buildTelemetrySnapshot() {
    return this.analyzer.buildTelemetrySnapshot();
  }

  getCalibrationProgress() {
    return this.calibration?.progress || { complete: true };
  }

  getCurrentCalibrationPrompt() {
    return this.calibration?.currentStep?.label || null;
  }

  reset() {
    this.analyzer.reset();
    this.calibration?.reset?.();
  }

  /** Capture single JPEG frame from video (HARD_FLAG evidence). */
  captureScreenshot() {
    const video = this.videoEl;
    if (!video?.videoWidth || video.readyState < 2) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.min(640, video.videoWidth);
    canvas.height = Math.round((canvas.width / video.videoWidth) * video.videoHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    const base64 = dataUrl.split(',')[1] || null;
    return base64;
  }
}

export function createDetector(options) {
  return new GazeCheatDetector(options);
}

if (typeof window !== 'undefined') {
  window.GazeTracking = {
    GazeTracker,
    BehaviorAnalyzer,
    GazeCalibration,
    GazeCheatDetector,
    AssessmentCamera,
    createDetector,
  };
}
