function parseDetailsJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pushIssue(issues, issue) {
  issues.push({
    severity: issue.severity || 'error',
    category: issue.category || 'system',
    event_type: issue.event_type || null,
    message: issue.message,
    created_at: issue.created_at,
    details: issue.details || null,
  });
}

/**
 * Latest webhook delivery log from interview_end or webhook_retry entries.
 */
export function pickLatestWebhookLog(verificationLogs = []) {
  let latest = null;
  let latestMs = 0;

  for (const log of verificationLogs) {
    const details = parseDetailsJson(log.details_json);
    const webhook = details?.webhook;
    if (!webhook) continue;

    const ms = new Date(log.created_at).getTime();
    if (!Number.isNaN(ms) && ms >= latestMs) {
      latestMs = ms;
      latest = {
        ...webhook,
        source_event: log.event_type,
        source_success: log.success === 1 || log.success === true,
        logged_at: log.created_at,
      };
    }
  }

  return latest;
}

/**
 * Negative / error signals after assessment completion or termination.
 */
export function buildCompletionIssueLogs(session, verificationLogs = []) {
  const endedAtMs = session?.ended_at ? new Date(session.ended_at).getTime() : null;
  const completionWindowStart = endedAtMs && !Number.isNaN(endedAtMs) ? endedAtMs - 120_000 : null;
  const issues = [];

  for (const log of verificationLogs) {
    const createdMs = new Date(log.created_at).getTime();
    const details = parseDetailsJson(log.details_json);
    const isCompletionRelated =
      log.event_type === 'interview_end' ||
      log.event_type === 'webhook_retry' ||
      log.event_type === 'proctoring_terminated';

    if (completionWindowStart != null && !Number.isNaN(createdMs) && createdMs < completionWindowStart) {
      if (!isCompletionRelated) continue;
    }

    if (log.event_type === 'interview_end' && details) {
      if (details.merge_error) {
        pushIssue(issues, {
          category: 'recording',
          event_type: log.event_type,
          message: `Recording merge error: ${details.merge_error}`,
          created_at: log.created_at,
          details: { merge_error: details.merge_error, merge: details.merge || null },
        });
      } else if (details.merge?.error) {
        pushIssue(issues, {
          category: 'recording',
          event_type: log.event_type,
          message: `Recording merge error: ${details.merge.error}`,
          created_at: log.created_at,
          details: { merge: details.merge },
        });
      } else if (details.merge?.missingIndexes?.length || details.merge?.missingChunks?.length) {
        const missingList = details.merge.missingIndexes || details.merge.missingChunks;
        pushIssue(issues, {
          severity: 'warning',
          category: 'recording',
          event_type: log.event_type,
          message: `Recording merged with missing chunks: ${missingList.join(', ')}`,
          created_at: log.created_at,
          details: { merge: details.merge },
        });
      } else if (details.merge?.partial === true) {
        pushIssue(issues, {
          severity: 'warning',
          category: 'recording',
          event_type: log.event_type,
          message: 'Partial recording generated (gaps or incomplete merge)',
          created_at: log.created_at,
          details: { merge: details.merge },
        });
      }

      if (details.finalize_error) {
        pushIssue(issues, {
          category: 'summary',
          event_type: log.event_type,
          message: `Summary finalize error: ${details.finalize_error}`,
          created_at: log.created_at,
          details: { finalize_error: details.finalize_error },
        });
      }

      const feedback = details.feedback_email;
      if (feedback && feedback.sent === false) {
        pushIssue(issues, {
          category: 'summary',
          event_type: log.event_type,
          message: `Feedback email failed: ${feedback.error || feedback.reason || 'not sent'}`,
          created_at: log.created_at,
          details: { feedback_email: feedback },
        });
      }

      const webhook = details.webhook;
      if (webhook?.skipped === true) {
        pushIssue(issues, {
          severity: webhook.reason === 'no_callback' ? 'warning' : 'error',
          category: 'webhook',
          event_type: log.event_type,
          message: `Webhook skipped: ${webhook.reason || 'unknown'}${webhook.error ? ` — ${webhook.error}` : ''}`,
          created_at: log.created_at,
          details: { webhook },
        });
      } else if (webhook && (webhook.status === 'failed' || webhook.finalError || webhook.delivered === false)) {
        pushIssue(issues, {
          category: 'webhook',
          event_type: log.event_type,
          message: `Webhook delivery failed${webhook.finalError ? `: ${webhook.finalError}` : ''}`,
          created_at: log.created_at,
          details: { webhook },
        });
      }
    }

    if (log.event_type === 'webhook_retry') {
      const webhook = details?.webhook;
      if (!log.success || log.success === 0) {
        pushIssue(issues, {
          category: 'webhook',
          event_type: log.event_type,
          message: `Webhook retry failed${webhook?.finalError ? `: ${webhook.finalError}` : ''}`,
          created_at: log.created_at,
          details: { webhook },
        });
      }
    }

    if (!log.success && log.success !== 1 && log.event_type !== 'webhook_retry') {
      const alreadyLogged =
        log.event_type === 'interview_end' &&
        (details?.error || details?.merge_error || details?.finalize_error);
      if (!alreadyLogged) {
        pushIssue(issues, {
          category: 'system',
          event_type: log.event_type,
          message: details?.error || `${log.event_type} failed`,
          created_at: log.created_at,
          details,
        });
      } else if (log.event_type === 'interview_end' && details?.error) {
        pushIssue(issues, {
          category: 'system',
          event_type: log.event_type,
          message: details.error,
          created_at: log.created_at,
          details,
        });
      }
    }
  }

  issues.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return issues;
}
