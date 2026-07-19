import { buildAssessmentInviteEmailHtml } from './email-template.service.js';
import { assertMailConfigured, mailErrorDetail, sendMail } from '../../../utils/smtp-mailer.js';

/**
 * Sends interview invite email with secure link.
 */
export async function sendInterviewInviteEmail({
  to,
  name,
  interviewUrl,
  scheduledAt,
  jobTitle,
  inviteSubject = 'Interview Invitation',
  inviteHeading = 'Interview Invitation',
  sessionLabels = null,
}) {
  assertMailConfigured();

  const toEmail = String(to || '').trim().toLowerCase();
  if (!toEmail) {
    throw new Error('Candidate email is required to send interview invite.');
  }

  const html = buildAssessmentInviteEmailHtml({
    name,
    jobTitle,
    scheduledAt,
    interviewUrl,
    heading: inviteHeading,
    labels: sessionLabels,
  });

  try {
    const response = await sendMail({
      to: toEmail,
      toName: name || 'Candidate',
      subject: `${inviteSubject}${jobTitle ? ` - ${jobTitle}` : ''}`,
      html,
    });
    return { sent: true, to: toEmail, response };
  } catch (error) {
    const detail = mailErrorDetail(error);
    console.error(`❌ Interview invite failed for ${toEmail}:`, detail);
    throw new Error(`Could not send interview invite: ${detail}`);
  }
}
