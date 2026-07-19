import db from '../../../config/db.js';
import { mockCallBridge } from './mock-call-bridge.service.js';
import { questionRepository } from '../repositories/question.repository.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { HEADPHONE_STATUS } from '../constants.js';
import { isHeadphoneRequirementWaived } from './headphone-detector.service.js';

const prepareLocks = new Map();

function parseSessionMeta(session) {
  try {
    return session.metadata_json
      ? typeof session.metadata_json === 'string'
        ? JSON.parse(session.metadata_json)
        : session.metadata_json
      : {};
  } catch {
    return {};
  }
}

function isDuplicateKeyError(err) {
  return err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;
}

async function ensureSessionMetadata(session, meta, mockCallId, callSid, questionCount, questionPlan) {
  if (meta.mock_call_id && meta.call_sid) return;
  await sessionRepository.update(session.id, {
    metadata_json: {
      ...meta,
      mock_call_id: mockCallId,
      call_sid: callSid,
      transport: 'browser_in_app',
      question_count: questionCount,
      ...(questionPlan ? { question_plan: questionPlan } : {}),
    },
    external_call_sid: callSid,
  });
}

async function linkFeedbackRows(session, mockCallId, callSid, questionIds, accountContext) {
  const [existingRows] = await db.query(
    `SELECT id FROM feedback WHERE job_id = ? AND user_email = ? ORDER BY id ASC`,
    [mockCallId, session.candidate_email]
  );

  if (existingRows.length >= questionIds.length) {
    for (let i = 0; i < questionIds.length; i++) {
      if (questionIds[i] && existingRows[i]?.id) {
        await questionRepository.setFeedbackId(questionIds[i], existingRows[i].id);
      }
    }
    return;
  }

  const normalizedUserId = accountContext.userId;
  const normalizedAccountId = accountContext.accountId;
  const normalizedSuperAdmin = accountContext.isSuperAdmin;
  const questions = await questionRepository.listBySession(session.id);

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (q.feedback_id) continue;
    const [fb] = await db.query(
      `INSERT INTO feedback (
          is_super_admin, job_id, user_email, contact, sid, user_id,
          question, user_answer, status, created_at, account_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, NOW(), ?)`,
      [
        normalizedSuperAdmin,
        mockCallId,
        session.candidate_email,
        session.candidate_phone || session.candidate_email,
        callSid,
        normalizedUserId,
        q.question_text,
        normalizedAccountId,
      ]
    );
    if (questionIds[i]) {
      await questionRepository.setFeedbackId(questionIds[i], fb.insertId);
    }
  }
}

async function suppressOutboundSchedule(mockCallId) {
  await db.query(`UPDATE jobs SET call_schedule = 'no' WHERE job_id = ? AND call_schedule = 'yes'`, [
    mockCallId,
  ]);
}

/**
 * In-app call engine — mirrors mock-call job/api_calls setup without dialing a phone.
 */
export const callEngineService = {
  async assertHeadphonesRequired(session) {
    if (isHeadphoneRequirementWaived(session)) return;
    if (session.headphone_status !== HEADPHONE_STATUS.DETECTED) {
      const err = new Error('Headphones are required. Complete device check with headphones connected.');
      err.status = 403;
      throw err;
    }
  },

  /**
   * Resolve questions and persist session rows before Start Call (runs during preflight / room load).
   */
  async prepareSessionQuestions(session) {
    const sessionId = session.id;
    if (prepareLocks.has(sessionId)) {
      return prepareLocks.get(sessionId);
    }
    const run = callEngineService._prepareSessionQuestions(session).finally(() => {
      prepareLocks.delete(sessionId);
    });
    prepareLocks.set(sessionId, run);
    return run;
  },

  async _prepareSessionQuestions(session) {
    const meta = parseSessionMeta(session);
    const mockCallId = meta.mock_call_id || mockCallBridge.buildCallId(session.id);
    const callSid = meta.call_sid || mockCallBridge.buildCallSid(session.id);
    const accountContext = {
      userId: session.recruiter_id || Number(process.env.MOCK_INTERVIEW_DEFAULT_USER_ID || 1),
      isSuperAdmin: 0,
      accountId: session.company_id || null,
    };

    await suppressOutboundSchedule(mockCallId);

    const existingQuestions = await questionRepository.listBySession(session.id);
    if (existingQuestions.length > 0) {
      await ensureSessionMetadata(
        session,
        meta,
        mockCallId,
        callSid,
        existingQuestions.length,
        meta.question_plan
      );
      return {
        mockCallId,
        callSid,
        questions: existingQuestions,
        totalQuestions: existingQuestions.length,
        prepared: true,
      };
    }

    const existingJob = await mockCallBridge.findJobByCallId(mockCallId);
    let questions;
    let questionPlan = meta.question_plan || null;

    if (existingJob) {
      questions = mockCallBridge.questionsFromJobRow(existingJob);
      if (!questions.length) {
        const resolved = await mockCallBridge.resolveQuestions(session, meta);
        questions = resolved.questions || resolved;
        questionPlan = resolved.plan || questionPlan;
      }
    } else {
      const resolved = await mockCallBridge.resolveQuestions(session, meta);
      questions = resolved.questions || resolved;
      questionPlan = resolved.plan || null;
    }

    if (!questions.length) {
      const err = new Error('No interview questions available for this session');
      err.status = 500;
      throw err;
    }

    const normalizedStrings = questions.map((q) => q.question);
    const scheduleOpts = {
      call_at: new Date().toISOString(),
      timezone: meta.timezone || 'Asia/Kolkata',
      skip_outbound: true,
      transport: 'browser_in_app',
    };

    if (!existingJob) {
      try {
        await mockCallBridge.insertJobForMockInterview({
          callId: mockCallId,
          candidate: {
            name: session.candidate_name,
            email: session.candidate_email,
            phone: session.candidate_phone || '0000000000',
          },
          job: {
            title: session.job_title || meta.job?.title || 'Interview',
            description: meta.job?.description || '',
            experience: meta.job?.experience || '',
            department: meta.job?.department || null,
          },
          normalizedQuestions: normalizedStrings,
          schedule: scheduleOpts,
          accountContext,
        });
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
      }
    } else {
      await suppressOutboundSchedule(mockCallId);
    }

    const feedbackUrl = `${process.env.HOST_URL || ''}/admin/interviews/session/${session.id}`;
    try {
      await mockCallBridge.insertApiMockInterviewData({
        callId: mockCallId,
        payload: {
          candidate: {
            name: session.candidate_name,
            email: session.candidate_email,
            phone: session.candidate_phone,
          },
          job: meta.job || { title: session.job_title },
          interview: { type: 'browser_in_app', questions },
          schedule: { timezone: meta.timezone || 'Asia/Kolkata' },
          callback: meta.callback || {},
        },
        normalizedQuestions: normalizedStrings,
        status: 'in_progress',
        feedbackUrl,
        scheduledAtUtcDate: new Date(),
      });
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
    }

    await db.query(`DELETE FROM interview_session_questions WHERE session_id = ?`, [session.id]);
    const questionIds = await questionRepository.bulkCreate(session.id, questions);
    await linkFeedbackRows(session, mockCallId, callSid, questionIds, accountContext);

    const qList = await questionRepository.listBySession(session.id);

    await sessionRepository.update(session.id, {
      metadata_json: {
        ...meta,
        mock_call_id: mockCallId,
        call_sid: callSid,
        transport: 'browser_in_app',
        question_count: questions.length,
        question_plan: questionPlan,
        questions_prepared_at: new Date().toISOString(),
      },
      external_call_sid: callSid,
    });

    return {
      mockCallId,
      callSid,
      questions: qList.length ? qList : await questionRepository.listBySession(session.id),
      totalQuestions: questions.length,
      prepared: true,
    };
  },

  async startInAppCall(session) {
    await callEngineService.assertHeadphonesRequired(session);

    const sessionId = session.id;
    let existingQuestions = await questionRepository.listBySession(sessionId);

    // Room load should have finished prepare-session; if prep is still in flight, wait briefly.
    if (existingQuestions.length === 0 && prepareLocks.has(sessionId)) {
      try {
        await Promise.race([
          prepareLocks.get(sessionId),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('PREP_IN_FLIGHT_TIMEOUT')), 8000);
          }),
        ]);
      } catch (e) {
        if (e.message === 'PREP_IN_FLIGHT_TIMEOUT') {
          const err = new Error(
            'Assessment is still preparing. Wait a moment, then tap Start Call again.'
          );
          err.status = 409;
          err.code = 'SESSION_NOT_PREPARED';
          throw err;
        }
        throw e;
      }
      existingQuestions = await questionRepository.listBySession(sessionId);
    }

    if (existingQuestions.length > 0) {
      const meta = parseSessionMeta(session);
      const mockCallId = meta.mock_call_id || mockCallBridge.buildCallId(session.id);
      const callSid = meta.call_sid || mockCallBridge.buildCallSid(session.id);
      await ensureSessionMetadata(
        session,
        meta,
        mockCallId,
        callSid,
        existingQuestions.length,
        meta.question_plan
      );
      return {
        mockCallId,
        callSid,
        questions: existingQuestions,
        totalQuestions: existingQuestions.length,
        prepared: true,
        skipped_prepare: true,
      };
    }

    // Never run GPT/DB question generation on /start — that path caused 15–20s UI stalls.
    const err = new Error(
      'Assessment questions are not ready yet. Stay on this page until preparation finishes.'
    );
    err.status = 409;
    err.code = 'SESSION_NOT_PREPARED';
    throw err;
  },
};
