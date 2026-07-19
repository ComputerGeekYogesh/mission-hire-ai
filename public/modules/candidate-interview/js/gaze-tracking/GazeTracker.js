import {
  LANDMARKS,
  GAZE_ZONE,
  HEAD_POSE_LIMITS,
} from './types.js';

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function lm(landmarks, idx) {
  return landmarks?.[idx] || null;
}

/**
 * Compute horizontal + vertical iris ratio for one eye (0–1).
 */
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
    const height = maxY - minY || 0.001;
    vRatio = (iris.y - minY) / height;
  }

  return { x: clamp01(hRatio), y: clamp01(vRatio) };
}

/**
 * Head pose from 6 stable landmarks (2D heuristic).
 */
export function estimateHeadPose(landmarks) {
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

  return {
    yaw: Number(yaw.toFixed(2)),
    pitch: Number(pitch.toFixed(2)),
    valid: true,
  };
}

function applyCalibration(ratio, calibration) {
  if (!calibration?.center) return ratio;
  const cx = calibration.center.x ?? 0.5;
  const cy = calibration.center.y ?? 0.5;
  return {
    x: clamp01(0.5 + (ratio.x - cx)),
    y: clamp01(0.5 + (ratio.y - cy)),
  };
}

function classifyDirection(ratio, headPose) {
  const yawSide =
    headPose.valid && Math.abs(headPose.yaw) >= HEAD_POSE_LIMITS.YAW_SIDE_DEG;

  if (ratio.x < GAZE_ZONE.LEFT_X || (yawSide && headPose.yaw < 0)) return 'left';
  if (ratio.x > GAZE_ZONE.RIGHT_X || (yawSide && headPose.yaw > 0)) return 'right';

  return 'center';
}

export class GazeTracker {
  /**
   * @param {{ calibration?: { center?: { x: number, y: number } } }} [options]
   */
  constructor(options = {}) {
    this.calibration = options.calibration || null;
    this._lastFrame = null;
  }

  setCalibration(calibration) {
    this.calibration = calibration;
  }

  /**
   * @param {Array<{x:number,y:number,z?:number}>} landmarks MediaPipe FaceMesh landmarks
   * @returns {import('./types.js').GazeFrameResult}
   */
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

    let gazeRatio = {
      x: (left.x + right.x) / 2,
      y: (left.y + right.y) / 2,
    };
    gazeRatio = applyCalibration(gazeRatio, this.calibration);

    const headPose = estimateHeadPose(landmarks);
    const direction = classifyDirection(gazeRatio, headPose);
    const onScreen = direction === 'center';

    this._lastFrame = {
      valid: true,
      gazeRatio,
      headPose,
      onScreen,
      direction,
      timestamp: now,
    };

    return this._lastFrame;
  }

  getLastFrame() {
    return this._lastFrame;
  }
}

/**
 * Minimal webcam + FaceMesh loop for debugging gaze ratios in console.
 */
export class AssessmentCamera {
  /**
   * @param {HTMLVideoElement} videoEl
   * @param {{ debug?: boolean, onFrame?: (frame: import('./types.js').GazeFrameResult) => void }} [options]
   */
  constructor(videoEl, options = {}) {
    this.video = videoEl;
    this.tracker = new GazeTracker({ calibration: options.calibration });
    this.debug = options.debug !== false;
    this.onFrame = options.onFrame || null;
    this.faceMesh = null;
    this.running = false;
    this._stream = null;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia not supported');
    }
    this._stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this._stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();

    if (typeof FaceMesh === 'undefined') {
      throw new Error('MediaPipe FaceMesh not loaded');
    }

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
      if (!landmarks) return;
      const frame = this.tracker.analyzeLandmarks(landmarks);
      if (this.debug) {
        console.log('[GazeTracker]', {
          ratio: frame.gazeRatio,
          onScreen: frame.onScreen,
          direction: frame.direction,
          head: frame.headPose,
        });
      }
      this.onFrame?.(frame);
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
    this._stream = null;
    this.faceMesh?.close?.();
    this.faceMesh = null;
  }
}
