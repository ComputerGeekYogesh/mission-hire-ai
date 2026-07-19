import express from 'express';
import protectRoute from '../../middlewares/protectRoute.js';
import { attachPermissions } from '../../middlewares/attachPermissions.js';
import { canHelper } from '../../middlewares/canHelper.js';
import { interviewRateLimit } from './middleware/rate-limit.middleware.js';
import { loadInterviewSession, loadInterviewSessionForRecording } from './middleware/validate-session.middleware.js';
import {
  createSnapshotUpload,
  createRecordingUpload,
  createAnswerUpload,
  handleMulterUpload,
} from './middleware/upload.middleware.js';
import { interviewErrorHandler } from './middleware/error-handler.middleware.js';
import { ensureRecordingMetadataTable } from './services/recording-metadata-migration.service.js';
import { ensureSessionStatusEnum } from './services/session-status-migration.service.js';
import { adminInterviewController } from './controllers/admin.controller.js';
import { candidateInterviewController } from './controllers/candidate.controller.js';
import { interviewChatController } from './controllers/interview-chat.controller.js';

const router = express.Router();

void ensureRecordingMetadataTable().catch((err) => {
  console.error('[recording-disk] Startup metadata table ensure failed:', err.message);
});

void ensureSessionStatusEnum().catch((err) => {
  console.error('[session-status-migration] Startup status ENUM ensure failed:', err.message);
});

router.use(attachPermissions);
router.use(canHelper);

/* ─── Admin: Candidate Interview Management ─── */
const admin = express.Router();
admin.use(protectRoute);

admin.get('/', (req, res) => res.redirect('/admin/interviews/dashboard'));
admin.get('/dashboard', adminInterviewController.dashboard);
admin.get('/scheduled', adminInterviewController.scheduled);
admin.get('/active', adminInterviewController.active);
admin.get('/recordings', adminInterviewController.recordings);
admin.get('/verification-logs', adminInterviewController.verificationLogs);
admin.get('/flags', adminInterviewController.flags);
admin.get('/flags/:flagId/back', (req, res) => res.redirect('/admin/interviews/flags'));
admin.get('/telemetry', adminInterviewController.telemetry);
admin.get('/analytics', adminInterviewController.analytics);
admin.get('/schedule', interviewChatController.scheduleChatPage);
admin.get('/schedule-form', adminInterviewController.scheduleForm);
admin.post('/schedule-form', adminInterviewController.scheduleSubmit);
admin.get('/schedule-chat', (req, res) => res.redirect('/admin/interviews/schedule'));
admin.get('/schedule/history', interviewChatController.history);
admin.post('/schedule/message', interviewChatController.message);
admin.post('/schedule/reset', interviewChatController.reset);
admin.get('/session/:id', adminInterviewController.sessionDetail);
admin.post('/session/:id/resend-invite', adminInterviewController.resendInvite);
admin.post('/session/:id/cancel', adminInterviewController.cancelSession);
admin.post('/session/:id/complete', adminInterviewController.completeSessionAdmin);
admin.post('/session/:id/summary/regenerate', adminInterviewController.regenerateSummary);
admin.post('/flags/:flagId/resolve', adminInterviewController.resolveFlag);
admin.get('/recordings/:recordingId/play', adminInterviewController.playRecording);
admin.get('/recordings/:recordingId/download', adminInterviewController.downloadRecording);
admin.post('/recording/remerge/:session_id', adminInterviewController.remergeRecording);
admin.post('/session/:id/remerge-recording', adminInterviewController.remergeRecording);
admin.post('/session/:id/retry-webhook', adminInterviewController.retryWebhook);
admin.get('/session/:id/snapshot/:snapId', adminInterviewController.serveSnapshot);
admin.get('/session/:id/summary/export', adminInterviewController.exportSummary);

router.use('/admin/interviews', admin);

/* Signed public stream for webhook / external consumers */
router.get(
  '/interview/recording-media/session/:sessionId',
  interviewRateLimit,
  candidateInterviewController.streamRecordingMedia
);
router.get(
  '/interview/recording-media/:recordingId',
  interviewRateLimit,
  candidateInterviewController.streamRecordingMedia
);

/* ─── Candidate public flow ─── */
const candidate = express.Router({ mergeParams: true });
candidate.use(interviewRateLimit);

candidate.get('/:token', loadInterviewSession, candidateInterviewController.gatePage);
candidate.post('/:token/otp/send', loadInterviewSession, candidateInterviewController.requestOtp);
candidate.post('/:token/otp/verify', loadInterviewSession, candidateInterviewController.verifyOtp);
candidate.get('/:token/preflight', loadInterviewSession, candidateInterviewController.preflightPage);
candidate.post('/:token/preflight/complete', loadInterviewSession, candidateInterviewController.completePreflight);
candidate.post('/:token/prepare-session', loadInterviewSession, candidateInterviewController.prepareSession);
candidate.post('/:token/tts', loadInterviewSession, candidateInterviewController.synthesizeSpeech);
candidate.get('/:token/room', loadInterviewSession, candidateInterviewController.roomPage);
candidate.get('/:token/status', loadInterviewSession, candidateInterviewController.sessionStatus);
candidate.get(
  '/:token/connectivity/ping',
  loadInterviewSession,
  candidateInterviewController.connectivityPing
);

candidate.post(
  '/:token/snapshot',
  loadInterviewSession,
  (req, res, next) =>
    handleMulterUpload(createSnapshotUpload(req.params.token).single('snapshot'))(req, res, next),
  candidateInterviewController.uploadSnapshot
);

candidate.post('/:token/telemetry', loadInterviewSession, candidateInterviewController.postTelemetry);
candidate.post('/:token/start', loadInterviewSession, candidateInterviewController.startInterview);
candidate.get('/:token/call/state', loadInterviewSession, candidateInterviewController.getCallState);
candidate.post(
  '/:token/call/answer',
  loadInterviewSession,
  (req, res, next) =>
    handleMulterUpload(createAnswerUpload(req.params.token).single('answer_audio'))(req, res, next),
  candidateInterviewController.submitAnswer
);
candidate.post(
  '/:token/call/classify-input',
  loadInterviewSession,
  candidateInterviewController.classifyCandidateInput
);
candidate.post(
  '/:token/call/question-dispatched',
  loadInterviewSession,
  candidateInterviewController.logQuestionDispatched
);
candidate.post(
  '/:token/call/silence-prompt',
  loadInterviewSession,
  candidateInterviewController.silencePrompt
);
candidate.post(
  '/:token/call/confirm-intent',
  loadInterviewSession,
  candidateInterviewController.classifyConfirmIntent
);
candidate.post(
  '/:token/call/repeat-question',
  loadInterviewSession,
  candidateInterviewController.repeatQuestion
);
candidate.post(
  '/:token/call/detect-repeat-intent',
  loadInterviewSession,
  candidateInterviewController.detectRepeatIntent
);
candidate.post('/:token/suspicious', loadInterviewSession, candidateInterviewController.logSuspicious);
candidate.post('/:token/integrity/heartbeat', loadInterviewSession, candidateInterviewController.postIntegrityHeartbeat);
candidate.post('/:token/integrity/signals', loadInterviewSession, candidateInterviewController.postIntegritySignals);
candidate.get('/:token/integrity/timeline', loadInterviewSession, candidateInterviewController.getIntegrityTimeline);
candidate.get('/:token/proctoring/state', loadInterviewSession, candidateInterviewController.getProctoringState);
candidate.post('/:token/flow-debug', loadInterviewSession, candidateInterviewController.flowDebugLog);
candidate.post('/:token/headphones', loadInterviewSession, candidateInterviewController.reportHeadphones);

candidate.post(
  '/:token/recording',
  loadInterviewSessionForRecording,
  (req, res, next) =>
    handleMulterUpload(createRecordingUpload(req.params.token).single('recording'))(req, res, next),
  candidateInterviewController.uploadRecording
);

candidate.post(
  '/:token/recording/end',
  loadInterviewSessionForRecording,
  candidateInterviewController.endRecording
);

candidate.post('/:token/end', loadInterviewSessionForRecording, candidateInterviewController.endInterview);

router.use('/interview', candidate);
router.use(interviewErrorHandler);

export default router;
