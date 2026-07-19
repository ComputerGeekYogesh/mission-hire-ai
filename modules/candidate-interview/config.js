import path from 'path';
import { fileURLToPath } from 'url';
import { getInterviewTokenSecret, getRecordingSignedUrlSecret } from '../../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const interviewConfig = {
  tokenSecret: getInterviewTokenSecret(),
  tokenTtlHours: Number(process.env.INTERVIEW_TOKEN_TTL_HOURS || 72),
  otpTtlMinutes: Number(process.env.INTERVIEW_OTP_TTL_MINUTES || 10),
  snapshotIntervalMs: Number(process.env.INTERVIEW_SNAPSHOT_INTERVAL_MS || 15000),
  telemetryIntervalMs: Number(process.env.INTERVIEW_TELEMETRY_INTERVAL_MS || 3000),
  maxUploadBytes: Number(process.env.INTERVIEW_MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
  rateLimitWindowMs: Number(process.env.INTERVIEW_RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMax: Number(process.env.INTERVIEW_RATE_LIMIT_MAX || 120),
  uploadsRoot: path.resolve(process.cwd(), 'uploads', 'interview-gate'),
  /** Disk root for session recordings — override with RECORDINGS_BASE_PATH */
  recordingsBasePath: path.resolve(
    process.cwd(),
    process.env.RECORDINGS_BASE_PATH || 'uploads/interview-recordings'
  ),
  /** Legacy alias — same as recordingsBasePath */
  recordingsRoot: path.resolve(
    process.cwd(),
    process.env.RECORDINGS_BASE_PATH || 'uploads/interview-recordings'
  ),
  recordingSignedUrlSecret: getRecordingSignedUrlSecret(),
  recordingSignedUrlExpirySeconds: Number(process.env.RECORDING_SIGNED_URL_EXPIRY_SECONDS || 86400),
  recordingMergeDelayMs: Number(process.env.RECORDING_MERGE_DELAY_MS || 15000),
  /** Wait for POST /recording/end to set total_chunks_expected before merging */
  recordingExpectationWaitMs: Number(process.env.RECORDING_EXPECTATION_WAIT_MS || 30000),
  recordingChunkWaitMs: Number(process.env.RECORDING_CHUNK_WAIT_MS || 60000),
  recordingChunkPollMs: Number(process.env.RECORDING_CHUNK_POLL_MS || 2000),
  /** Extra wait for deferred merge retry when chunks are still missing at finalize */
  recordingDeferredMergeWaitMs: Number(process.env.RECORDING_DEFERRED_MERGE_WAIT_MS || 45000),
  /** Skip merge (keep pending) when more than this fraction of chunks are missing */
  recordingMaxMissingMergeRatio: Number(process.env.RECORDING_MAX_MISSING_MERGE_RATIO || 0.2),
  recordingMinMergeSizeRatio: Number(process.env.RECORDING_MIN_MERGE_SIZE_RATIO || 0.8),
  /** Delete chunk_*.webm files after a verified successful merge (default: true) */
  recordingCleanupChunksAfterMerge: process.env.RECORDING_CLEANUP_CHUNKS_AFTER_MERGE !== 'false',
  /** Answer audio transcription (Whisper) — authoritative for scoring when audio is present */
  answerTranscriptionModel: process.env.ANSWER_TRANSCRIPTION_MODEL || 'whisper-1',
  answerTranscriptionLanguage: process.env.ANSWER_TRANSCRIPTION_LANGUAGE || 'en',
  answerTranscriptionMinBytes: Number(process.env.ANSWER_TRANSCRIPTION_MIN_BYTES || 800),
  answerTranscriptionMinChars: Number(process.env.ANSWER_TRANSCRIPTION_MIN_CHARS || 8),
  answerTranscriptionClientFallbackMinChars: Number(
    process.env.ANSWER_TRANSCRIPTION_CLIENT_FALLBACK_MIN_CHARS || 10
  ),
  answerTranscriptionRetries: Number(process.env.ANSWER_TRANSCRIPTION_RETRIES || 2),
  answerTranscriptionRetryDelayMs: Number(process.env.ANSWER_TRANSCRIPTION_RETRY_DELAY_MS || 600),
  suspiciousYawThreshold: Number(process.env.INTERVIEW_SUSPICIOUS_YAW || 55),
  suspiciousPitchThreshold: Number(process.env.INTERVIEW_SUSPICIOUS_PITCH || 45),
  faceAbsentSecondsThreshold: Number(process.env.INTERVIEW_FACE_ABSENT_SEC || 18),
  headMovementSustainCount: Number(process.env.INTERVIEW_HEAD_SUSTAIN_COUNT || 1),
  recordingChunkMs: Number(process.env.INTERVIEW_RECORDING_CHUNK_MS || 5000),
  /** Max times a candidate may request the same question be rephrased and replayed */
  maxQuestionRepeatRequests: Number(process.env.INTERVIEW_MAX_QUESTION_REPEATS || 3),
  /** Proctoring risk score thresholds */
  proctoringWarnScore: Number(process.env.INTERVIEW_PROCTORING_WARN_SCORE || 5),
  proctoringTerminateScore: Number(process.env.INTERVIEW_PROCTORING_TERMINATE_SCORE || 10),
  /** Suspicious-activity strike that shows the final warning (default: 4th detection). */
  proctoringFinalWarningStrike: Number(process.env.INTERVIEW_PROCTORING_FINAL_WARNING_STRIKE || 4),
  /** Suspicious-activity strike that terminates the assessment (default: 5th detection). */
  proctoringTerminationStrike: Number(process.env.INTERVIEW_PROCTORING_TERMINATION_STRIKE || 5),
  /** Minor violations (score 2) stop counting toward risk after this cooldown */
  proctoringMinorViolationCooldownMs: Number(
    process.env.INTERVIEW_PROCTORING_MINOR_COOLDOWN_MS || 120_000
  ),
  /** Movement score above this triggers excessive eye movement flag (legacy path) */
  proctoringEyeMovementThreshold: Number(process.env.INTERVIEW_PROCTORING_EYE_MOVEMENT || 70),
  /** Head rotation thresholds for legacy telemetry path (degrees) */
  faceRotationYawThreshold: Number(process.env.INTERVIEW_FACE_ROTATION_YAW || 28),
  faceRotationPitchThreshold: Number(process.env.INTERVIEW_FACE_ROTATION_PITCH || 32),
  /** Consecutive off-angle telemetry ticks before FACE_ROTATION flag */
  faceRotationSustainCount: Number(process.env.INTERVIEW_FACE_ROTATION_SUSTAIN_COUNT || 5),
  /** Attention / hidden-device monitoring thresholds */
  attentionWindowSec: Number(process.env.INTERVIEW_ATTENTION_WINDOW_SEC || 12),
  /** Sustained seconds before gaze/head off-screen flags fire */
  attentionSustainedSec: Number(process.env.INTERVIEW_ATTENTION_SUSTAINED_SEC || 5),
  /** Min client samples in window before server evaluates (800ms poll ≈ 15 samples in 12s) */
  attentionMinSamples: Number(process.env.INTERVIEW_ATTENTION_MIN_SAMPLES || 8),
  /** Flag when off-screen gaze moves exceed this count in rolling window */
  attentionGazeMovesMax: Number(process.env.INTERVIEW_ATTENTION_GAZE_MOVES_MAX || 10),
  /** Flag when head turns exceed this count in rolling window */
  attentionHeadTurnsMax: Number(process.env.INTERVIEW_ATTENTION_HEAD_TURNS_MAX || 7),
  /** Flag when % of gaze samples off-screen in window exceeds this */
  attentionGazeOffScreenPct: Number(process.env.INTERVIEW_ATTENTION_GAZE_OFF_PCT || 78),
  /** Flag when head away for more than this % during an answer */
  attentionHeadOffScreenPct: Number(process.env.INTERVIEW_ATTENTION_HEAD_OFF_PCT || 55),
  /** Flag when gaze away for more than this % during an answer */
  attentionAnswerGazeOffPct: Number(process.env.INTERVIEW_ATTENTION_ANSWER_GAZE_OFF_PCT || 72),
  /** Repeated pre-speech glances before flagging pattern */
  attentionPreSpeechGlanceCount: Number(process.env.INTERVIEW_ATTENTION_PRE_SPEECH_COUNT || 4),
  /** Consecutive telemetry ticks a rule must hold before raising a flag */
  attentionConsecutiveTicks: Number(process.env.INTERVIEW_ATTENTION_CONSECUTIVE_TICKS || 3),
  /** Minimum computed confidence (0–100) before an attention flag fires */
  attentionConfidenceThreshold: Number(process.env.INTERVIEW_ATTENTION_CONFIDENCE_THRESHOLD || 62),
  attentionCorrelationWindowMs: Number(process.env.INTERVIEW_ATTENTION_CORRELATION_MS || 90_000),
  /** Coalesce blur + tab_switch double-fire; separate focus losses after this window count as new strikes */
  focusViolationDedupeMs: Number(process.env.INTERVIEW_FOCUS_VIOLATION_DEDUPE_MS || 4000),
  webcamObstructionMinConfidence: Number(process.env.INTERVIEW_WEBCAM_OBSTRUCTION_MIN_CONFIDENCE || 62),
  webcamObstructionMinStreak: Number(process.env.INTERVIEW_WEBCAM_OBSTRUCTION_MIN_STREAK || 4),
  /** Enterprise integrity engine */
  integrityHeartbeatIntervalMs: Number(process.env.INTERVIEW_INTEGRITY_HEARTBEAT_MS || 5000),
  integrityHeartbeatMissThreshold: Number(process.env.INTERVIEW_INTEGRITY_HEARTBEAT_MISSES || 3),
  integritySilentSignalWindowMs: Number(process.env.INTERVIEW_INTEGRITY_SIGNAL_WINDOW_MS || 120_000),
  integrityEscalationScore: Number(process.env.INTERVIEW_INTEGRITY_ESCALATION_SCORE || 18),
  integrityCriticalScore: Number(process.env.INTERVIEW_INTEGRITY_CRITICAL_SCORE || 28),
  /** Blink/motion/frozen-frame liveness checks (disabled by default — high false-positive rate). */
  livenessDetectionEnabled:
    String(process.env.INTERVIEW_LIVENESS_DETECTION_ENABLED || 'false').trim().toLowerCase() ===
    'true',
  livenessMinConfidence: Number(process.env.INTERVIEW_LIVENESS_MIN_CONFIDENCE || 65),
  livenessStreakRequired: Number(process.env.INTERVIEW_LIVENESS_STREAK_REQUIRED || 4),
  identityDriftMinConfidence: Number(process.env.INTERVIEW_IDENTITY_DRIFT_MIN_CONFIDENCE || 68),
  identityDriftStreakRequired: Number(process.env.INTERVIEW_IDENTITY_DRIFT_STREAK || 3),
  virtualCameraMinConfidence: Number(process.env.INTERVIEW_VIRTUAL_CAMERA_MIN_CONFIDENCE || 75),
  voiceCoachingMinConfidence: Number(process.env.INTERVIEW_VOICE_COACHING_MIN_CONFIDENCE || 62),
  voiceCoachingStreakRequired: Number(process.env.INTERVIEW_VOICE_COACHING_STREAK || 4),
  moduleRoot: __dirname,
};

/** @deprecated MySQL blob storage removed — recordings are disk-only */
export function isMysqlBlobRecordingStorage() {
  return false;
}
