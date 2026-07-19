import moment from 'moment-timezone';
import { sessionService } from './session.service.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { SESSION_STATUS } from '../constants.js';
import { resolveSessionLabels } from '../lib/session-labels.js';
import { emitPortalEvent, PORTAL_EVENTS } from './portal-events.service.js';

function baseUrl() {
  return (process.env.HOST_URL || 'http://localhost:3002').replace(/\/$/, '');
}

export const scheduleVideoApiService = {
  async findDuplicateSchedule(candidateEmail, scheduledAt) {
    const rows = await sessionRepository.findByEmailAndScheduledAt(candidateEmail, scheduledAt);
    return rows?.[0] || null;
  },

  async scheduleVideoInterview(validated, recruiter = null) {
    const duplicate = await this.findDuplicateSchedule(
      validated.candidate_email,
      validated.scheduled_at
    );
    if (duplicate) {
      const err = new Error('An interview is already scheduled for this candidate at the same time');
      err.status = 409;
      err.errors = [err.message];
      throw err;
    }

    const defaultRecruiterId = Number(process.env.MOCK_INTERVIEW_DEFAULT_USER_ID || 1);
    const apiRecruiter = recruiter || { user_id: defaultRecruiterId, company_id: null };

    const { session, otp } = await sessionService.scheduleInterview(
      {
        candidate_name: validated.candidate_name,
        candidate_email: validated.candidate_email,
        interview_type: validated.interview_type,
        scheduled_at: validated.scheduled_at,
        timezone: validated.timezone,
        interview_questions: validated.interview_questions,
        session_type: validated.session_type,
        source: 'api',
        callback: validated.callback,
        send_invite: false,
      },
      apiRecruiter
    );

    const interviewLink = `${baseUrl()}/interview/${session.session_token}`;
    let emailSent = false;
    const sessionLabels = resolveSessionLabels(validated.session_type);

    if (validated.send_email_invite_immediately) {
      await sessionService.sendInvite(session, baseUrl(), {
        inviteSubject: sessionLabels.inviteSubject,
        inviteHeading: sessionLabels.inviteHeading,
        sessionLabels,
      });
      emailSent = true;
    }

    const fresh = await sessionRepository.findById(session.id);

    if (emailSent && fresh) {
      emitPortalEvent(fresh, PORTAL_EVENTS.INVITE_SENT, {
        occurred_at: fresh.invite_sent_at
          ? new Date(fresh.invite_sent_at).toISOString()
          : new Date().toISOString(),
        invite_sent_at: fresh.invite_sent_at || null,
        interview_link: interviewLink,
      });
    }

    return {
      session: fresh || session,
      interviewLink,
      emailSent,
      otp,
      status: emailSent ? SESSION_STATUS.INVITED : SESSION_STATUS.CREATED,
    };
  },
};
