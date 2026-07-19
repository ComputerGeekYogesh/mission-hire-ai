import express from 'express';
import apiController from '../controllers/apiController.js';
import authenticateRoute from '../middlewares/authenticateRoute.js';
import { scheduleVideoInterview } from '../modules/candidate-interview/controllers/schedule-video-api.controller.js';
import { portalEventsReceiverController } from '../modules/candidate-interview/controllers/portal-events-receiver.controller.js';
import apiBearerAuth from '../modules/candidate-interview/middleware/api-bearer-auth.middleware.js';

const router = express.Router();

/** Lightweight latency probe for interview network monitor (no auth). */
router.head('/ping', (_req, res) => res.sendStatus(204));
router.get('/ping', (_req, res) => res.status(200).json({ ok: true }));

router.post('/check-email', authenticateRoute, apiController.checkEmail);
router.post('/save-otp', authenticateRoute, apiController.saveOtp);
router.post('/verify-otp', authenticateRoute, apiController.verifyOtp);
router.get('/dashboard', authenticateRoute, apiController.getDashboard);
router.get('/users', authenticateRoute, apiController.fetchUsers);
router.get('/jobs', authenticateRoute, apiController.fetchJobs);
router.get('/candidates', authenticateRoute, apiController.fetchCandidates);
router.get('/v1/getAgentFeedback', authenticateRoute, apiController.fetchUserFeedback);
router.post('/v1/getAgentFeedback/:id', authenticateRoute, apiController.fetchUserFeedbackById);
router.get('/v1/user-call-summary', apiController.fetchUnifiedUserCallSummary);
router.post('/v1/schedule/video-interview', apiBearerAuth, scheduleVideoInterview);
router.post('/v1/assessment/portal-events', portalEventsReceiverController.receive);

/** Legacy phone call API — telephony removed; use browser video scheduling instead. */
router.post('/call', authenticateRoute, apiController.initiateCallDisabled);

export default router;
