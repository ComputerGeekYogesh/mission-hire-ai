import {
  deliverVideoInterviewWebhook,
  buildWebhookPayloadFromSession,
} from './api-webhook.service.js';
import { isProctoringTerminatedSession } from './assessment.service.js';

function parseMetadata(session) {
  try {
    return typeof session.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session.metadata_json || {};
  } catch {
    return {};
  }
}

export function isApiTriggeredSession(session) {
  const meta = parseMetadata(session);
  return meta.source === 'api';
}

export function hasCompletionWebhook(session) {
  const meta = parseMetadata(session);
  const url = meta.callback?.webhook_url;
  const secret = meta.callback?.webhook_secret;
  return Boolean(url && secret);
}

/**
 * After browser interview completes: POST callback webhook when configured.
 */
export const apiCompletionService = {
  async onInterviewCompleted(session, options = {}) {
    const meta = parseMetadata(session);
    const proctoringTerminated =
      options.proctoringTerminated === true ||
      isProctoringTerminatedSession(session);

    const overrideUrl = (options.webhookUrl || '').trim();
    const overrideSecret = (options.webhookSecret || '').trim();
    const hasOverrideTarget = Boolean(overrideUrl);
    const canDeliver =
      hasOverrideTarget ||
      hasCompletionWebhook(session);

    if (!canDeliver) {
      console.log(
        `[api-completion] Skipping webhook session=${session?.id} source=${meta.source || 'unknown'} reason=no_callback has_url=${Boolean(meta.callback?.webhook_url)} has_secret=${Boolean(meta.callback?.webhook_secret)}`
      );
      return { skipped: true, reason: 'no_callback' };
    }

    if (hasOverrideTarget && !overrideSecret && !meta.callback?.webhook_secret) {
      return {
        skipped: true,
        reason: 'missing_secret',
        error: 'Webhook secret is required when resending to a custom URL',
        proctoringTerminated,
      };
    }

    try {
      const { webhookPayload, media } = await buildWebhookPayloadFromSession(session, {
        feedbackEmailResult: options.emailResult || null,
      });

      const targetUrl = overrideUrl || meta.callback?.webhook_url;
      console.log(
        `[api-completion] Interview ended — dispatching webhook session=${session.id} email=${session.candidate_email} source=${meta.source || 'unknown'} assessment_termination=${webhookPayload?.assessment_termination === true} proctoring_terminated=${proctoringTerminated} url=${targetUrl} recording_backend=${webhookPayload?.recording?.storage_backend || webhookPayload?.recording?.status || 'n/a'} feedback_email_sent=${webhookPayload?.feedback_email?.sent === true}${hasOverrideTarget ? ' manual_resend=1' : ''}`
      );

      const delivery = await deliverVideoInterviewWebhook(session, webhookPayload, {
        webhookUrl: overrideUrl || undefined,
        webhookSecret: overrideSecret || undefined,
        manualResend: hasOverrideTarget,
      });
      return { webhookPayload, media, delivery, proctoringTerminated };
    } catch (err) {
      console.error(
        `[api-completion] Webhook pipeline failed session=${session?.id}:`,
        err.message
      );
      return {
        skipped: true,
        reason: 'pipeline_error',
        error: err.message,
        proctoringTerminated,
      };
    }
  },
};
