/**
 * @typedef {'SOFT_FLAG'|'HARD_FLAG'} GazeFlagType
 * @typedef {'down'|'left'|'right'|'center'} GazeDirection
 *
 * @typedef {Object} GazeRatio
 * @property {number} x Horizontal iris ratio (0 = far left, 1 = far right, 0.5 = center)
 * @property {number} y Vertical iris ratio (0 = top, 1 = bottom, 0.5 = center)
 *
 * @typedef {Object} HeadPose
 * @property {number} yaw Signed yaw in degrees (positive = right)
 * @property {number} pitch Signed pitch in degrees (positive = looking down)
 *
 * @typedef {Object} GazeFrameResult
 * @property {boolean} valid
 * @property {GazeRatio} gazeRatio
 * @property {HeadPose} headPose
 * @property {boolean} onScreen
 * @property {GazeDirection} direction
 * @property {number} timestamp
 *
 * @typedef {Object} GazeCheatEvent
 * @property {GazeFlagType} eventType
 * @property {string} timestamp ISO-8601
 * @property {string} sessionId
 * @property {number} durationMs
 * @property {GazeDirection} gazeDirection
 * @property {GazeRatio} averageGazeRatio
 * @property {number} headPitch
 * @property {number} headYaw
 * @property {string} [screenshotBase64]
 */

export const LANDMARKS = Object.freeze({
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
});

/** Screen-gazing zone (normalized iris ratios). */
export const GAZE_ZONE = Object.freeze({
  H_MIN: 0.3,
  H_MAX: 0.7,
  V_MIN: 0.25,
  V_MAX: 0.75,
  DOWN_Y: 0.72,
  LEFT_X: 0.25,
  RIGHT_X: 0.75,
});

export const HEAD_POSE_LIMITS = Object.freeze({
  PITCH_DOWN_DEG: 20,
  YAW_SIDE_DEG: 30,
});

export const BEHAVIOR_DEFAULTS = Object.freeze({
  WINDOW_MS: 3000,
  TARGET_FPS: 15,
  SOFT_OFF_SCREEN_RATIO: 0.6,
  HARD_CONTINUOUS_MS: 5000,
  FLAG_DEBOUNCE_MS: 10_000,
});
