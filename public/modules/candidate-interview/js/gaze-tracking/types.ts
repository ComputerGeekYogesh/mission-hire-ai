export type GazeFlagType = 'SOFT_FLAG' | 'HARD_FLAG';
export type GazeDirection = 'down' | 'left' | 'right' | 'center';

export interface GazeRatio {
  x: number;
  y: number;
}

export interface HeadPose {
  yaw: number;
  pitch: number;
  valid: boolean;
}

export interface GazeFrameResult {
  valid: boolean;
  gazeRatio?: GazeRatio;
  headPose?: HeadPose;
  onScreen?: boolean;
  direction?: GazeDirection;
  timestamp: number;
}

export interface GazeCheatEvent {
  eventType: GazeFlagType;
  timestamp: string;
  sessionId: string;
  durationMs: number;
  gazeDirection: Exclude<GazeDirection, 'center'>;
  averageGazeRatio: GazeRatio;
  headPitch: number;
  headYaw: number;
  screenshotBase64?: string;
}

export interface GazeCalibrationBaseline {
  center: GazeRatio;
  points: Record<string, GazeRatio>;
}

export interface MediaPipeLandmark {
  x: number;
  y: number;
  z?: number;
}

export const LANDMARKS = {
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
} as const;

export const GAZE_ZONE = {
  H_MIN: 0.3,
  H_MAX: 0.7,
  V_MIN: 0.25,
  V_MAX: 0.75,
  DOWN_Y: 0.72,
  LEFT_X: 0.25,
  RIGHT_X: 0.75,
} as const;

export const HEAD_POSE_LIMITS = {
  PITCH_DOWN_DEG: 20,
  YAW_SIDE_DEG: 30,
} as const;

export const BEHAVIOR_DEFAULTS = {
  WINDOW_MS: 3000,
  TARGET_FPS: 15,
  SOFT_OFF_SCREEN_RATIO: 0.6,
  HARD_CONTINUOUS_MS: 5000,
  FLAG_DEBOUNCE_MS: 10_000,
} as const;
