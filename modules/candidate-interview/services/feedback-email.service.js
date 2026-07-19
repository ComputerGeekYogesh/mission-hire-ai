import db from '../../../config/db.js';
import { sendResultEmail } from '../../../mailer.js';
import { getAdminEmailById } from './overall-status.service.js';
import { questionRepository } from '../repositories/question.repository.js';
import { assessmentRatingLabel, interviewFeedbackStatusLabel } from './assessment.service.js';
import { buildAssessmentFeedbackEmailHtml } from './email-template.service.js';
import { feedbackEmailDebug, feedbackEmailDebugError } from './feedback-email-debug.service.js';
import { SCORE_SCALE } from './score-normalization.service.js';
import {
  assertMailConfigured,
  getFromEmail,
  mailErrorDetail,
  sendMail,
} from '../../../utils/smtp-mailer.js';
import { getApiFeedbackAdminEmail, getFeedbackCcEmail } from '../../../config/env.js';

function buildFeedbackCcList(adminEmail) {
  const cc = [];
  const admin = String(adminEmail || '').trim().toLowerCase();
  if (admin) cc.push(admin);
  const extra = getFeedbackCcEmail();
  if (extra && extra.toLowerCase() !== admin) cc.push(extra);
  return cc.length ? cc.join(', ') : undefined;
}

async function resolveFeedbackAdminEmail(session, meta = {}) {
  const envOverride = process.env.FEEDBACK_ADMIN_EMAIL?.trim();
  if (envOverride) {
    return { adminEmail: envOverride, recipientSource: 'FEEDBACK_ADMIN_EMAIL' };
  }

  if (meta.source === 'api') {
    const apiEmail = getApiFeedbackAdminEmail();
    if (!apiEmail) {
      throw new Error('Set API_FEEDBACK_ADMIN_EMAIL or TO_EMAIL in .env for API feedback emails.');
    }
    return {
      adminEmail: apiEmail,
      recipientSource: process.env.API_FEEDBACK_ADMIN_EMAIL?.trim()
        ? 'API_FEEDBACK_ADMIN_EMAIL'
        : 'TO_EMAIL',
    };
  }

  const userId = session.recruiter_id || Number(process.env.MOCK_INTERVIEW_DEFAULT_USER_ID || 1);
  let adminEmail = process.env.TO_EMAIL;
  let recipientSource = 'TO_EMAIL';
  const fetched = await getAdminEmailById(userId);
  if (fetched) {
    adminEmail = fetched;
    recipientSource = 'admins_table';
  }
  return { adminEmail, recipientSource, recruiter_id: userId };
}

/**
 * Ensure legacy `feedback` rows exist for dashboard overall_status (browser interviews).
 */
export async function syncBrowserFeedbackRows(session, mockCallId, callSid) {
  const qaRows = await questionRepository.listWithResponses(session.id);
  const answered = qaRows.filter((r) => r.response_id);
  if (!answered.length) return 0;

  const userId = session.recruiter_id || Number(process.env.MOCK_INTERVIEW_DEFAULT_USER_ID || 1);
  const accountId = session.company_id || null;

  let synced = 0;
  for (const row of answered) {
    const answerText = row.response_text || '';
    const score = row.score != null ? Number(row.score) : 0;
    const feedbackText = row.ai_feedback || '';

    if (row.feedback_id) {
      await db.query(
        `UPDATE feedback SET user_answer = ?, feedback = ?, score = ? WHERE id = ?`,
        [answerText, feedbackText, score, row.feedback_id]
      );
      synced += 1;
      continue;
    }

    const [fb] = await db.query(
      `INSERT INTO feedback (
        is_super_admin, job_id, user_email, contact, sid, user_id,
        question, user_answer, feedback, score, status, created_at, account_id
      ) VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), ?)`,
      [
        mockCallId,
        session.candidate_email,
        session.candidate_phone || session.candidate_email,
        callSid,
        userId,
        row.question_text,
        answerText,
        feedbackText,
        score,
        accountId,
      ]
    );
    await questionRepository.setFeedbackId(row.id, fb.insertId);
    synced += 1;
  }

  return synced;
}

/**
 * Send admin feedback email from browser interview responses (same format as phone mock-call).
 */
export async function sendBrowserInterviewFeedbackEmail(session, assessment, meta = {}) {
  const sessionId = session?.id;
  feedbackEmailDebug('send_start', {
    session_id: sessionId,
    candidate_email: session?.candidate_email || null,
    session_status: session?.status || null,
    meta_source: meta?.source || null,
    proctoring_terminated: assessment?.completion_type === 'terminated_due_to_proctoring_violation',
    completion_type: assessment?.completion_type || null,
    result_status: assessment?.result_status || null,
    has_smtp_user: Boolean(process.env.MAIL_USERNAME || process.env.SMTP_USER),
    has_from_email: Boolean(getFromEmail()),
  });

  try {
    const qaRows = await questionRepository.listWithResponses(session.id);
    const answered = qaRows.filter((r) => r.response_id);

    feedbackEmailDebug('answers_loaded', {
      session_id: sessionId,
      total_questions: qaRows.length,
      answered_count: answered.length,
    });

    try {
      assertMailConfigured();
    } catch {
      feedbackEmailDebug(
        'send_skipped',
        { session_id: sessionId, reason: 'mail_not_configured' },
        'warn'
      );
      return { skipped: true, reason: 'mail_not_configured' };
    }

    const answers = answered.length
      ? answered.map((r) => ({
          question: r.question_text,
          answer: r.response_text || '',
          feedback: interviewFeedbackStatusLabel(r.ai_feedback || '', session),
          score: r.score,
        }))
      : [
          {
            question: 'Interview completion status',
            answer: 'Candidate ended the call before answering interview questions.',
            feedback:
              assessment?.completion_type === 'terminated_due_to_proctoring_violation'
                ? 'Interview terminated due to proctoring violations. Review recording and proctoring timeline before any follow-up.'
                : 'Interview ended early. Recommend rescheduling or conducting a supervised follow-up evaluation.',
            score: 0,
          },
        ];

    const { adminEmail, recipientSource, recruiter_id } = await resolveFeedbackAdminEmail(session, meta);

    feedbackEmailDebug('recipient_resolved', {
      session_id: sessionId,
      admin_email: adminEmail || null,
      recipient_source: recipientSource,
      recruiter_id: recruiter_id ?? null,
      meta_source: meta?.source || null,
    });

    const candidateEmail = String(session.candidate_email || '').trim().toLowerCase();
    if (!candidateEmail) {
      feedbackEmailDebug(
        'send_skipped',
        { session_id: sessionId, reason: 'no_candidate_email' },
        'warn'
      );
      return { skipped: true, reason: 'no_candidate_email' };
    }

    if (!adminEmail) {
      feedbackEmailDebug(
        'send_skipped',
        { session_id: sessionId, reason: 'no_admin_email' },
        'warn'
      );
      return { skipped: true, reason: 'no_admin_email' };
    }

    const contact = session.candidate_phone || session.candidate_email;
    const candidateName = session.candidate_name || 'Candidate';
    const isAssessment = meta.source === 'api';
    const subject = isAssessment ? 'Assessment Feedback' : 'Interview Feedback';
    const totalScore = answered.length
      ? assessment?.average_score_display ?? String(assessment?.average_score ?? '0')
      : '0.0';
    const passed = assessment?.result_status === 'Passed';
    const ratingLabel = isAssessment
      ? assessmentRatingLabel(assessment?.feedback_status)
      : interviewFeedbackStatusLabel(assessment?.feedback_status || '', session);

    const ccList = buildFeedbackCcList(adminEmail);

    feedbackEmailDebug('send_dispatch', {
      session_id: sessionId,
      channel: isAssessment ? 'smtp_assessment' : 'send_result_email_web',
      subject,
      to: candidateEmail,
      cc: ccList || adminEmail,
      admin_email: adminEmail,
      candidate_contact: contact,
      total_score: totalScore,
      rating_label: ratingLabel,
      answer_blocks: answers.length,
    });

    if (isAssessment) {
      const html = buildAssessmentFeedbackEmailHtml({
        candidateContact: contact,
        candidateName,
        totalScore,
        ratingLabel,
        answers,
        scoreScale: SCORE_SCALE,
      });

      feedbackEmailDebug('smtp_send_attempt', {
        session_id: sessionId,
        to: candidateEmail,
        cc: ccList || adminEmail,
        from: getFromEmail(),
        subject,
      });

      const smtpResponse = await sendMail({
        to: candidateEmail,
        toName: candidateName,
        subject,
        html,
        cc: ccList,
      });

      feedbackEmailDebug('send_success', {
        session_id: sessionId,
        channel: 'smtp_assessment',
        to: candidateEmail,
        cc: ccList || adminEmail,
        subject,
        message_id: smtpResponse?.messageId || null,
      });

      return { sent: true, subject, to: candidateEmail, cc: ccList || adminEmail, channel: 'smtp_assessment' };
    }

    feedbackEmailDebug('web_send_attempt', {
      session_id: sessionId,
      to: candidateEmail,
      cc: ccList || adminEmail,
      note: 'sendResultEmail errors are logged separately in mailer.js',
    });

    await sendResultEmail(
      candidateEmail,
      answers,
      totalScore,
      answered.length * 5,
      passed,
      assessment?.feedback_status || '',
      adminEmail,
      subject,
      { isAssessment, ratingLabel, candidateName, candidateContact: contact }
    );

    feedbackEmailDebug('send_success', {
      session_id: sessionId,
      channel: 'send_result_email_web',
      to: candidateEmail,
      cc: ccList || adminEmail,
      subject,
    });

    return {
      sent: true,
      subject,
      to: candidateEmail,
      cc: ccList || adminEmail,
      channel: 'send_result_email_web',
    };
  } catch (err) {
    feedbackEmailDebugError('send_failed', err, {
      session_id: sessionId,
      candidate_email: session?.candidate_email || null,
      meta_source: meta?.source || null,
      completion_type: assessment?.completion_type || null,
    });
    throw err;
  }
}
