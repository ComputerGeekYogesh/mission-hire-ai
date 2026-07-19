import {
  GAZE_ZONE,
  HEAD_POSE_LIMITS,
  LANDMARKS,
  type GazeCalibrationBaseline,
  type GazeDirection,
  type GazeFrameResult,
  type GazeRatio,
  type HeadPose,
  type MediaPipeLandmark,
} from './types';

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function lm(landmarks: MediaPipeLandmark[] | undefined, idx: number): MediaPipeLandmark | null {
  return landmarks?.[idx] ?? null;
}

function eyeGazeRatio(
  inner: MediaPipeLandmark | null,
  outer: MediaPipeLandmark | null,
  top: MediaPipeLandmark | null,
  bottom: MediaPipeLandmark | null,
  iris: MediaPipeLandmark | null
): GazeRatio | null {
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

export function estimateHeadPose(landmarks: MediaPipeLandmark[]): HeadPose {
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

function applyCalibration(ratio: GazeRatio, calibration: GazeCalibrationBaseline | null): GazeRatio {
  if (!calibration?.center) return ratio;
  const cx = calibration.center.x ?? 0.5;
  const cy = calibration.center.y ?? 0.5;
  return { x: clamp01(0.5 + (ratio.x - cx)), y: clamp01(0.5 + (ratio.y - cy)) };
}

function classifyDirection(ratio: GazeRatio, headPose: HeadPose): GazeDirection {
  const pitchDown = headPose.valid && headPose.pitch >= HEAD_POSE_LIMITS.PITCH_DOWN_DEG;
  const yawSide = headPose.valid && Math.abs(headPose.yaw) >= HEAD_POSE_LIMITS.YAW_SIDE_DEG;

  if (ratio.y > GAZE_ZONE.DOWN_Y || pitchDown) return 'down';
  if (ratio.x < GAZE_ZONE.LEFT_X || (yawSide && headPose.yaw < 0)) return 'left';
  if (ratio.x > GAZE_ZONE.RIGHT_X || (yawSide && headPose.yaw > 0)) return 'right';

  const onScreen =
    ratio.x >= GAZE_ZONE.H_MIN &&
    ratio.x <= GAZE_ZONE.H_MAX &&
    ratio.y >= GAZE_ZONE.V_MIN &&
    ratio.y <= GAZE_ZONE.V_MAX &&
    !pitchDown &&
    !yawSide;

  return onScreen ? 'center' : 'down';
}

export interface GazeTrackerOptions {
  calibration?: GazeCalibrationBaseline | null;
}

export class GazeTracker {
  private calibration: GazeCalibrationBaseline | null;
  private _lastFrame: GazeFrameResult | null = null;

  constructor(options: GazeTrackerOptions = {}) {
    this.calibration = options.calibration ?? null;
  }

  setCalibration(calibration: GazeCalibrationBaseline | null): void {
    this.calibration = calibration;
  }

  analyzeLandmarks(landmarks: MediaPipeLandmark[]): GazeFrameResult {
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

    let gazeRatio: GazeRatio = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
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

  getLastFrame(): GazeFrameResult | null {
    return this._lastFrame;
  }
}
