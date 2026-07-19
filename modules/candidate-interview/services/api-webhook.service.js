import axios from 'axios';
import moment from 'moment-timezone';
import {
  buildAssessmentSummary,
  isProctoringTerminatedSession,
} from './assessment.service.js';
import { summaryRepository } from '../repositories/summary.repository.js';
import { questionRepository } from '../repositories/question.repository.js';
import { buildInterviewMediaWebhookSections } from './webhook-media-payload.service.js';
import { proctoringViolationService } from './proctoring-violation.service.js';
import { integrityService } from './integrity.service.js';
import { recordingMetadataRepository } from '../repositories/recording-metadata.repository.js';
import { flagRepository } from '../repositories/flag.repository.js';
import {
  generateMissionVerdictForVideoAssessment,
  missionVerdictNeedsRegeneration,
} from './mission-verdict.service.js';

const MAX_WEBHOOK_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const REQUEST_TIMEOUT_MS = 30_000;

function parseMetadata(session) {
  try {
    return typeof session.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session.metadata_json || {};
  } catch {
    return {};
  }
}

function buildQaPayload(meta, qaRows) {
  const apiQuestions = meta.interview?.questions || [];
  const byApiId = new Map(apiQuestions.map((q) => [Number(q.question_id), q]));

  const ordered = [...qaRows].sort((a, b) => a.question_order - b.question_order);

  return ordered.map((row, idx) => {
    const apiQ = byApiId.get(Number(apiQuestions[idx]?.question_id)) || apiQuestions[idx];
    return {
      question_id: apiQ?.question_id ?? row.id ?? idx + 1,
      skill: apiQ?.skill || row.category || '',
      question: row.question_text || apiQ?.question || '',
      answer: row.response_text || '',
      ai_feedback: row.ai_feedback || '',
      ai_score: row.score != null ? Number(row.score) : 0,
    };
  });
}

function buildFeedbackEmailPayload(emailResult) {
  if (!emailResult) return null;
  return {
    sent: emailResult.sent === true,
    skipped: emailResult.skipped === true,
    reason: emailResult.reason || null,
    to: emailResult.to || null,
    cc: emailResult.cc || emailResult.adminEmail || null,
    admin_email: emailResult.cc || emailResult.adminEmail || null,
    subject: emailResult.subject || null,
    channel: emailResult.channel || null,
  };
}

export function buildVideoInterviewWebhookPayload(
  session,
  {
    mission,
    assessment,
    qaRows = [],
    media = null,
    proctoringReport = null,
    integrityReport = null,
    feedbackEmailResult = null,
  }
) {
  const meta = parseMetadata(session);
  const proctoringTerminated =
    assessment?.completion_type === 'terminated_due_to_proctoring_violation' ||
    isProctoringTerminatedSession(session) ||
    proctoringReport?.terminated === true;

  const resultStatus = proctoringTerminated
    ? 'Terminated'
    : assessment?.result_status === 'Passed'
      ? 'Passed'
      : 'Failed';

  const payload = {
    success: true,
    assessment_termination: proctoringTerminated,
    mission_verdict: mission?.mission_verdict || '',
    mission_recommendations: Array.isArray(mission?.mission_recommendations) ? mission.mission_recommendations : [],
    email: session.candidate_email,
    session_id: session.id,
    session_token: session.session_token,
    video_interview: {
      status: proctoringTerminated ? 'terminated' : 'completed',
      completion_type: assessment?.completion_type || (proctoringTerminated ? 'terminated_due_to_proctoring_violation' : 'completed'),
      result_status: resultStatus,
      feedback_status: assessment?.feedback_status || '',
      outcome_label: assessment?.outcome_label || assessment?.feedback_status || '',
      assessment_outcome: assessment?.assessment_outcome || (proctoringTerminated ? 'invalidated' : 'evaluated'),
      total_score: proctoringTerminated
        ? String(assessment?.average_score_display ?? assessment?.average_score ?? '0')
        : String(assessment?.average_score_display ?? assessment?.average_score ?? '0'),
      scores_are_partial: assessment?.scores_are_partial === true,
      proctoring_terminated: proctoringTerminated,
    },
    qa: buildQaPayload(meta, qaRows),
    feedback_email: buildFeedbackEmailPayload(feedbackEmailResult),
  };

  if (proctoringTerminated) {
    payload.proctoring = {
      terminated: true,
      termination_reason: 'terminated_due_to_proctoring_violation',
      outcome_summary:
        assessment?.outcome_summary ||
        'Assessment terminated due to repeated suspicious activity after formal warnings. Not a skill evaluation outcome.',
      warning_count: proctoringReport?.warning_count ?? assessment?.proctoring_summary?.warning_count ?? 0,
      risk_score: proctoringReport?.risk_score ?? null,
      confidence_score: proctoringReport?.confidence_score ?? null,
      integrity_status: proctoringReport?.integrity_status ?? null,
      violations: (proctoringReport?.timeline || proctoringReport?.violations || []).slice(-12),
      integrity: integrityReport
        ? {
            integrity_score: integrityReport.integrity_score,
            risk_level: integrityReport.risk_level,
            hiring_risk_level: integrityReport.hiring_risk_level,
            identity_confidence: integrityReport.identity_confidence,
            liveness_confidence: integrityReport.liveness_confidence,
          }
        : null,
    };
  }

  if (media) {
    payload.flags = media.flags;
    payload.snapshots = media.snapshots;
    payload.recording = media.recording;
  }

  return payload;
}

function measurePayloadBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return 0;
  }
}

function formatPayloadSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function postWebhookAttempt(url, secret, payload, attempt) {
  const started = Date.now();
  const timestamp = new Date().toISOString();
  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': secret,
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
    const elapsed = Date.now() - started;
    let responseBody = null;
    try {
      responseBody =
        typeof response.data === 'object' && response.data !== null
          ? response.data
          : response.data != null
            ? { body: String(response.data).slice(0, 2000) }
            : null;
    } catch {
      responseBody = null;
    }
    const ok = response.status >= 200 && response.status < 300;
    console.log(
      `[api-webhook] session=${payload?.email || '?'} attempt=${attempt}/${MAX_WEBHOOK_ATTEMPTS} status=${response.status} elapsed=${elapsed}ms`
    );
    return {
      ok,
      status: response.status,
      statusText: response.statusText || '',
      durationMs: elapsed,
      timestamp,
      responseBody,
      payload,
      success: ok,
    };
  } catch (err) {
    const elapsed = Date.now() - started;
    console.error(
      `[api-webhook] attempt=${attempt} failed elapsed=${elapsed}ms:`,
      err.message
    );
    return {
      ok: false,
      status: err.response?.status || 0,
      statusText: err.response?.statusText || '',
      durationMs: elapsed,
      timestamp,
      error: err.message,
      responseBody: err.response?.data ?? null,
      payload,
      success: false,
    };
  }
}

/**
 * POST completion summary to callback URL with up to 3 retries (2s, 5s, 10s backoff).
 */
export async function deliverVideoInterviewWebhook(session, webhookPayload, options = {}) {
  const meta = parseMetadata(session);
  const url = (options.webhookUrl || meta.callback?.webhook_url || '').trim();
  const secret = (options.webhookSecret || meta.callback?.webhook_secret || '').trim();
  if (!url || !secret) {
    console.warn(`[api-webhook] No callback configured for session ${session.id}`);
    return { delivered: false, reason: 'no_callback', attempts: [], targetUrl: url || null };
  }

  const isManualResend = Boolean(options.webhookUrl || options.manualResend);

  console.log(
    `[api-webhook] Dispatching completion webhook session=${session.id} email=${webhookPayload?.email || '?'} url=${url}${isManualResend ? ' (manual resend)' : ''}`
  );
  const payloadBytes = measurePayloadBytes(webhookPayload);
  console.log(
    `[api-webhook] Payload size: ${formatPayloadSize(payloadBytes)} (${payloadBytes} bytes) session=${session.id} telemetry=excluded`
  );
  if (payloadBytes > 900_000) {
    console.warn(
      `[api-webhook] Large webhook payload (${formatPayloadSize(payloadBytes)}) for session ${session.id} — verify receiver limit`
    );
  }

  const attemptLog = [];
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_WEBHOOK_ATTEMPTS; attempt++) {
    const result = await postWebhookAttempt(url, secret, webhookPayload, attempt);
    attemptLog.push({
      attempt,
      timestamp: result.timestamp,
      status: result.status || null,
      statusText: result.statusText || null,
      durationMs: result.durationMs,
      success: result.success,
      error: result.error || null,
      responseBody: result.responseBody ?? null,
      payload: webhookPayload,
    });

    if (result.ok) {
      console.log(`[api-webhook] Webhook delivered successfully (session ${session.id})`);
      await recordingMetadataRepository.updateBySessionId(session.id, {
        webhook_sent_at: moment().format('YYYY-MM-DD HH:mm:ss'),
        webhook_status: 'delivered',
      }).catch((err) => {
        console.warn('[api-webhook] Failed to update recording metadata webhook status:', err.message);
      });
      return {
        delivered: true,
        attempts: attempt,
        status: result.status,
        attemptLog,
        savedAt: new Date().toISOString(),
        statusLabel: 'success',
        targetUrl: url,
        manualResend: isManualResend,
      };
    }

    lastError = result.error || `HTTP ${result.status}: ${result.statusText || 'Failed'}`;
    if (attempt < MAX_WEBHOOK_ATTEMPTS) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 2000;
      console.log(
        `[api-webhook] Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_WEBHOOK_ATTEMPTS})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.error(`[api-webhook] Webhook delivery failed after ${MAX_WEBHOOK_ATTEMPTS} attempts (session ${session.id})`);
  await recordingMetadataRepository.updateBySessionId(session.id, {
    webhook_sent_at: moment().format('YYYY-MM-DD HH:mm:ss'),
    webhook_status: 'failed',
  }).catch(() => {});
  return {
    delivered: false,
    attempts: MAX_WEBHOOK_ATTEMPTS,
    attemptLog,
    finalError: lastError,
    savedAt: new Date().toISOString(),
    statusLabel: 'failed',
    targetUrl: url,
    manualResend: isManualResend,
  };
}

export async function buildWebhookPayloadFromSession(session, options = {}) {
  const summary = await summaryRepository.findBySession(session.id);
  let mission = {
    mission_verdict: summary?.mission_verdict || null,
    mission_recommendations: [],
  };
  if (summary?.mission_recommendations) {
    try {
      mission.mission_recommendations =
        typeof summary.mission_recommendations === 'string'
          ? JSON.parse(summary.mission_recommendations)
          : summary.mission_recommendations;
    } catch {
      mission.mission_recommendations = [];
    }
  }

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
    question_order: r.question_order,
  }));

  const proctoringReport = proctoringViolationService.buildReport(session);
  const integrityReport = integrityService.buildReport(session);

  const assessment = buildAssessmentSummary(responsePayload, {
    session,
    proctoringReport,
  });

  const proctoringTerminated =
    assessment?.completion_type === 'terminated_due_to_proctoring_violation' ||
    isProctoringTerminatedSession(session) ||
    proctoringReport?.terminated === true;

  if (
    !proctoringTerminated &&
    mission.mission_verdict &&
    missionVerdictNeedsRegeneration(mission.mission_verdict, { proctoringTerminated: false })
  ) {
    console.warn(
      `[api-webhook] Regenerating stale Mission Hire verdict (false termination or assessment language) session=${session.id}`
    );
    const flags = await flagRepository.list({ session_id: session.id, limit: 100 });
    const regenerated = await generateMissionVerdictForVideoAssessment({
      session,
      assessment,
      qaRows: answeredRows,
      flags,
      proctoringReport,
      integrityReport,
      proctoringTerminated: false,
    });
    if (regenerated?.mission_verdict) {
      mission = {
        mission_verdict: regenerated.mission_verdict,
        mission_recommendations: regenerated.mission_recommendations || [],
      };
      if (summary) {
        let summaryJson = summary.summary_json;
        if (typeof summaryJson === 'string') {
          try {
            summaryJson = JSON.parse(summaryJson);
          } catch {
            summaryJson = null;
          }
        }
        await summaryRepository.upsert({
          session_id: session.id,
          mock_call_id: summary.mock_call_id,
          call_sid: summary.call_sid,
          mission_verdict: mission.mission_verdict,
          mission_recommendations: mission.mission_recommendations,
          summary_json: summaryJson,
          duration_seconds: summary.duration_seconds,
        });
      }
    }
  }

  const meta = parseMetadata(session);
  const media = await buildInterviewMediaWebhookSections(session);
  const webhookPayload = buildVideoInterviewWebhookPayload(session, {
    mission,
    assessment,
    qaRows: answeredRows,
    media,
    proctoringReport,
    integrityReport,
    feedbackEmailResult: options.feedbackEmailResult || null,
  });

  return { webhookPayload, assessment, mission, media };
}
