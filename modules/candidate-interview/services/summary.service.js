import db from '../../../config/db.js';
import { recordBrowserInterviewOverallStatus } from './overall-status.service.js';
import { summaryRepository } from '../repositories/summary.repository.js';
import { flagRepository } from '../repositories/flag.repository.js';
import { questionRepository } from '../repositories/question.repository.js';
import { mockCallBridge } from './mock-call-bridge.service.js';
import { buildAssessmentSummary, isProctoringTerminatedSession } from './assessment.service.js';
import { generateMissionVerdictForVideoAssessment } from './mission-verdict.service.js';
import { proctoringViolationService } from './proctoring-violation.service.js';
import { integrityService } from './integrity.service.js';
import {
  syncBrowserFeedbackRows,
  sendBrowserInterviewFeedbackEmail,
} from './feedback-email.service.js';
import { feedbackEmailDebug, feedbackEmailDebugError } from './feedback-email-debug.service.js';
import { ensureSummaryColumns } from './summary-columns-migration.service.js';

const TERMINAL_STATUSES = new Set([
  'completed',
  'suspicious',
  'failed',
  'terminated_due_to_proctoring_violation',
  'cancelled',
]);

export function isTerminalSession(session) {
  if (!session) return false;
  if (session.ended_at) return true;
  return TERMINAL_STATUSES.has(String(session.status || '').toLowerCase());
}

/**
 * Persist dashboard overall_status for browser video interviews.
 */
export const summaryService = {
  async ensureSessionSummary(session) {
    if (!session?.id) return null;
    const existing = await summaryRepository.findBySession(session.id);
    if (existing) return existing;
    if (!isTerminalSession(session)) return null;
    try {
      await this.finalizeInterview(session);
      return await summaryRepository.findBySession(session.id);
    } catch (err) {
      console.error(`[summary] ensureSessionSummary failed for session ${session.id}:`, err.message);
      return null;
    }
  },

  async finalizeInterview(session) {
    await ensureSummaryColumns();
    let meta = {};
    try {
      meta =
        typeof session.metadata_json === 'string'
          ? JSON.parse(session.metadata_json)
          : session.metadata_json || {};
    } catch {
      meta = {};
    }

    const mockCallId = meta.mock_call_id || mockCallBridge.buildCallId(session.id);
    const callSid = meta.call_sid || mockCallBridge.buildCallSid(session.id);
    const answered = await questionRepository.countAnswered(session.id);
    const qaRows = await questionRepository.listWithResponses(session.id);
    const answeredRows = qaRows.filter((r) => r.response_id);
    const responsePayload = answeredRows.map((r) => ({
      question_id: r.id,
      question_text: r.question_text,
      score: r.score,
      ai_feedback: r.ai_feedback,
      response_text: r.response_text,
      category: r.category,
      skill: r.category,
    }));

    const proctoringReport = proctoringViolationService.buildReport(session);
    const integrityReport = integrityService.buildReport(session);
    const proctoringTerminated =
      isProctoringTerminatedSession(session) || proctoringReport.terminated === true;

    feedbackEmailDebug('finalize_start', {
      session_id: session.id,
      session_status: session.status,
      proctoring_terminated: proctoringTerminated,
      answered_count: answered,
      meta_source: meta?.source || null,
    });

    const assessment = buildAssessmentSummary(responsePayload, {
      session,
      proctoringReport,
    });

    feedbackEmailDebug('assessment_built', {
      session_id: session.id,
      completion_type: assessment?.completion_type || null,
      result_status: assessment?.result_status || null,
      feedback_status: assessment?.feedback_status || null,
    });

    let syncedRows = 0;
    try {
      syncedRows = await syncBrowserFeedbackRows(session, mockCallId, callSid);
      feedbackEmailDebug('feedback_rows_synced', {
        session_id: session.id,
        synced_rows: syncedRows,
      });
    } catch (syncErr) {
      feedbackEmailDebugError('feedback_rows_sync_failed', syncErr, {
        session_id: session.id,
      });
    }

    await recordBrowserInterviewOverallStatus({
      session,
      mockCallId,
      callSid,
      assessment,
      proctoringTerminated,
    }).catch((err) => {
      console.error('[summary] overall_status save failed (continuing with summary upsert):', err.message);
    });

    let emailResult = null;
    try {
      feedbackEmailDebug('finalize_email_attempt', {
        session_id: session.id,
        proctoring_terminated: proctoringTerminated,
      });
      emailResult = await sendBrowserInterviewFeedbackEmail(session, assessment, meta);
      feedbackEmailDebug('finalize_email_result', {
        session_id: session.id,
        ...emailResult,
      });
    } catch (emailErr) {
      feedbackEmailDebugError('finalize_email_failed', emailErr, {
        session_id: session.id,
        proctoring_terminated: proctoringTerminated,
      });
    }

    const flags = await flagRepository.list({ session_id: session.id, limit: 100 });
    const mission = await generateMissionVerdictForVideoAssessment({
      session,
      assessment,
      qaRows: answeredRows,
      flags,
      proctoringReport,
      integrityReport,
      proctoringTerminated,
    });

    let questionPlan = meta.question_plan;
    if (typeof questionPlan === 'string') {
      try {
        questionPlan = JSON.parse(questionPlan);
      } catch {
        questionPlan = null;
      }
    }

    const summaryJson = {
      source: 'browser_in_app_interview',
      mock_call_id: mockCallId,
      call_sid: callSid,
      transport: 'browser',
      questions_answered: answered,
      question_plan: questionPlan,
      assessment,
      proctoring_terminated: proctoringTerminated,
      proctoring_report: proctoringTerminated ? proctoringReport : null,
      integrity_report: proctoringTerminated ? integrityReport : null,
      mission_verification: mission.verification || null,
      suspicious_events: flags.map((f) => ({
        type: f.flag_type,
        severity: f.severity,
        message: f.message,
        at: f.created_at,
      })),
      external_api: {
        user_call_summary: `/api/v1/user-call-summary?job_id=${encodeURIComponent(mockCallId)}&contact=${encodeURIComponent(session.candidate_phone || '')}&email=${encodeURIComponent(session.candidate_email)}`,
      },
    };

    await summaryRepository.upsert({
      session_id: session.id,
      mock_call_id: mockCallId,
      call_sid: callSid,
      mission_verdict: mission.mission_verdict,
      mission_recommendations: mission.mission_recommendations,
      summary_json: summaryJson,
      duration_seconds: session.duration_seconds,
    });

    return { mockCallId, callSid, mission, summaryJson, emailResult };
  },

  async getExportPayload(sessionId) {
    const [rows] = await db.query(`SELECT * FROM interview_sessions WHERE id = ?`, [sessionId]);
    const s = rows[0];
    if (!s) return null;
    const summary = await summaryRepository.findBySession(sessionId);
    const questions = await questionRepository.listBySession(sessionId);
    const [responses] = await db.query(
      `SELECT * FROM interview_question_responses WHERE session_id = ? ORDER BY answered_at ASC`,
      [sessionId]
    );
    const flags = await flagRepository.list({ session_id: sessionId, limit: 200 });
    let summaryJson = summary?.summary_json;
    if (typeof summaryJson === 'string') {
      try {
        summaryJson = JSON.parse(summaryJson);
      } catch {
        summaryJson = null;
      }
    }
    return {
      session: s,
      summary: summary ? { ...summary, summary_json: summaryJson } : null,
      questions,
      responses,
      flags,
      exported_at: new Date().toISOString(),
    };
  },
};
