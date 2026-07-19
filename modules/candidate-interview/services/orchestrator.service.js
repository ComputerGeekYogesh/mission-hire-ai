import moment from 'moment-timezone';
import { SESSION_STATUS } from '../constants.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { auditRepository } from '../repositories/audit.repository.js';
import { callEngineService } from './call-engine.service.js';
import { sessionService } from './session.service.js';

/** Prevent concurrent /start for the same session (duplicate job inserts + slow AI). */
const startInterviewLocks = new Map();

export const orchestratorService = {
  async startInterview(session) {
    const sessionId = session.id;
    if (startInterviewLocks.has(sessionId)) {
      return startInterviewLocks.get(sessionId);
    }

    const run = orchestratorService._startInterview(session).finally(() => {
      startInterviewLocks.delete(sessionId);
    });
    startInterviewLocks.set(sessionId, run);
    return run;
  },

  async _startInterview(session) {
    const now = moment().format('YYYY-MM-DD HH:mm:ss');
    const activeSessionToken = await sessionService.consumeInviteLink(session);

    await sessionRepository.update(session.id, {
      status: SESSION_STATUS.IN_PROGRESS,
      started_at: now,
    });

    const freshSession = await sessionRepository.findById(session.id);
    const inApp = await callEngineService.startInAppCall(freshSession || session);

    await auditRepository.log({
      session_id: session.id,
      actor_type: 'candidate',
      action: 'interview_started',
      details_json: {
        interview_type: session.interview_type,
        external_call_sid: inApp.callSid,
        transport: 'browser_in_app',
        mock_call_id: inApp.mockCallId,
        invite_link_consumed: true,
      },
    });

    return { externalCallSid: inApp.callSid, inApp, sessionToken: activeSessionToken };
  },

  async completeInterview(sessionId, { suspicious = false, proctoringTerminated = false } = {}) {
    const session = await sessionRepository.findById(sessionId);
    if (!session) return null;

    const ended = moment().format('YYYY-MM-DD HH:mm:ss');
    let duration = null;
    if (session.started_at) {
      duration = moment(ended).diff(moment(session.started_at), 'seconds');
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

    if (session.status === SESSION_STATUS.TERMINATED_PROCTORING) {
      return sessionRepository.update(sessionId, {
        ended_at: session.ended_at || ended,
        duration_seconds: session.duration_seconds ?? duration,
        metadata_json: {
          ...meta,
          ...(proctoringTerminated
            ? {
                termination_reason: 'terminated_due_to_proctoring_violation',
                assessment_status: 'terminated_due_to_proctoring_violation',
              }
            : {}),
        },
      });
    }

    let status = SESSION_STATUS.COMPLETED;
    if (proctoringTerminated) {
      status = SESSION_STATUS.TERMINATED_PROCTORING;
      meta.termination_reason = 'terminated_due_to_proctoring_violation';
      meta.assessment_status = 'terminated_due_to_proctoring_violation';
      meta.termination_label = 'Terminated Due To Proctoring Violation';
    } else if (suspicious) {
      status = SESSION_STATUS.SUSPICIOUS;
    }

    return sessionRepository.update(sessionId, {
      status,
      ended_at: ended,
      duration_seconds: duration,
      metadata_json: meta,
    });
  },
};
