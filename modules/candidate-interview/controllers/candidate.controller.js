import moment from 'moment-timezone';
import path from 'path';
import { SESSION_STATUS, HEADPHONE_STATUS, FLAG_TYPES } from '../constants.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { snapshotRepository } from '../repositories/snapshot.repository.js';
import { verificationRepository } from '../repositories/verification.repository.js';
import { verifyOtp, generateOtp, hashOtp } from '../services/otp.service.js';
import { telemetryService } from '../services/telemetry.service.js';
import { orchestratorService } from '../services/orchestrator.service.js';
import { sessionService } from '../services/session.service.js';
import { recordingService } from '../services/recording.service.js';
import { recordingDebug } from '../services/recording-debug.service.js';
import { feedbackEmailDebug, feedbackEmailDebugError } from '../services/feedback-email-debug.service.js';
import { recordingChunkService } from '../services/recording-chunk.service.js';
import { ensureSessionStatusEnum } from '../services/session-status-migration.service.js';
import { interviewConfig } from '../config.js';
import { verifyRecordingMediaAccess } from '../services/recording-media-access.service.js';
import { recordingRepository } from '../repositories/recording.repository.js';
import { toStorageKey } from '../services/storage.service.js';
import { validateTelemetryPayload } from '../validators/telemetry.validator.js';
import { detectHeadphones, assertHeadphonesDetected } from '../services/headphone-detector.service.js';
import { questionRepository } from '../repositories/question.repository.js';
import { questionEngineService } from '../services/question-engine.service.js';
import { suspiciousService } from '../services/suspicious.service.js';
import { summaryService } from '../services/summary.service.js';
import { apiCompletionService } from '../services/api-completion.service.js';
import { callEngineService } from '../services/call-engine.service.js';
import { classifyConfirmationIntent } from '../services/intent-classification.service.js';
import { classifyCandidateInput } from '../services/assessment-intent.service.js';
import { assessmentResponseRouter } from '../services/assessment-response-router.service.js';
import { getInterviewAgentState, saveInterviewAgentState } from '../services/interview-agent-state.service.js';
import { assessmentLog } from '../services/assessment-interaction-log.service.js';
import { clearSessionResponses } from '../lib/assessment-responses.js';
import { questionRephraseService } from '../services/question-rephrase.service.js';
import { proctoringViolationService } from '../services/proctoring-violation.service.js';
import { proctorDebug, proctorDebugFlow } from '../services/proctoring-debug.service.js';
import { integrityService } from '../services/integrity.service.js';
import { integrityLog } from '../services/integrity-audit.service.js';
import { emitPortalEvent, PORTAL_EVENTS } from '../services/portal-events.service.js';
import {
  isInterviewVapiTtsEnabled,
  synthesizeInterviewSpeech,
} from '../services/interview-tts.service.js';
import { resolveSessionLabelsFromSession, resolveClientSessionLabelsFromSession } from '../lib/session-labels.js';

const ACTIVE_CALL_STATUSES = new Set([SESSION_STATUS.IN_PROGRESS, SESSION_STATUS.SUSPICIOUS]);

function clientMeta(req) {
  return {
    ip_address: req.ip,
    user_agent: req.get('user-agent'),
  };
}

export const candidateInterviewController = {
  async gatePage(req, res) {
    const session = req.interviewSession;
    res.render('modules/candidate-interview/candidate/gate', {
      title: 'Interview Verification',
      session,
      layout: false,
      verified: session.otp_verified === 1,
    });
  },

  async requestOtp(req, res) {
    const session = req.interviewSession;
    const otp = generateOtp();
    await sessionRepository.update(session.id, { otp_hash: hashOtp(otp) });

    const { sendOtpEmail } = await import('../../../mailer.js');
    await sendOtpEmail(session.candidate_email, otp, session.candidate_name);

    await verificationRepository.log({
      session_id: session.id,
      event_type: 'otp_sent',
      success: true,
      ...clientMeta(req),
    });

    emitPortalEvent(session, PORTAL_EVENTS.OTP_SENT, {
      occurred_at: new Date().toISOString(),
      delivery: 'email',
      candidate_email: session.candidate_email,
    });

    if (process.env.NODE_ENV !== 'production') {
      return res.json({ ok: true, dev_otp: otp });
    }
    return res.json({ ok: true });
  },

  async verifyOtp(req, res) {
    const session = req.interviewSession;
    const { otp } = req.body;
    const ok = verifyOtp(otp, session.otp_hash);

    await verificationRepository.log({
      session_id: session.id,
      event_type: 'otp_verify',
      success: ok,
      ...clientMeta(req),
    });

    if (!ok) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    await sessionRepository.update(session.id, {
      otp_verified: 1,
      otp_verified_at: moment().format('YYYY-MM-DD HH:mm:ss'),
      status: SESSION_STATUS.VERIFIED,
    });

    const verifiedSession = await sessionRepository.findById(session.id);
    emitPortalEvent(verifiedSession || session, PORTAL_EVENTS.OTP_VERIFIED, {
      occurred_at: new Date().toISOString(),
      otp_verified_at: verifiedSession?.otp_verified_at || moment().format('YYYY-MM-DD HH:mm:ss'),
    });

    return res.json({ ok: true, next: `/interview/${req.interviewToken}/preflight` });
  },

  async preflightPage(req, res) {
    const session = req.interviewSession;
    if (session.otp_verified !== 1) {
      return res.redirect(`/interview/${req.interviewToken}`);
    }
    res.render('modules/candidate-interview/candidate/preflight', {
      title: 'Device Check',
      session,
      token: req.interviewToken,
      vapiTtsEnabled: isInterviewVapiTtsEnabled(),
      layout: false,
    });
  },

  async completePreflight(req, res) {
    const session = req.interviewSession;
    if (session.otp_verified !== 1) {
      return res.status(403).json({ error: 'OTP not verified' });
    }

    const headphone = await detectHeadphones(req.body);
    try {
      assertHeadphonesDetected(headphone.status, headphone);
    } catch (e) {
      return res.status(e.status || 403).json({ error: e.message });
    }

    let meta = {};
    try {
      meta =
        typeof session.metadata_json === 'string'
          ? JSON.parse(session.metadata_json)
          : session.metadata_json || {};
    } catch {
      meta = {};
    }
    meta.headphone_device_label = headphone.device_label || req.body?.device_label || null;
    meta.headphone_device_id = req.body?.device_id || null;
    meta.headphones_detection_method = 'test_tone_confirmed';
    meta.headphones_test_tone_passed = true;
    if (typeof req.body?.face_signature === 'string' && req.body.face_signature.trim()) {
      meta.verified_face_signature = req.body.face_signature.trim();
    }

    await sessionRepository.update(session.id, {
      preflight_completed: 1,
      preflight_completed_at: moment().format('YYYY-MM-DD HH:mm:ss'),
      headphone_status: HEADPHONE_STATUS.DETECTED,
      status: SESSION_STATUS.PREFLIGHT_OK,
      metadata_json: meta,
    });

    await verificationRepository.log({
      session_id: session.id,
      event_type: 'preflight_complete',
      success: true,
      ...clientMeta(req),
      details_json: {
        camera: req.body?.camera,
        microphone: req.body?.microphone,
        face: req.body?.face,
        headphone_device_label: meta.headphone_device_label,
        headphone_device_id: meta.headphone_device_id,
        headphones_detection_method: meta.headphones_detection_method,
        verified_face_signature: meta.verified_face_signature || null,
      },
    });

    const fresh = await sessionRepository.findById(session.id);
    try {
      await callEngineService.prepareSessionQuestions(fresh);
    } catch (e) {
      console.warn('[preflight] prepare failed (room will retry):', e.message);
    }

    return res.json({ ok: true, next: `/interview/${req.interviewToken}/room` });
  },

  async prepareSession(req, res) {
    const session = req.interviewSession;
    if (session.otp_verified !== 1 || session.preflight_completed !== 1) {
      return res.status(403).json({ error: 'Complete verification and device checks first.' });
    }
    if (session.status === SESSION_STATUS.IN_PROGRESS) {
      const state = await questionEngineService.getCallState(session);
      return res.json({ ok: true, already_started: true, total_questions: state.total_questions });
    }
    try {
      const existingQuestions = await questionRepository.listBySession(session.id);
      if (existingQuestions.length > 0) {
        return res.json({
          ok: true,
          prepared: true,
          total_questions: existingQuestions.length,
          cached: true,
        });
      }
      const result = await callEngineService.prepareSessionQuestions(session);
      return res.json({
        ok: true,
        prepared: true,
        total_questions: result.totalQuestions,
      });
    } catch (e) {
      console.error('[prepareSession]', e.message);
      return res.status(e.status || 500).json({ error: e.message || 'Could not prepare session' });
    }
  },

  async roomPage(req, res) {
    const session = req.interviewSession;
    if (!sessionService.canStartInterview(session) && session.status !== SESSION_STATUS.IN_PROGRESS) {
      return res.redirect(`/interview/${req.interviewToken}/preflight`);
    }
    let verifiedFaceSignature = null;
    try {
      const meta =
        typeof session.metadata_json === 'string'
          ? JSON.parse(session.metadata_json)
          : session.metadata_json || {};
      verifiedFaceSignature = meta.verified_face_signature || null;
    } catch {
      verifiedFaceSignature = null;
    }
    res.render('modules/candidate-interview/candidate/room', {
      title: 'Interview Room',
      session,
      token: req.interviewToken,
      layout: false,
      verifiedFaceSignature,
      sessionLabels: resolveSessionLabelsFromSession(session),
      clientSessionLabels: resolveClientSessionLabelsFromSession(session),
      proctoring: {
        yawThreshold: interviewConfig.faceRotationYawThreshold,
        pitchThreshold: interviewConfig.faceRotationPitchThreshold,
        faceAbsentSec: interviewConfig.faceAbsentSecondsThreshold,
        headSustainCount: interviewConfig.faceRotationSustainCount,
        alertCooldownSec: 20,
        alertHideSec: 8,
        attentionWindowSec: interviewConfig.attentionWindowSec,
        attentionSustainedSec: interviewConfig.attentionSustainedSec,
        finalWarningStrike: interviewConfig.proctoringFinalWarningStrike,
        terminationStrike: interviewConfig.proctoringTerminationStrike,
      },
      vapiTtsEnabled: isInterviewVapiTtsEnabled(),
      recordingFinalOnly: false,
      recordingMaxBytes: interviewConfig.maxUploadBytes,
      recordingTraceEnabled:
        String(process.env.INTERVIEW_RECORDING_TRACE || 'false').trim().toLowerCase() === 'true',
    });
  },

  async streamRecordingMedia(req, res) {
    if (req.params.sessionId) {
      const sessionId = Number(req.params.sessionId);
      const relativeFile = req.query.file || 'full_recording.webm';
      try {
        await recordingService.streamSessionRecordingFile(sessionId, relativeFile, req, res);
      } catch (e) {
        console.warn('[streamRecordingMedia/session]', e.message);
        if (!res.headersSent) {
          res.status(e.status || 500).json({ error: e.message || 'Playback failed' });
        }
      }
      return;
    }

    const recordingId = Number(req.params.recordingId);
    const token = req.query.t;
    if (!recordingId) return res.status(400).json({ error: 'Invalid recording id' });

    const rec = await recordingRepository.findById(recordingId);
    if (!rec) return res.status(404).json({ error: 'Recording not found' });

    if (!verifyRecordingMediaAccess(recordingId, rec.session_id, token)) {
      return res.status(403).json({ error: 'Invalid or expired access token' });
    }

    try {
      await recordingService.streamRecordingForRequest(rec, req, res);
    } catch (e) {
      console.warn('[streamRecordingMedia]', e.message);
      if (!res.headersSent) {
        res.status(e.status || 500).json({ error: e.message || 'Playback failed' });
      }
    }
  },

  async synthesizeSpeech(req, res) {
    if (!isInterviewVapiTtsEnabled()) {
      return res.status(503).json({
        error: 'Vapi TTS is not configured on the server',
        fallback_browser: true,
      });
    }

    const text = req.body?.text;
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'text is required' });
    }

    try {
      const { buffer, contentType } = await synthesizeInterviewSpeech(String(text).trim());
      res.set('Content-Type', contentType || 'audio/mpeg');
      res.set('Cache-Control', 'private, max-age=300');
      return res.send(buffer);
    } catch (e) {
      console.warn('[InterviewTTS]', e.message);
      return res.status(503).json({
        error: e.message || 'Speech synthesis failed',
        fallback_browser: true,
      });
    }
  },

  async uploadSnapshot(req, res) {
    const session = req.interviewSession;
    if (!req.file) return res.status(400).json({ error: 'No snapshot uploaded' });

    const storageKey = toStorageKey(req.file.path);
    const id = await snapshotRepository.create({
      session_id: session.id,
      storage_key: storageKey,
      confidence_score: req.body.confidence ? Number(req.body.confidence) : null,
      face_count: req.body.face_count ? Number(req.body.face_count) : 1,
      captured_at: moment().format('YYYY-MM-DD HH:mm:ss'),
    });

    return res.json({ ok: true, id, storage_key: storageKey });
  },

  async postTelemetry(req, res) {
    const session = req.interviewSession;
    const payload = validateTelemetryPayload(req.body);
    suspiciousService.beginTelemetryIngest(session.id);
    let result;
    try {
      result = await telemetryService.ingest(session, payload);
    } finally {
      suspiciousService.endTelemetryIngest(session.id);
    }
    if (result.proctoring_action && result.proctoring_action !== 'none') {
      proctorDebugFlow('telemetry_escalation', {
        session_id: session.id,
        action: result.proctoring_action,
        trigger_flag_type: result.trigger_flag_type,
        integrity_status: result.proctoring?.integrity_status,
        risk_score: result.proctoring?.risk_score,
        effective_score: result.proctoring?.effective_score,
        flag_types: (result.flags || []).map((f) => f.type),
      });
    }
    return res.json({ ok: true, ...result });
  },

  async startInterview(req, res) {
    const session = req.interviewSession;
    if (
      session.status === SESSION_STATUS.TERMINATED_PROCTORING ||
      session.status === SESSION_STATUS.FAILED ||
      session.status === SESSION_STATUS.COMPLETED
    ) {
      return res.status(410).json({
        error: 'This assessment link is no longer valid.',
        code: 'INVITE_LINK_CONSUMED',
      });
    }

    const proctorReport = proctoringViolationService.buildReport(session);
    if (proctorReport.terminated) {
      return res.status(410).json({
        error: 'This assessment link is no longer valid.',
        code: 'INVITE_LINK_CONSUMED',
      });
    }

    if (!sessionService.canStartInterview(session) && session.status !== SESSION_STATUS.IN_PROGRESS) {
      return res.status(400).json({
        error: 'Complete OTP verification, headphone check, and device checks before starting.',
      });
    }

    try {
      await callEngineService.assertHeadphonesRequired(session);
    } catch (e) {
      return res.status(e.status || 403).json({ error: e.message });
    }

    if (session.status === SESSION_STATUS.IN_PROGRESS) {
      const state = await questionEngineService.getCallState(session);
      return res.json({
        ok: true,
        resumed: true,
        session_token: session.session_token,
        transport: 'browser_in_app',
        call_state: state,
      });
    }

    try {
      const result = await orchestratorService.startInterview(session);
      const [fresh, state] = await Promise.all([
        sessionRepository.findById(session.id),
        questionEngineService.getCallState(session, { includeQuestions: false }),
      ]);

      assessmentLog.session('Assessment session started', {
        sessionId: session.id,
        candidateId: session.candidate_id,
        totalQuestions: state.total_questions,
      });

      emitPortalEvent(fresh || session, PORTAL_EVENTS.CALL_STARTED, {
        occurred_at: fresh?.started_at ? new Date(fresh.started_at).toISOString() : new Date().toISOString(),
        started_at: fresh?.started_at || null,
        total_questions: state.total_questions,
        transport: result.inApp ? 'browser_in_app' : 'phone',
        mock_call_id: result.inApp?.mockCallId || null,
      });

      return res.json({
        ok: true,
        external_call_sid: result.externalCallSid,
        interview_type: session.interview_type,
        transport: result.inApp ? 'browser_in_app' : 'phone',
        mock_call_id: result.inApp?.mockCallId,
        session_token: result.sessionToken || fresh.session_token,
        call_state: state,
      });
    } catch (e) {
      console.error('[startInterview]', e.message);
      if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) {
        try {
          const state = await questionEngineService.getCallState(session);
          if (state.total_questions) {
            const fresh = await sessionRepository.findById(session.id);
            return res.json({
              ok: true,
              recovered: true,
              session_token: fresh?.session_token || session.session_token,
              transport: 'browser_in_app',
              call_state: state,
            });
          }
        } catch (_) {}
      }
      return res.status(e.status || 500).json({
        error: e.message || 'Failed to start interview',
        code: e.code || undefined,
      });
    }
  },

  async getCallState(req, res) {
    const session = req.interviewSession;
    const state = await questionEngineService.getCallState(session);
    return res.json({ ok: true, ...state });
  },

  async reportHeadphones(req, res) {
    const session = req.interviewSession;
    const headphone = await detectHeadphones(req.body);
    const detected = headphone.status === HEADPHONE_STATUS.DETECTED;

    await sessionRepository.update(session.id, {
      headphone_status: detected ? HEADPHONE_STATUS.DETECTED : HEADPHONE_STATUS.NOT_DETECTED,
    });

    if (!detected && session.status === SESSION_STATUS.IN_PROGRESS) {
      const result = await questionEngineService.logSuspiciousEvent(
        session,
        FLAG_TYPES.HEADPHONES_REMOVED,
        headphone.message || 'Headphones disconnected during interview',
        { device_label: req.body?.device_label, source: 'device_monitor' }
      );
      return res.json({
        ok: true,
        detected: false,
        alert: true,
        message: headphone.message,
        flag_id: result?.id,
        proctoring: result?.proctoring || null,
        proctoring_action: result?.proctoring_action || 'none',
        terminate: result?.terminate || false,
      });
    }

    return res.json({ ok: true, detected, message: detected ? 'Headphones OK' : headphone.message });
  },

  async submitAnswer(req, res) {
    const session = req.interviewSession;
    if (!ACTIVE_CALL_STATUSES.has(session.status)) {
      return res.status(400).json({ error: 'Interview call is not active' });
    }
    if (session.headphone_status !== HEADPHONE_STATUS.DETECTED) {
      return res.status(403).json({
        error: 'Headphones are required. Reconnect your headset and wait for confirmation before submitting.',
      });
    }
    const questionId = Number(req.body.question_id);
    if (!questionId) return res.status(400).json({ error: 'question_id required' });

    const textAnswer = req.body.text_answer?.trim() || '';
    if (!req.file && !textAnswer) {
      return res.status(400).json({ error: 'Answer audio or text_answer is required' });
    }

    try {
      const result = await questionEngineService.submitAnswer(session, questionId, req.file, {
        textAnswer,
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  },

  async repeatQuestion(req, res) {
    const session = req.interviewSession;
    const questionId = Number(req.body?.question_id);
    const spokenText = String(req.body?.spoken_text || '').trim();
    if (!questionId) return res.status(400).json({ error: 'question_id required' });

    try {
      const result = await questionRephraseService.handleRepeatRequest(session, questionId, {
        spokenText,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      console.log(
        '[repeat-question]',
        JSON.stringify({
          session_id: session.id,
          question_id: questionId,
          spoken_preview: spokenText.slice(0, 120),
          ok: result.ok,
          reason: result.reason ?? null,
          is_repeat_request: result.isRepeatRequest ?? null,
          confidence: result.confidence ?? null,
          repeat_count: result.repeat_count ?? null,
          limit_reached: result.limit_reached ?? null,
        })
      );
      return res.json(result);
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message || 'Repeat request failed' });
    }
  },

  async detectRepeatIntent(req, res) {
    const spoken = String(req.body?.spoken_text || '').trim();
    const result = classifyQuestionRepeatRequest(spoken);
    return res.json({
      is_repeat_request: result.isRepeatRequest,
      confidence: result.confidence,
    });
  },

  async classifyCandidateInput(req, res) {
    const session = req.interviewSession;
    const spoken = String(req.body?.spoken_text || '').trim();
    const questionId = Number(req.body?.question_id) || null;
    const questionText = String(req.body?.question_text || '').trim();
    const clientState = req.body?.assessment_state || {};

    if (!spoken) {
      return res.json({
        intent: 'NOISE_OR_UNCLEAR_INPUT',
        confidence: 0,
        reasoning: 'empty',
        action: 'speak',
        responseText: "I didn't catch that clearly. Could you please repeat your response?",
        removeFromTranscript: true,
        continueRecording: true,
      });
    }

    try {
      const started = Date.now();
      const callState = await questionEngineService.getCallState(session);
      const agentState = getInterviewAgentState(session);
      const questionIndex = clientState.question_index ?? (callState.answered_count ?? 0) + 1;
      const totalQuestions = clientState.total_questions ?? callState.total_questions ?? 0;
      const isPaused = clientState.is_paused ?? agentState.isPaused ?? false;

      await saveInterviewAgentState(session, {
        currentQuestionIndex: questionIndex,
        totalQuestions,
        currentQuestionId: questionId,
        currentQuestionText: questionText,
        isPaused,
      });

      const assessmentState = {
        phase: clientState.phase || 'recording_answer',
        question_index: questionIndex,
        answered_count: clientState.answered_count ?? callState.answered_count ?? 0,
        total_questions: totalQuestions,
        recording: clientState.recording ?? true,
        confirmation_pending: clientState.confirmation_pending ?? false,
        is_paused: isPaused,
      };

      const classification = await classifyCandidateInput(spoken, {
        questionText,
        questionId,
        sessionId: session.id,
        assessmentState,
      });
      const dispatch = await assessmentResponseRouter.dispatch(session, classification, {
        questionText,
        questionId,
        spokenText: spoken,
        callState,
        assessmentState,
      });
      console.log(
        '[classify-input]',
        JSON.stringify({
          session_id: session.id,
          question_id: questionId,
          spoken_preview: spoken.slice(0, 160),
          intent: classification?.intent,
          confidence: classification?.confidence,
          reasoning: classification?.reasoning,
          source: classification?.source,
          action: dispatch?.action,
          remove_from_transcript: dispatch?.removeFromTranscript,
          ms: Date.now() - started,
        })
      );
      return res.json({
        ...classification,
        ...dispatch,
      });
    } catch (e) {
      assessmentLog.system('Unexpected error in pipeline', {
        error: e.message,
        sessionId: session.id,
        questionId,
      });
      return res.json({
        intent: 'ANSWER',
        confidence: 0,
        reasoning: 'pipeline_error',
        action: 'continue_recording',
        responseText: null,
        removeFromTranscript: false,
        continueRecording: true,
      });
    }
  },

  async logQuestionDispatched(req, res) {
    const session = req.interviewSession;
    const questionId = Number(req.body?.question_id) || null;
    const questionIndex = Number(req.body?.question_index) || null;
    const questionText = String(req.body?.question_text || '').slice(0, 500);

    assessmentLog.question('Question dispatched to candidate', {
      sessionId: session.id,
      questionId,
      questionIndex,
      questionText,
    });
    assessmentLog.question('Awaiting candidate response', {
      sessionId: session.id,
      questionId,
      silenceTimerStarted: true,
    });

    const callState = await questionEngineService.getCallState(session).catch(() => ({}));
    await saveInterviewAgentState(session, {
      currentQuestionIndex: questionIndex || (callState.answered_count ?? 0) + 1,
      totalQuestions: callState.total_questions ?? 0,
      currentQuestionId: questionId,
      currentQuestionText: questionText,
      isPaused: false,
      pauseReason: null,
      lastGeneralQuestion: null,
      resumePrompt: null,
    });

    return res.json({ ok: true });
  },

  async silencePrompt(req, res) {
    const session = req.interviewSession;
    const questionId = Number(req.body?.question_id) || null;
    const text = assessmentResponseRouter.silencePrompt(session);
    return res.json({ ok: true, responseText: text, questionId });
  },

  async classifyConfirmIntent(req, res) {
    const session = req.interviewSession;
    const spoken = req.body?.spoken_text?.trim() || '';
    const started = Date.now();
    if (!spoken) {
      console.log(
        '[confirm-intent]',
        JSON.stringify({ session_id: session?.id || null, spoken: '', intent: 'UNCLEAR', reason: 'empty' })
      );
      return res.json({ intent: 'UNCLEAR', confidence: 0 });
    }
    try {
      const result = await classifyConfirmationIntent(spoken);
      console.log(
        '[confirm-intent]',
        JSON.stringify({
          session_id: session?.id || null,
          spoken: spoken.slice(0, 160),
          intent: result?.intent,
          confidence: result?.confidence,
          tier: result?.tier,
          ms: Date.now() - started,
        })
      );
      return res.json(result);
    } catch (e) {
      console.error(
        '[confirm-intent]',
        JSON.stringify({
          session_id: session?.id || null,
          spoken: spoken.slice(0, 160),
          error: e.message,
          ms: Date.now() - started,
        })
      );
      return res.json({ intent: 'UNCLEAR', confidence: 0 });
    }
  },

  async logSuspicious(req, res) {
    const session = req.interviewSession;
    const { event_type, message, ...payload } = req.body || {};
    if (!event_type) return res.status(400).json({ error: 'event_type required' });
    const result = await questionEngineService.logSuspiciousEvent(
      session,
      event_type,
      message || event_type,
      payload
    );
    if (result?.proctoring_action && result.proctoring_action !== 'none') {
      proctorDebugFlow('suspicious_escalation', {
        session_id: session.id,
        event_type: event_type,
        canonical_type: result.trigger_flag_type,
        action: result.proctoring_action,
        risk_score: result.proctoring?.risk_score,
        effective_score: result.proctoring?.effective_score,
      });
    }
    return res.json({
      ok: true,
      alert: !result?.deduped,
      deduped: result?.deduped || false,
      flag_id: result?.id,
      message: result?.message || message || event_type,
      proctoring: result?.proctoring || null,
      proctoring_action: result?.proctoring_action || 'none',
      terminate: result?.terminate || false,
      trigger_flag_type: result?.trigger_flag_type || event_type,
    });
  },

  async getProctoringState(req, res) {
    const session = req.interviewSession;
    const report = proctoringViolationService.buildReport(session);
    const integrity = integrityService.buildReport(session);
    proctorDebug('proctoring_state_requested', {
      session_id: session.id,
      integrity_status: report.integrity_status,
      risk_score: report.risk_score,
      integrity_score: integrity.integrity_score,
    });
    return res.json({ ok: true, proctoring: report, integrity });
  },

  async postIntegrityHeartbeat(req, res) {
    const session = req.interviewSession;
    if (session.status !== SESSION_STATUS.IN_PROGRESS) {
      return res.json({ ok: true, skipped: true });
    }
    const result = await integrityService.processHeartbeat(session, req.body || {});
    if (result.proctoring_action && result.proctoring_action !== 'none') {
      integrityLog('Heartbeat escalation', {
        session_id: session.id,
        detail: `action=${result.proctoring_action}, score=${result.integrity_score}`,
      });
    }
    return res.json(result);
  },

  async postIntegritySignals(req, res) {
    const session = req.interviewSession;
    const signals = Array.isArray(req.body?.signals) ? req.body.signals : [];
    const results = await integrityService.ingestSignals(session, signals);
    let proctoring = null;
    let proctoringAction = 'none';
    let terminate = false;
    for (const r of results) {
      if (r.proctoring) proctoring = r.proctoring;
      if (r.proctoring_action === 'terminate') {
        proctoringAction = 'terminate';
        terminate = true;
        break;
      }
      if (r.proctoring_action === 'final_warning') proctoringAction = 'final_warning';
      else if (r.proctoring_action === 'warning' && proctoringAction !== 'final_warning') {
        proctoringAction = 'warning';
      }
    }
    return res.json({
      ok: true,
      results: results.map((r) => ({
        escalated: r.escalated,
        flag_type: r.flag_type,
        proctoring_action: r.proctoring_action,
      })),
      proctoring,
      proctoring_action: proctoringAction,
      terminate,
    });
  },

  async getIntegrityTimeline(req, res) {
    const session = req.interviewSession;
    const report = integrityService.getTimeline(session);
    return res.json({ ok: true, integrity: report });
  },

  async flowDebugLog(req, res) {
    const session = req.interviewSession;
    const { label, meta, ts } = req.body || {};
    if (!label) return res.status(400).json({ error: 'label required' });
    const payload = {
      session_id: session?.id || null,
      token: req.params?.token || null,
      label,
      ts: ts || new Date().toISOString(),
      meta: meta || {},
    };
    try {
      const labelStr = String(label);
      if (
        labelStr.includes('repeat_flow') ||
        labelStr.includes('enter_recording')
      ) {
        console.log('[voice-flow]', JSON.stringify(payload));
      }
      console.log('[flow-debug]', JSON.stringify(payload));
      if (String(label).startsWith('proctor_')) {
        proctorDebugFlow('client_' + String(label).replace(/^proctor_/, ''), {
          session_id: session?.id || null,
          ...(meta || {}),
        });
      }
    } catch (e) {
      console.log('[flow-debug]', session?.id || 'unknown', label, meta || {});
    }
    return res.json({ ok: true });
  },

  async uploadRecording(req, res) {
    const session = req.interviewSession;
    if (!req.file) return res.status(400).json({ error: 'No recording file' });

    const chunkIndex = Number(req.body.chunk_index ?? req.body.chunkIndex ?? 0);
    const totalChunksExpected = Number(
      req.body.total_chunks_expected ?? req.body.totalChunksExpected ?? chunkIndex + 1
    );
    const mimeType = req.body.mime_type || req.body.mimeType || req.file.mimetype || 'video/webm';
    const isEmergency =
      req.body.emergency === 'true' ||
      req.body.emergency === true ||
      req.body.flush === 'true';

    recordingDebug('upload_received', {
      session_id: session.id,
      chunk_index: chunkIndex,
      total_chunks_expected: totalChunksExpected,
      emergency: isEmergency,
      bytes: req.file.size,
      storage: 'disk',
    });
    console.log(
      `[recording-persist] upload session=${session.id} chunk_${chunkIndex} bytes=${req.file.size}`
    );

    try {
      const saved = await recordingService.saveChunk(session, req.file, {
        chunkIndex,
        totalChunksExpected,
        mimeType,
      });
      if (saved.skipped) {
        recordingDebug('upload_chunk_skipped', {
          session_id: session.id,
          chunk_index: chunkIndex,
          reason: saved.reason,
        });
        return res.json({ ok: true, skipped: true, ...saved });
      }

      const chunkStats = await recordingChunkService.getSessionChunkStats(session.id);

      recordingDebug('upload_chunk_ack', {
        session_id: session.id,
        chunk_index: chunkIndex,
        bytes: saved.bytes,
        stored: 'disk',
        total_chunks: chunkStats?.chunkCount ?? null,
      });
      console.log(
        `[recording-persist] upload completed session=${session.id} chunk=${chunkIndex} bytes=${saved.bytes} total_on_disk=${chunkStats?.chunkCount ?? '?'}`
      );

      return res.json({
        ok: true,
        ack: true,
        chunk_index: chunkIndex,
        ...saved,
        session_chunk_stats: chunkStats,
      });
    } catch (e) {
      recordingDebug('upload_chunk_failed', {
        session_id: session.id,
        chunk_index: chunkIndex,
        error: e.message,
      });
      console.error('[uploadRecording] chunk failed:', e.message);
      return res.status(e.status || 500).json({ error: e.message || 'Chunk upload failed' });
    }
  },

  async endRecording(req, res) {
    const session = req.interviewSession;
    const sessionId = Number(req.body.session_id ?? req.body.sessionId ?? session.id);
    const totalChunksSent = Number(
      req.body.total_chunks_sent ?? req.body.totalChunksSent ?? req.body.total_chunks_expected ?? 0
    );
    const totalChunksAcked = Number(req.body.total_chunks_acked ?? req.body.totalChunksAcked ?? 0);
    const uploadComplete = req.body.upload_complete === true || req.body.upload_complete === 'true';

    if (sessionId !== session.id) {
      return res.status(403).json({ error: 'Session mismatch' });
    }
    if (!Number.isFinite(totalChunksSent) || totalChunksSent < 0) {
      return res.status(400).json({ error: 'total_chunks_sent is required' });
    }

    try {
      const result = await recordingService.endSessionRecording(sessionId, { totalChunksSent });
      recordingDebug('recording_end_accepted', {
        session_id: sessionId,
        total_chunks_sent: totalChunksSent,
        total_chunks_acked: totalChunksAcked || null,
        upload_complete: uploadComplete,
        failed_chunk_indexes: req.body.failed_chunk_indexes || null,
      });
      console.log(
        `[recording-persist] recording/end session=${sessionId} sent=${totalChunksSent} acked=${totalChunksAcked} complete=${uploadComplete}`
      );
      return res.json({
        ok: true,
        session_id: sessionId,
        total_chunks_sent: totalChunksSent,
        merge_delay_ms: interviewConfig.recordingMergeDelayMs,
        ...result,
      });
    } catch (e) {
      recordingDebug('recording_end_failed', {
        session_id: sessionId,
        error: e.message,
      });
      return res.status(e.status || 500).json({ error: e.message || 'Failed to finalize recording upload' });
    }
  },

  async endInterview(req, res) {
    const session = req.interviewSession;
    const suspicious = req.body.suspicious === true || req.body.suspicious === 'true';
    const proctoringTerminated =
      req.body.proctoring_terminated === true || req.body.proctoring_terminated === 'true';

    feedbackEmailDebug('end_interview_start', {
      session_id: session?.id,
      proctoring_terminated: proctoringTerminated,
      suspicious,
      session_status: session?.status || null,
      candidate_email: session?.candidate_email || null,
    });

    try {
    const chunkStatsBefore = await recordingChunkService.getSessionChunkStats(session.id);

    proctorDebug('end_interview', {
      session_id: session.id,
      suspicious,
      proctoring_terminated: proctoringTerminated,
      chunks_before_finalize: chunkStatsBefore,
    });

    if (proctoringTerminated) {
      await proctoringViolationService.terminateSession(session, {
        reason: 'proctoring_violation',
        flagType: req.body.flag_type || null,
      });
    }

    try {
      await ensureSessionStatusEnum();
    } catch (enumErr) {
      feedbackEmailDebugError('end_interview_status_enum_migration_failed', enumErr, {
        session_id: session.id,
        proctoring_terminated: proctoringTerminated,
      });
      console.error(
        `[endInterview] Status ENUM migration failed for session ${session.id} — continuing:`,
        enumErr.message
      );
    }

    const updated = await orchestratorService.completeInterview(session.id, {
      suspicious,
      proctoringTerminated,
    });

    feedbackEmailDebug('end_interview_session_completed', {
      session_id: session.id,
      updated_status: updated?.status || null,
      proctoring_terminated: proctoringTerminated,
    });

    const freshForLog = await sessionRepository.findById(session.id);
    const endState = freshForLog ? await questionEngineService.getCallState(freshForLog) : null;
    assessmentLog.session('Assessment session ended', {
      sessionId: session.id,
      duration: freshForLog?.duration_seconds ?? null,
      questionsAnswered: endState?.answered_count ?? null,
    });
    clearSessionResponses(session.id);

    if (req.body.transcript) {
      await recordingService.saveTranscript(session.id, String(req.body.transcript));
    }

    feedbackEmailDebug('end_interview_finalize_attempt', {
      session_id: session.id,
      proctoring_terminated: proctoringTerminated,
    });

    let summaryResult = null;
    let finalizeError = null;
    try {
      const freshForFinalize = await sessionRepository.findById(session.id);
      summaryResult = await summaryService.finalizeInterview(freshForFinalize || updated || session);
      feedbackEmailDebug('end_interview_finalize_done', {
        session_id: session.id,
        proctoring_terminated: proctoringTerminated,
        email_result: summaryResult?.emailResult || null,
        mock_call_id: summaryResult?.mockCallId || null,
      });
    } catch (finalizeErr) {
      finalizeError = finalizeErr;
      feedbackEmailDebugError('end_interview_finalize_failed', finalizeErr, {
        session_id: session.id,
        proctoring_terminated: proctoringTerminated,
      });
      console.error(
        `[endInterview] Summary finalize failed for session ${session.id} — continuing with webhook dispatch:`,
        finalizeErr.message
      );
    }

    const freshSession = await sessionRepository.findById(session.id);

    // Emit call_ended before completion webhook so lifecycle events are not blocked by merge/payload errors.
    emitPortalEvent(freshSession || updated || session, PORTAL_EVENTS.CALL_ENDED, {
      occurred_at: (freshSession || updated)?.ended_at
        ? new Date((freshSession || updated).ended_at).toISOString()
        : new Date().toISOString(),
      ended_at: (freshSession || updated)?.ended_at || null,
      duration_seconds: (freshSession || updated)?.duration_seconds ?? null,
      proctoring_terminated: proctoringTerminated,
      suspicious,
      questions_answered: endState?.answered_count ?? null,
      session_status: (freshSession || updated)?.status || null,
      assessment_termination: proctoringTerminated,
    });

    const chunkStatsBeforeMerge = await recordingChunkService.getSessionChunkStats(session.id);

    const clientRecording = req.body.recording;
    const clientTotalChunks = Number(clientRecording?.parts ?? clientRecording?.total_parts ?? 0) || null;

    // Merge recording BEFORE webhook so signed URL is included in the callback payload.
    // Client now drains all uploads before POST /end; server waits for expectation + all chunks.
    let mergeResult = null;
    let mergeError = null;
    try {
      mergeResult = await recordingService.finalizeSessionRecording(session.id, {
        immediate: true,
        clientTotalChunks,
      });
    } catch (mergeErr) {
      mergeError = mergeErr;
      console.error(
        `[endInterview] Recording merge failed for session ${session.id} — continuing with webhook:`,
        mergeErr.message
      );
      mergeResult = { error: mergeErr.message, partial: true };
    }

    const chunkStatsAfter = await recordingChunkService.getSessionChunkStats(session.id);

    recordingDebug('end_finalize_recording', {
      session_id: session.id,
      proctoring_terminated: proctoringTerminated,
      chunks_in_db: chunkStatsAfter.chunkCount,
      bytes_in_db: chunkStatsAfter.totalBytes,
      merge_result: mergeResult?.recordingId
        ? { recording_id: mergeResult.recordingId, partial: !!mergeResult.partial, source: mergeResult.source }
        : mergeResult,
    });

    if (session.started_at && chunkStatsAfter.chunkCount === 0 && !mergeResult?.recordingId) {
      console.warn(
        `[endInterview] Session ${session.id} ended with ZERO persisted recording chunks — investigate upload pipeline`
      );
    }

    // Webhook dispatch after merge — recording URL must be present when merge succeeds.
    let webhookResult = { skipped: true, reason: 'not_attempted' };
    try {
      webhookResult = await apiCompletionService.onInterviewCompleted(
        freshSession || updated || session,
        {
          emailResult: summaryResult?.emailResult || null,
          proctoringTerminated,
        }
      );

      if (
        !webhookResult?.skipped &&
        mergeResult?.signedUrl &&
        !webhookResult?.webhookPayload?.recording?.url
      ) {
        console.warn(
          `[endInterview] Webhook payload missing recording URL after merge for session ${session.id} — check HOST_URL / signed URL generation`
        );
      }
    } catch (webhookErr) {
      console.error(
        `[endInterview] Webhook dispatch failed for session ${session.id}:`,
        webhookErr.message
      );
      webhookResult = { skipped: true, reason: 'dispatch_error', error: webhookErr.message };
    }

    console.log(
      `[assessment-completion] ${JSON.stringify({
        session_id: session.id,
        proctoring_terminated: proctoringTerminated,
        session_status: (freshSession || updated)?.status || null,
        feedback_email: summaryResult?.emailResult || null,
        webhook: webhookResult?.skipped
          ? { skipped: true, reason: webhookResult.reason }
          : {
              delivered: webhookResult?.delivery?.delivered === true,
              attempts: webhookResult?.delivery?.attempts ?? null,
              http_status: webhookResult?.delivery?.status ?? null,
              assessment_termination: webhookResult?.webhookPayload?.assessment_termination ?? null,
            },
      })}`
    );

    if (webhookResult?.skipped) {
      console.log(`[endInterview] Webhook not sent for session ${session.id}: ${webhookResult.reason}`);
    } else if (webhookResult?.delivery) {
      console.log(
        `[endInterview] Webhook delivery session=${session.id} delivered=${webhookResult.delivery.delivered} attempts=${webhookResult.delivery.attempts ?? '?'} status=${webhookResult.delivery.status ?? '?'}`
      );
    }

    const webhookLogForStorage = webhookResult?.skipped
      ? { skipped: true, reason: webhookResult.reason, error: webhookResult.error || null }
      : {
          status: webhookResult?.delivery?.statusLabel || (webhookResult?.delivery?.delivered ? 'success' : 'failed'),
          savedAt: webhookResult?.delivery?.savedAt || new Date().toISOString(),
          attempts: webhookResult?.delivery?.attemptLog || [],
          finalError: webhookResult?.delivery?.finalError || null,
          delivered: webhookResult?.delivery?.delivered === true,
          http_status: webhookResult?.delivery?.status ?? null,
        };

    await verificationRepository.log({
      session_id: session.id,
      event_type: 'interview_end',
      success: true,
      ...clientMeta(req),
      details_json: {
        merge: mergeResult,
        merge_error: mergeError?.message || mergeResult?.error || null,
        chunks_before_merge: chunkStatsBeforeMerge,
        summary: summaryResult?.mockCallId,
        proctoring_terminated: proctoringTerminated,
        feedback_email: summaryResult?.emailResult || null,
        finalize_error: finalizeError?.message || null,
        webhook: webhookLogForStorage,
      },
    });

    feedbackEmailDebug('end_interview_complete', {
      session_id: session.id,
      proctoring_terminated: proctoringTerminated,
      feedback_email: summaryResult?.emailResult || null,
    });

    const proctoringReport = proctoringViolationService.buildReport(freshSession || updated || session);
    const integrityReport = integrityService.buildReport(freshSession || updated || session);

    const sessionLabels = resolveSessionLabelsFromSession(freshSession || updated || session);

    return res.json({
      ok: true,
      message: proctoringTerminated
        ? sessionLabels.terminatedEndApiMessage
        : sessionLabels.endApiMessage,
      proctoring_terminated: proctoringTerminated,
      proctoring: proctoringReport,
      integrity: integrityReport,
      recording: {
        ...(mergeResult?.recordingId ? { id: mergeResult.recordingId, merged: true } : mergeResult),
        chunks_on_disk: chunkStatsAfter.chunkCount,
        bytes_on_disk: chunkStatsAfter.totalBytes,
        recording_status: mergeResult?.recordingStatus || null,
        available_chunks: mergeResult?.availableChunks ?? chunkStatsAfter.chunkCount,
        total_chunks_expected: chunkStatsAfter.totalChunksExpected ?? mergeResult?.totalChunksExpected ?? null,
        partial: !!mergeResult?.partial || !!chunkStatsAfter.partial,
        signed_url: mergeResult?.signedUrl ?? null,
      },
      summary: summaryResult,
      feedback_email: summaryResult?.emailResult || null,
      finalize_error: finalizeError ? finalizeError.message : null,
      webhook: webhookResult?.skipped
        ? { skipped: true, reason: webhookResult.reason }
        : {
            delivered: webhookResult?.delivery?.delivered === true,
            attempts: webhookResult?.delivery?.attempts ?? null,
            http_status: webhookResult?.delivery?.status ?? null,
            status: webhookResult?.delivery?.statusLabel || null,
            attempt_log: webhookResult?.delivery?.attemptLog || [],
          },
      merge_error: mergeError?.message || null,
    });
    } catch (err) {
      feedbackEmailDebugError('end_interview_unhandled', err, {
        session_id: session?.id,
        proctoring_terminated: proctoringTerminated,
      });
      try {
        await verificationRepository.log({
          session_id: session.id,
          event_type: 'interview_end',
          success: false,
          ...clientMeta(req),
          details_json: {
            proctoring_terminated: proctoringTerminated,
            error: err?.message || String(err),
          },
        });
      } catch (_) {}
      return res.status(err.status || 500).json({
        error: err.message || 'Failed to end interview',
        proctoring_terminated: proctoringTerminated,
      });
    }
  },

  async sessionStatus(req, res) {
    const session = await sessionRepository.findByToken(req.interviewToken);
    return res.json({
      status: session?.status,
      otp_verified: session?.otp_verified === 1,
      preflight_completed: session?.preflight_completed === 1,
      recording_storage: interviewConfig.recordingStorage,
    });
  },

  /** Lightweight RTT probe for in-call connectivity monitoring (no side effects). */
  async connectivityPing(req, res) {
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, ts: Date.now() });
  },
};
