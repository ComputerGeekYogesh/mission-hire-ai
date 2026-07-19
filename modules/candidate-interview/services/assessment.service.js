/**
 * Same pass/hold/reject bands as handleCallEnd.js (mock-call pipeline).
 * Used only for normally completed assessments — not proctoring terminations.
 */
import {
  SCORE_SCALE,
  PASS_SCORE_THRESHOLD,
  calculateTotalScoreFromResponses,
  formatScoreDisplay,
} from './score-normalization.service.js';
import {
  SESSION_TYPES,
  resolveSessionLabelsFromSession,
  resolveSessionLabels,
  getSessionTypeFromSession,
} from '../lib/session-labels.js';

/** Map stored feedback_status to interview-friendly labels when applicable. */
export function interviewFeedbackStatusLabel(feedbackStatus, session = null) {
  const labels = session
    ? resolveSessionLabelsFromSession(session)
    : resolveSessionLabels(SESSION_TYPES.INTERVIEW);
  let s = String(feedbackStatus || '').trim();
  if (labels.type !== SESSION_TYPES.INTERVIEW) return s;
  return s
    .replace(/Assessment Invalidated/gi, 'Interview Invalidated')
    .replace(/Assessment terminated/gi, 'Interview terminated')
    .replace(/Assessment ended/gi, 'Interview ended')
    .replace(/assessment guidelines/gi, 'interview guidelines')
    .replace(/\bassessment\b/gi, (m, offset, str) => {
      const before = str.slice(Math.max(0, offset - 20), offset).toLowerCase();
      if (before.includes('skill')) return m;
      return 'interview';
    });
}

export function feedbackStatusFromAverage(averageScore) {
  const avg = Number(averageScore) || 0;
  const ratio = SCORE_SCALE > 0 ? avg / SCORE_SCALE : 0;
  if (ratio < 0.4) return 'Poor - Rejected';
  if (ratio < 0.6) return 'Below Average - On Hold';
  if (ratio < 0.8) return 'Average - Hire';
  if (ratio < 1) return 'Above Average - Hire';
  return 'Good - Hire';
}

/** Assessment emails use the band only (e.g. "Poor"), not hiring verdict suffixes. */
export function assessmentRatingLabel(feedbackStatus) {
  const s = String(feedbackStatus || '').trim();
  const dash = s.indexOf(' - ');
  return dash > 0 ? s.slice(0, dash).trim() : s;
}

export function resultStatusFromAverage(averageScore, callStatus = 'completed') {
  if (callStatus !== 'completed') return 'Failed';
  return Number(averageScore) >= PASS_SCORE_THRESHOLD ? 'Passed' : 'Failed';
}

export const ASSESSMENT_COMPLETION = Object.freeze({
  COMPLETED: 'completed',
  TERMINATED_PROCTORING: 'terminated_due_to_proctoring_violation',
});

export function isProctoringTerminatedSession(session) {
  if (!session) return false;
  if (session.status === 'terminated_due_to_proctoring_violation') return true;
  try {
    const meta =
      typeof session.metadata_json === 'string'
        ? JSON.parse(session.metadata_json)
        : session.metadata_json || {};
    return (
      meta.assessment_status === ASSESSMENT_COMPLETION.TERMINATED_PROCTORING ||
      meta.proctoring?.terminated === true ||
      meta.termination_reason === ASSESSMENT_COMPLETION.TERMINATED_PROCTORING
    );
  } catch {
    return false;
  }
}

function buildScoredSummary(responses = []) {
  const scored = responses.filter((r) => r.score != null && r.score !== '');

  const perQuestion = scored.map((r, i) => ({
    order: i + 1,
    question_id: r.question_id,
    question_text: r.question_text,
    score: Number(r.score) || 0,
    skill: r.skill || r.category || null,
    feedback: r.ai_feedback,
    transcript_preview: (r.response_text || '').slice(0, 200),
  }));

  const totalQuestions = perQuestion.length;
  const averageScore = calculateTotalScoreFromResponses(
    perQuestion.map((r) => ({
      score: r.score,
      skill: r.skill,
      category: r.skill,
    })),
    SCORE_SCALE
  );
  const totalScore = perQuestion.reduce((sum, r) => sum + (Number(r.score) || 0), 0);

  return {
    total_questions: totalQuestions,
    total_score: totalScore,
    average_score: Math.round(averageScore),
    average_score_display: formatScoreDisplay(averageScore, SCORE_SCALE),
    per_question: perQuestion,
  };
}

/**
 * Outcome when the assessment was ended for integrity/proctoring — not a skill evaluation.
 */
export function buildProctoringTerminatedAssessment(
  responses = [],
  proctoringReport = {},
  { session = null } = {}
) {
  const scored = buildScoredSummary(responses);
  const warningCount = proctoringReport.warning_count || 0;
  const violations = proctoringReport.violations || proctoringReport.timeline || [];
  const labels = session
    ? resolveSessionLabelsFromSession(session)
    : resolveSessionLabels(SESSION_TYPES.INTERVIEW);
  const isInterview = labels.type === SESSION_TYPES.INTERVIEW;
  const noun = isInterview ? 'interview' : 'assessment';
  const Noun = isInterview ? 'Interview' : 'Assessment';

  return {
    ...scored,
    completion_type: ASSESSMENT_COMPLETION.TERMINATED_PROCTORING,
    assessment_outcome: 'invalidated',
    result_status: 'Terminated',
    feedback_status: `${Noun} Invalidated - Integrity Violation`,
    outcome_label: `Terminated Due To Proctoring Violation`,
    outcome_summary: `The ${noun} was terminated after repeated suspicious activity was detected despite formal warnings. This outcome reflects session integrity, not candidate skill or knowledge performance.`,
    pass_threshold: PASS_SCORE_THRESHOLD,
    scoring_scale: `0–${SCORE_SCALE} per question (scores prior to termination are partial and not valid for pass/fail)`,
    scores_are_partial: scored.total_questions > 0,
    proctoring_summary: {
      warning_count: warningCount,
      risk_score: proctoringReport.risk_score ?? proctoringReport.effective_score ?? null,
      confidence_score: proctoringReport.confidence_score ?? null,
      integrity_status: proctoringReport.integrity_status ?? null,
      violation_count: violations.length,
      primary_violations: violations.slice(-5).map((v) => ({
        type: v.type,
        label: v.label || v.violation_label || v.type,
        at: v.at,
        message: v.message,
      })),
    },
  };
}

export function buildAssessmentSummary(responses = [], { session = null, proctoringReport = null } = {}) {
  const scored = buildScoredSummary(responses);

  if (isProctoringTerminatedSession(session) || proctoringReport?.terminated) {
    return buildProctoringTerminatedAssessment(responses, proctoringReport || {}, { session });
  }

  const averageScore = scored.total_questions > 0 ? scored.average_score : 0;

  return {
    ...scored,
    completion_type: ASSESSMENT_COMPLETION.COMPLETED,
    assessment_outcome: 'evaluated',
    average_score: Math.round(averageScore),
    average_score_display: formatScoreDisplay(averageScore, SCORE_SCALE),
    feedback_status: feedbackStatusFromAverage(averageScore),
    result_status: resultStatusFromAverage(averageScore),
    pass_threshold: PASS_SCORE_THRESHOLD,
    scoring_scale: `0–${SCORE_SCALE} per question (GPT-4o-mini)`,
    scores_are_partial: false,
  };
}
