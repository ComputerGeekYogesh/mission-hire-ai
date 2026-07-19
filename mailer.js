import dotenv from 'dotenv';
dotenv.config();

import { buildInterviewFeedbackEmailHtml } from './modules/candidate-interview/services/email-template.service.js';
import {
  assertMailConfigured,
  getFromEmail,
  getFromName,
  getReplyToEmail,
  mailErrorDetail,
  sendMail,
} from './utils/smtp-mailer.js';
import { getFeedbackCcEmail } from './config/env.js';

function buildFeedbackCcList(adminEmail) {
  const cc = [];
  const admin = String(adminEmail || '').trim().toLowerCase();
  if (admin) cc.push(admin);
  const extra = getFeedbackCcEmail();
  if (extra && extra.toLowerCase() !== admin) cc.push(extra);
  return cc.length ? cc.join(', ') : undefined;
}

export const sendResultEmail = async (
  candidateEmail,
  answers,
  totalScore,
  totalQuestions,
  passed,
  feedback_status,
  adminEmail,
  feedbackSubject = 'Interview Feedback',
  options = {}
) => {
  const isAssessment =
    options.isAssessment === true || feedbackSubject === 'Assessment Feedback';
  const ratingLabel =
    options.ratingLabel != null ? options.ratingLabel : feedback_status;
  const toEmail = String(candidateEmail || '').trim().toLowerCase();
  if (!toEmail || !toEmail.includes('@')) {
    throw new Error('Candidate email is required to send feedback');
  }

  const html = buildInterviewFeedbackEmailHtml({
    candidateContact: options.candidateContact || toEmail,
    candidateName: options.candidateName || 'Candidate',
    totalScore,
    ratingLabel,
    passed,
    answers,
    isAssessment,
  });

  try {
    await sendMail({
      to: toEmail,
      toName: options.candidateName || 'Candidate',
      subject: feedbackSubject,
      html,
      cc: buildFeedbackCcList(adminEmail),
    });
  } catch (error) {
    console.error('❌ Error sending feedback email:', mailErrorDetail(error));
    throw error;
  }
};

export const sendRescheduleEmail = async (toPhone, spokenTime) => {
  try {
    await sendMail({
      to: process.env.TO_EMAIL,
      toName: 'User',
      subject: `Interview Reschedule Request - ${toPhone}`,
      html: `
    <h2>Hi</h2>
    <p>The candidate with the phone number <strong>${toPhone}</strong> has requested to reschedule the interview.</p>
    <p><strong>Requested Time:</strong> ${spokenTime}</p>
    <p>Please reach out to the candidate to confirm the new interview time or suggest an alternative if this slot isn't available.</p>
    <br/>
    <p>Best regards,<br/>Mission Hire</p>`,
    });
  } catch (error) {
    console.error('❌ Error sending reschedule email:', mailErrorDetail(error));
  }
};

export const sendInterviewEmail = async (to, name) => {
  try {
    await sendMail({
      to,
      toName: name || 'User',
      subject: 'Interview Scheduled - L1 Round',
      html: `
    <h2>Interview Scheduled - L1 Round</h2>
    <p>Hi <strong>${name}</strong>,</p>
    <p>Your interview for the L1 round has been scheduled.</p>
    <p>You will receive a call shortly from Mission Hire.</p>
    <br/>
    <p>Best regards,<br/>Mission Hire</p>`,
    });
  } catch (error) {
    console.error('❌ Error sending interview email:', mailErrorDetail(error));
  }
};

export const sendMockInterviewScheduledEmail = async (
  adminEmail,
  feedbackUrl,
  candidate,
  scheduledAt
) => {
  const candidateName = candidate?.name || 'Candidate';
  const candidatePhone = candidate?.phone || 'N/A';

  try {
    await sendMail({
      to: adminEmail || process.env.TO_EMAIL,
      toName: 'Admin',
      subject: `Mock Interview Scheduled - ${candidateName}`,
      html: `
      <h2>Mock interview scheduled</h2>
      <p><strong>Candidate:</strong> ${candidateName}</p>
      <p><strong>Phone:</strong> ${candidatePhone}</p>
      <p><strong>Scheduled At:</strong> ${scheduledAt}</p>
      <p>You can review interview feedback from the admin portal link below:</p>
      <p><a href="${feedbackUrl}" target="_blank">${feedbackUrl}</a></p>
      <br/>
      <p>Best regards,<br/>Mission Hire</p>`,
    });
  } catch (error) {
    console.error('❌ Error sending mock interview schedule email:', mailErrorDetail(error));
  }
};

export const sendOtpEmail = async (email, otp, userName) => {
  assertMailConfigured();

  const toEmail = String(email || '').trim().toLowerCase();
  const htmlTemplate = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Mission Hire Login OTP</title>
        <style>
            body {
                font-family: Georgia, 'Times New Roman', serif;
                background: #0E0C14;
                margin: 0;
                padding: 24px 12px;
            }
            .email-container {
                max-width: 480px;
                margin: auto;
                background: #1E1B29;
                padding: 36px 28px 40px;
                border-radius: 16px;
                border: 1px solid #332E42;
                text-align: center;
            }
            .brand {
                font-family: Georgia, 'Times New Roman', serif;
                font-size: 26px;
                font-weight: 600;
                color: #D4A24E;
                letter-spacing: 0.04em;
                margin: 0 0 6px;
            }
            .brand-sub {
                font-family: Arial, Helvetica, sans-serif;
                font-size: 11px;
                letter-spacing: 0.14em;
                text-transform: uppercase;
                color: #7C90F0;
                margin: 0 0 28px;
            }
            h2 {
                margin: 0 0 18px;
                color: #F3EFE7;
                font-size: 20px;
                font-weight: 600;
            }
            h4 {
                margin: 0 0 8px;
                color: #F3EFE7;
                font-family: Arial, Helvetica, sans-serif;
                font-weight: 600;
                font-size: 16px;
            }
            p {
                color: #A69FB3;
                font-family: Arial, Helvetica, sans-serif;
                font-size: 15px;
                margin: 0 0 8px;
                line-height: 1.5;
            }
            .otp-box {
                margin: 28px auto;
                padding: 18px 36px;
                background: #D4A24E;
                color: #241B08;
                font-family: Arial, Helvetica, sans-serif;
                font-size: 34px;
                font-weight: bold;
                width: fit-content;
                border-radius: 12px;
                letter-spacing: 6px;
            }
            .footer {
                color: #736C82;
                font-family: Arial, Helvetica, sans-serif;
                font-size: 14px;
                margin-top: 32px;
            }
            .footer strong { color: #D4A24E; }
        </style>
    </head>
    <body>
        <div class="email-container">
            <p class="brand">Mission Hire</p>
            <p class="brand-sub">Video interview AI assistant</p>
            <h2>Your Login OTP</h2>
            <h4>Hello ${userName},</h4>
            <p>Your One-Time Password (OTP) for login is:</p>
            <div class="otp-box">${otp}</div>
            <div class="footer">
                Best regards,<br/>
                <strong>Mission Hire</strong>
            </div>
        </div>
    </body>
    </html>
    `;

  try {
    return await sendMail({
      to: toEmail,
      toName: userName || 'User',
      subject: 'Mission Hire Login OTP',
      html: htmlTemplate,
      replyTo: getReplyToEmail(),
    });
  } catch (error) {
    const detail = mailErrorDetail(error);
    console.error(`❌ OTP email failed for ${toEmail}:`, detail);
    throw new Error(`Could not send OTP email: ${detail}`);
  }
};

export const sendverifyOtpEmail = async (email, token, otp, name) => {
  const verifyLink = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;

  const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Verify Your Email — Mission Hire</title>
    <style>
            body {
                font-family: Georgia, 'Times New Roman', serif;
                background: #0E0C14;
                margin: 0;
                padding: 24px 12px;
            }
            .email-container {
                max-width: 480px;
                margin: auto;
                background: #1E1B29;
                padding: 36px 28px 40px;
                border-radius: 16px;
                border: 1px solid #332E42;
                text-align: center;
            }
            .brand {
                font-size: 26px;
                font-weight: 600;
                color: #D4A24E;
                letter-spacing: 0.04em;
                margin: 0 0 6px;
            }
            .brand-sub {
                font-family: Arial, Helvetica, sans-serif;
                font-size: 11px;
                letter-spacing: 0.14em;
                text-transform: uppercase;
                color: #7C90F0;
                margin: 0 0 28px;
            }
            h2 {
                margin: 0 0 18px;
                color: #F3EFE7;
                font-size: 20px;
                font-weight: 600;
            }
            h4 {
                margin: 0 0 8px;
                color: #F3EFE7;
                font-family: Arial, Helvetica, sans-serif;
                font-weight: 600;
                font-size: 16px;
            }
            p {
                color: #A69FB3;
                font-family: Arial, Helvetica, sans-serif;
                font-size: 15px;
                margin: 0 0 8px;
                line-height: 1.5;
            }
            .otp-box {
                margin: 28px auto;
                padding: 18px 36px;
                background: #D4A24E;
                color: #241B08;
                font-family: Arial, Helvetica, sans-serif;
                font-size: 34px;
                font-weight: bold;
                width: fit-content;
                border-radius: 12px;
                letter-spacing: 6px;
            }
            .footer {
                color: #736C82;
                font-family: Arial, Helvetica, sans-serif;
                font-size: 14px;
                margin-top: 32px;
            }
            .footer strong { color: #D4A24E; }
        </style>
</head>
<body>
    <div class="email-container">
        <p class="brand">Mission Hire</p>
        <p class="brand-sub">Video interview AI assistant</p>
        <h2>Your Email Verification OTP</h2>
        <h4>Hello ${name},</h4>
        <p>Thank you for registering with Mission Hire. Please use the OTP below to verify your email address:</p>
        <div class="otp-box">${otp}</div>
        <a href="${verifyLink}"
            style="
                display:inline-block;
                background:#D4A24E;
                color:#241B08;
                text-decoration:none;
                padding:12px 24px;
                border-radius:10px;
                margin-top:10px;
                font-family:Arial,Helvetica,sans-serif;
                font-weight:600;
            ">
            Verify Email
        </a>
        <p style="margin-top:20px; font-size:0.9em; color:#736C82;">
            Note: This OTP is valid for the next 1 hour. If you didn't request this, please ignore this email.
        </p>
        <div class="footer">
            Best regards,<br/>
            <strong>Mission Hire</strong>
        </div>
    </div>
</body>
</html>
`;

  try {
    await sendMail({
      to: email,
      toName: name || 'User',
      subject: 'Mission Hire — verify your email',
      html: htmlTemplate,
    });
  } catch (error) {
    console.error('❌ Error sending verify OTP email:', mailErrorDetail(error));
    throw error;
  }
};

export { getFromEmail, getFromName, getReplyToEmail };
