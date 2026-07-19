import db from '../../../config/db.js';
import moment from 'moment-timezone';
import { SESSION_STATUS, INTERVIEW_TYPES } from '../constants.js';
import { interviewConfig } from '../config.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { auditRepository } from '../repositories/audit.repository.js';
import { generateSessionToken } from './token.service.js';
import { generateOtp, hashOtp } from './otp.service.js';
import { sendInterviewInviteEmail } from './invite.service.js';

function parseSessionMeta(session) {
  try {
    return typeof session.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session.metadata_json || {};
  } catch {
    return {};
  }
}

export const sessionService = {
  async listJobsForSelect() {
    try {
      const [rows] = await db.query(
        `SELECT id, title, job_id FROM jobs ORDER BY id DESC LIMIT 200`
      );
      return rows;
    } catch {
      return [];
    }
  },

  async scheduleInterview(input, recruiter) {
    const token = generateSessionToken();
    const scheduledAt = moment(input.scheduled_at).format('YYYY-MM-DD HH:mm:ss');
    const expiresAt = moment(scheduledAt)
      .add(interviewConfig.tokenTtlHours, 'hours')
      .format('YYYY-MM-DD HH:mm:ss');

    const otp = generateOtp();
    let jobMeta = null;
    if (input.job_id) {
      try {
        const [jobRows] = await db.query(
          `SELECT id, job_id, title, description, experience, questions, department FROM jobs WHERE id = ? OR job_id = ? ORDER BY id DESC LIMIT 1`,
          [input.job_id, input.job_id]
        );
        if (jobRows[0]) {
          jobMeta = {
            title: jobRows[0].title,
            description: jobRows[0].description,
            experience: jobRows[0].experience,
            department: jobRows[0].department,
          };
        }
      } catch {
        jobMeta = null;
      }
    }

    const session = await sessionRepository.create({
      session_token: token,
      candidate_id: input.candidate_id ?? null,
      candidate_name: input.candidate_name,
      candidate_email: input.candidate_email,
      candidate_phone: input.candidate_phone ?? null,
      recruiter_id: recruiter?.user_id ?? recruiter?.id ?? null,
      job_id: input.job_id ?? null,
      job_title: input.job_title ?? null,
      company_id: recruiter?.company_id ?? null,
      interview_type: input.interview_type || INTERVIEW_TYPES.BROWSER_VIDEO,
      scheduled_at: scheduledAt,
      expires_at: expiresAt,
      status: SESSION_STATUS.CREATED,
      otp_hash: hashOtp(otp),
      metadata_json: {
        timezone: input.timezone || 'Asia/Kolkata',
        notes: input.notes || null,
        send_sms: Boolean(input.send_sms),
        source: input.source || 'web',
        ...(input.session_type ? { session_type: input.session_type } : {}),
        callback: input.callback || null,
        job: input.job_meta || jobMeta || (input.job_title ? { title: input.job_title } : null),
        interview: {
          ...(input.interview_questions?.length ? { questions: input.interview_questions } : {}),
          ...(input.question_count != null && input.question_count !== ''
            ? { question_count: Number(input.question_count) }
            : input.interview_questions?.length
              ? { question_count: input.interview_questions.length }
              : {}),
          ...(input.question_source ? { question_source: input.question_source } : {}),
        },
      },
    });

    await auditRepository.log({
      session_id: session.id,
      actor_type: 'admin',
      actor_id: recruiter?.user_id,
      action: 'session_created',
      ip_address: null,
      details_json: { interview_type: session.interview_type },
    });

    return { session, otp };
  },

  async sendInvite(session, baseUrl, emailOptions = {}) {
    const interviewUrl = `${baseUrl.replace(/\/$/, '')}/interview/${session.session_token}`;
    await sendInterviewInviteEmail({
      to: session.candidate_email,
      name: session.candidate_name,
      interviewUrl,
      scheduledAt: session.scheduled_at,
      jobTitle: session.job_title,
      inviteSubject: emailOptions.inviteSubject,
      inviteHeading: emailOptions.inviteHeading,
      sessionLabels: emailOptions.sessionLabels,
    });
    await sessionRepository.update(session.id, {
      status: SESSION_STATUS.INVITED,
      invite_sent_at: moment().format('YYYY-MM-DD HH:mm:ss'),
    });
    return interviewUrl;
  },

  assertSessionAccessible(session, { allowRecordingFlush = false } = {}) {
    if (!session) {
      const err = new Error('Interview session not found');
      err.status = 404;
      err.title = 'Link not found';
      throw err;
    }
    if (moment(session.expires_at).isBefore(moment())) {
      const err = new Error('Interview link has expired');
      err.status = 410;
      err.title = 'Link expired';
      throw err;
    }
    if (session.status === SESSION_STATUS.CANCELLED) {
      const err = new Error('Interview session was cancelled');
      err.status = 410;
      err.title = 'Session cancelled';
      throw err;
    }

    if (allowRecordingFlush) {
      // Recording flush + /end must work after proctoring termination metadata is set.
      return;
    }

    if (session.status === SESSION_STATUS.COMPLETED) {
      const err = new Error('Assessment already completed');
      err.status = 410;
      err.title = 'Assessment completed';
      throw err;
    }
    if (
      session.status === SESSION_STATUS.TERMINATED_PROCTORING ||
      session.status === SESSION_STATUS.FAILED
    ) {
      const err = new Error('This assessment link is no longer valid.');
      err.status = 410;
      err.title = 'Invalid Link';
      throw err;
    }
    const meta = parseSessionMeta(session);
    if (meta.proctoring?.terminated === true) {
      const err = new Error('This assessment link is no longer valid.');
      err.status = 410;
      err.title = 'Invalid Link';
      throw err;
    }
    // in_progress, preflight_ok, verified, invited, etc. are allowed for active token holders
  },

  /** Error when candidate re-opens the original invite URL after Start Call. */
  buildInviteLinkInvalidError(session) {
    const status = session?.status;
    let detail = 'This assessment link is no longer valid.';
    if (status === SESSION_STATUS.IN_PROGRESS || status === SESSION_STATUS.SUSPICIOUS) {
      detail =
        'This assessment link is no longer valid.';
    } else if (status === SESSION_STATUS.COMPLETED) {
      detail =
        'This assessment link is no longer valid.';
    } else if (
      status === SESSION_STATUS.TERMINATED_PROCTORING ||
      status === SESSION_STATUS.FAILED
    ) {
      detail = 'This assessment link is no longer valid.';
    } else {
      detail =
        'This assessment link is no longer valid.';
    }
    const err = new Error(detail);
    err.status = 410;
    err.title = 'Invalid Link';
    err.code = 'INVITE_LINK_CONSUMED';
    return err;
  },

  /**
   * Invalidate the emailed invite URL by rotating session_token (idempotent).
   * Returns the active session token the browser should use going forward.
   */
  async consumeInviteLink(session) {
    const meta = parseSessionMeta(session);
    if (meta.invite_token) {
      return session.session_token;
    }

    const newToken = generateSessionToken();
    const updatedMeta = {
      ...meta,
      invite_token: session.session_token,
      invite_link_consumed_at: moment().format('YYYY-MM-DD HH:mm:ss'),
    };

    await sessionRepository.update(session.id, {
      session_token: newToken,
      metadata_json: updatedMeta,
    });

    return newToken;
  },

  canStartInterview(session) {
    return (
      session.otp_verified === 1 &&
      session.preflight_completed === 1 &&
      [SESSION_STATUS.PREFLIGHT_OK, SESSION_STATUS.VERIFIED].includes(session.status)
    );
  },
};
