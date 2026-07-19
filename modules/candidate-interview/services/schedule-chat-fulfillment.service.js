import moment from 'moment-timezone';
import { INTERVIEW_TYPES } from '../constants.js';
import { sessionService } from './session.service.js';
import { resolveSessionLabels } from '../lib/session-labels.js';

const DEFAULT_TZ = 'Asia/Kolkata';

function normalizePhone(raw) {
  const s = String(raw || '').replace(/[\s\-()]/g, '');
  if (!/^\+?\d{10,15}$/.test(s)) return null;
  if (/^\+91\d{10}$/.test(s)) return s;
  if (/^91\d{10}$/.test(s)) return `+${s}`;
  if (/^\d{10}$/.test(s)) return `+91${s}`;
  return s.startsWith('+') ? s : `+${s}`;
}

function resolveCandidates(payload) {
  if (payload.candidates?.length) {
    return payload.candidates.map((c) => ({
      name: c.name,
      email: c.email,
      phone: normalizePhone(c.phone),
    }));
  }
  const phone = normalizePhone(payload.candidate_phone);
  return [
    {
      name: payload.candidate_name,
      email: payload.candidate_email,
      phone,
    },
  ];
}

async function fulfillBrowserSingle(payload, recruiter, baseUrl) {
  const { session, otp } = await sessionService.scheduleInterview(payload, recruiter);
  let interviewUrl = `${baseUrl.replace(/\/$/, '')}/interview/${session.session_token}`;
  const sessionLabels = resolveSessionLabels(payload.session_type);

  if (payload.send_invite !== false) {
    try {
      interviewUrl = await sessionService.sendInvite(session, baseUrl, {
        inviteSubject: sessionLabels.inviteSubject,
        inviteHeading: sessionLabels.inviteHeading,
        sessionLabels,
      });
    } catch (inviteErr) {
      return {
        mode: 'browser',
        session,
        otp,
        interviewUrl,
        inviteError: inviteErr.message,
        reply:
          `Interview session created for ${session.candidate_name}.\n` +
          `⚠️ Invite email could not be sent: ${inviteErr.message}\n` +
          `Share this link manually:\n${interviewUrl}`,
      };
    }
  }

  const when =
    payload.schedule_mode === 'now'
      ? 'now'
      : moment.tz(payload.scheduled_at, payload.timezone || DEFAULT_TZ).format('DD MMM YYYY, HH:mm');

  return {
    mode: 'browser',
    session,
    otp,
    interviewUrl,
    reply:
      `✅ Browser video interview scheduled (${when}).\n` +
      `Invite email sent to ${session.candidate_email}.\n` +
      `Candidate opens the link, verifies OTP, and starts the video interview.\n` +
      `Link: ${interviewUrl}`,
  };
}

async function fulfillBrowser(payload, recruiter, baseUrl) {
  const candidates = resolveCandidates(payload);
  if (candidates.length > 1) {
    const results = [];
    for (const candidate of candidates) {
      const singlePayload = {
        ...payload,
        candidate_name: candidate.name,
        candidate_email: candidate.email,
        candidate_phone: candidate.phone,
        candidates: [candidate],
        interview_type: INTERVIEW_TYPES.BROWSER_VIDEO,
      };
      results.push(await fulfillBrowserSingle(singlePayload, recruiter, baseUrl));
    }
    return {
      mode: 'browser',
      reply: results.map((r) => r.reply).join('\n\n'),
      sessions: results.map((r) => r.session).filter(Boolean),
    };
  }
  return fulfillBrowserSingle(
    { ...payload, interview_type: INTERVIEW_TYPES.BROWSER_VIDEO },
    recruiter,
    baseUrl
  );
}

/** Mission Hire schedule chat — browser video interviews only. */
export const scheduleChatFulfillmentService = {
  async fulfill(payload, recruiter, baseUrl) {
    if (payload.interview_type === INTERVIEW_TYPES.VOICE_CALL) {
      const err = new Error(
        'Phone/telephony interviews are no longer supported. Use browser video interviews.'
      );
      err.status = 400;
      throw err;
    }
    return fulfillBrowser(payload, recruiter, baseUrl);
  },
};
