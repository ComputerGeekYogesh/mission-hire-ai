import moment from 'moment-timezone';
import { sessionService } from '../services/session.service.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { flagRepository } from '../repositories/flag.repository.js';
import { recordingRepository } from '../repositories/recording.repository.js';
import { verificationRepository } from '../repositories/verification.repository.js';
import { telemetryRepository } from '../repositories/telemetry.repository.js';
import { snapshotRepository } from '../repositories/snapshot.repository.js';
import { validateSchedulePayload } from '../validators/session.validator.js';
import { SESSION_STATUS } from '../constants.js';
import { orchestratorService } from '../services/orchestrator.service.js';
import { buildListPageRange, parseListPagination } from '../lib/pagination.js';

function baseUrl(req) {
  return process.env.HOST_URL || `${req.protocol}://${req.get('host')}`;
}

function parseFilters(query) {
  return {
    status: query.status || null,
    recruiter_id: query.recruiter_id || null,
    job_id: query.job_id || null,
    interview_type: query.interview_type || null,
    date_from: query.date_from || null,
    date_to: query.date_to ? `${query.date_to} 23:59:59` : null,
    search: query.search || null,
    limit: query.limit,
    offset: query.offset,
  };
}

export const adminInterviewController = {
  async dashboard(req, res) {
    // Show all sessions (web + REST API); API-scheduled rows have no recruiter_id filter
    const filters = {};
    const stats = await sessionRepository.getDashboardStats(filters);
    const { rows: recent } = await sessionRepository.list({ ...filters, limit: 10 });
    res.render('modules/candidate-interview/admin/dashboard', {
      title: 'Interview Dashboard',
      currentPath: '/admin/interviews/dashboard',
      stats,
      recent,
      moment,
    });
  },

  async scheduled(req, res) {
    const { page, limit, offset } = parseListPagination(req.query, 25, 100);
    const filters = { ...parseFilters(req.query), limit, offset };
    const { rows, total } = await sessionRepository.list(filters);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const jobs = await sessionService.listJobsForSelect();
    res.render('modules/candidate-interview/admin/scheduled', {
      title: 'Scheduled Interviews',
      currentPath: '/admin/interviews/scheduled',
      sessions: rows,
      total,
      filters: req.query,
      jobs,
      statuses: Object.values(SESSION_STATUS),
      moment,
      currentPage: page,
      totalPages,
      pageRange: buildListPageRange(page, totalPages, 5),
      listOffset: offset,
      listLimit: limit,
    });
  },

  async active(req, res) {
    const { rows } = await sessionRepository.list({ active_only: true, limit: 100 });
    res.render('modules/candidate-interview/admin/active', {
      title: 'Active Interviews',
      currentPath: '/admin/interviews/active',
      sessions: rows,
      moment,
    });
  },

  async recordings(req, res) {
    const recordings = await recordingRepository.listForAdmin({
      search: req.query.search,
      session_id: req.query.session_id,
      limit: 50,
    });
    res.render('modules/candidate-interview/admin/recordings', {
      title: 'Interview Recordings',
      currentPath: '/admin/interviews/recordings',
      recordings,
      filters: req.query,
    });
  },

  async verificationLogs(req, res) {
    const logs = await verificationRepository.list({ limit: 100 });
    res.render('modules/candidate-interview/admin/verification-logs', {
      title: 'Verification Logs',
      currentPath: '/admin/interviews/verification-logs',
      logs,
      moment,
    });
  },

  async flags(req, res) {
    const flags = await flagRepository.list({
      severity: req.query.severity,
      unresolved_only: req.query.unresolved === '1',
      limit: 100,
    });
    res.render('modules/candidate-interview/admin/flags', {
      title: 'Suspicious Activity',
      currentPath: '/admin/interviews/flags',
      flags,
      filters: req.query,
      moment,
    });
  },

  async telemetry(req, res) {
    const { page, limit, offset } = parseListPagination(req.query, 50, 150);
    const { rows, total } = await telemetryRepository.listReports({
      suspicious_only: req.query.suspicious === '1',
      search: req.query.search || null,
      all_samples: req.query.all_samples === '1',
      limit,
      offset,
    });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.render('modules/candidate-interview/admin/telemetry', {
      title: 'Telemetry Reports',
      currentPath: '/admin/interviews/telemetry',
      rows,
      total,
      filters: req.query,
      moment,
      currentPage: page,
      totalPages,
      pageRange: buildListPageRange(page, totalPages, 5),
      listOffset: offset,
      listLimit: limit,
    });
  },

  async analytics(req, res) {
    const stats = await sessionRepository.getDashboardStats({});
    const { rows } = await sessionRepository.list({ limit: 200 });
    const byType = {};
    const byStatus = {};
    for (const s of rows) {
      byType[s.interview_type] = (byType[s.interview_type] || 0) + 1;
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    }
    res.render('modules/candidate-interview/admin/analytics', {
      title: 'Interview Analytics',
      currentPath: '/admin/interviews/analytics',
      stats,
      byType,
      byStatus,
    });
  },

  async scheduleForm(req, res) {
    const jobs = await sessionService.listJobsForSelect();
    res.render('modules/candidate-interview/admin/schedule', {
      title: 'Schedule Interview (Form)',
      currentPath: '/admin/interviews/schedule-form',
      jobs,
      success_msg: req.flash('success_msg'),
      error_msg: req.flash('error_msg'),
    });
  },

  async scheduleSubmit(req, res) {
    try {
      const payload = validateSchedulePayload(req.body);
      const recruiter = { user_id: req.session.user_id, company_id: req.session.company_id };
      const { session, otp } = await sessionService.scheduleInterview(payload, recruiter);

      let interviewUrl = null;
      if (payload.send_invite !== false) {
        interviewUrl = await sessionService.sendInvite(session, baseUrl(req));
      } else {
        interviewUrl = `${baseUrl(req)}/interview/${session.session_token}`;
      }

      if (process.env.NODE_ENV !== 'production') {
        req.flash('success_msg', `Interview scheduled. Dev OTP: ${otp} | Link: ${interviewUrl}`);
      } else {
        req.flash('success_msg', 'Interview scheduled and invite sent successfully.');
      }
      return res.redirect(`/admin/interviews/session/${session.id}`);
    } catch (err) {
      req.flash('error_msg', err.message);
      return res.redirect('/admin/interviews/schedule-form');
    }
  },

  async sessionDetail(req, res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('X-Interview-Admin-Layout', 'mission-admin-v2');

    const session = await sessionRepository.findById(req.params.id);
    if (!session) return res.status(404).send('Session not found');

    const { summaryRepository } = await import('../repositories/summary.repository.js');
    const { questionRepository } = await import('../repositories/question.repository.js');

    const [snapshots, telemetry, flags, recordings, verificationLogs, verificationLogsDetailed, mergedRecording, chunkRows, initialCallSummary, questions, qaDetail] =
      await Promise.all([
      snapshotRepository.listBySession(session.id, 50),
      telemetryRepository.listBySession(session.id, 100),
      flagRepository.list({ session_id: session.id, limit: 50 }),
      recordingRepository.listForAdmin({ session_id: session.id }),
      verificationRepository.list({ session_id: session.id, limit: 50 }),
      verificationRepository.listBySessionWithDetails(session.id, { limit: 100 }),
      recordingRepository.findMergedBySession(session.id),
      recordingRepository.listChunksBySession(session.id),
      summaryRepository.findBySession(session.id),
      questionRepository.listBySession(session.id),
      questionRepository.listWithResponses(session.id),
    ]);

    let callSummary = initialCallSummary;
    if (!callSummary) {
      const { summaryService, isTerminalSession } = await import('../services/summary.service.js');
      if (isTerminalSession(session)) {
        callSummary = await summaryService.ensureSessionSummary(session);
      }
    }

    let summaryParsed = callSummary?.summary_json;
    if (typeof summaryParsed === 'string') {
      try {
        summaryParsed = JSON.parse(summaryParsed);
      } catch {
        summaryParsed = null;
      }
    }
    let questionPlan = summaryParsed?.question_plan || null;
    let assessment = summaryParsed?.assessment || null;
    if (!questionPlan && session.metadata_json) {
      try {
        const meta =
          typeof session.metadata_json === 'string'
            ? JSON.parse(session.metadata_json)
            : session.metadata_json;
        questionPlan = meta?.question_plan || null;
      } catch {
        questionPlan = null;
      }
    }
    if (!assessment && qaDetail.length) {
      const { buildAssessmentSummary } = await import('../services/assessment.service.js');
      assessment = buildAssessmentSummary(
        qaDetail
          .filter((r) => r.response_id)
          .map((r) => ({
            question_id: r.id,
            question_text: r.question_text,
            score: r.score,
            ai_feedback: r.ai_feedback,
            response_text: r.response_text,
            category: r.category,
            skill: r.category,
          }))
      );
    }

    let missionRecs = callSummary?.mission_recommendations;
    if (typeof missionRecs === 'string') {
      try {
        missionRecs = JSON.parse(missionRecs);
      } catch {
        missionRecs = [];
      }
    }

    let skillBreakdown = [];
    try {
      const { buildSkillBreakdown } = await import('../services/scorecard-build.service.js');
      skillBreakdown = buildSkillBreakdown(qaDetail) || [];
    } catch {
      skillBreakdown = [];
    }

    const { buildFlagSummary } = await import('../services/flag-summary.service.js');
    const flagSummary = buildFlagSummary(flags);

    const { recordingMetadataRepository } = await import('../repositories/recording-metadata.repository.js');
    const recordingMetadata = await recordingMetadataRepository.findBySessionId(session.id);

    const { buildCompletionIssueLogs, pickLatestWebhookLog } = await import(
      '../services/session-completion-logs.service.js'
    );
    const { SCORE_SCALE } = await import('../services/score-normalization.service.js');

    const webhookLog = pickLatestWebhookLog(verificationLogsDetailed);
    const completionIssueLogs = buildCompletionIssueLogs(session, verificationLogsDetailed);

    let sessionMeta = null;
    try {
      sessionMeta =
        typeof session.metadata_json === 'string'
          ? JSON.parse(session.metadata_json)
          : session.metadata_json || null;
    } catch {
      sessionMeta = null;
    }
    const hasWebhookConfigured = Boolean(
      sessionMeta?.callback?.webhook_url && sessionMeta?.callback?.webhook_secret
    );
    const configuredWebhookUrl = sessionMeta?.callback?.webhook_url || '';
    const canResendWebhook = Boolean(
      session.ended_at ||
      ['completed', 'cancelled', 'terminated'].includes(String(session.status || '').toLowerCase())
    );

    const interviewUrl = `${baseUrl(req)}/interview/${session.session_token}`;

    const { interviewFeedbackStatusLabel } = await import('../services/assessment.service.js');
    const feedbackDisplayLabel = assessment?.feedback_status
      ? interviewFeedbackStatusLabel(assessment.feedback_status, session)
      : '';

    res.render('modules/candidate-interview/admin/session-detail', {
      title: `Interview #${session.id}`,
      currentPath: `/admin/interviews/session/${session.id}`,
      session,
      snapshots,
      telemetry,
      flags,
      recordings,
      mergedRecording,
      chunkCount: chunkRows.length,
      verificationLogs,
      interviewUrl,
      callSummary,
      summaryParsed,
      missionRecs,
      questions,
      qaDetail,
      questionPlan,
      assessment,
      skillBreakdown,
      flagSummary,
      recordingMetadata,
      webhookLog,
      completionIssueLogs: completionIssueLogs || [],
      hasWebhookConfigured,
      configuredWebhookUrl,
      canResendWebhook,
      scoreScale: SCORE_SCALE,
      feedbackDisplayLabel,
      moment,
      success_msg: req.flash('success_msg'),
      error_msg: req.flash('error_msg'),
    });
  },

  async exportSummary(req, res) {
    const { summaryService } = await import('../services/summary.service.js');
    const payload = await summaryService.getExportPayload(Number(req.params.id));
    if (!payload) return res.status(404).json({ error: 'Session not found' });
    res.setHeader('Content-Type', 'application/json');
    return res.json(payload);
  },

  async downloadRecording(req, res) {
    const { recordingService } = await import('../services/recording.service.js');
    const rec = await recordingRepository.findById(req.params.recordingId);
    if (!rec) return res.status(404).send('Not found');
    try {
      await recordingService.streamRecordingForRequest(rec, req, res, { attachment: true });
    } catch (e) {
      if (!res.headersSent) res.status(404).send(e.message || 'Not found');
    }
  },

  async retryWebhook(req, res) {
    const sessionId = Number(req.params.id);
    const { apiCompletionService } = await import('../services/api-completion.service.js');
    const { sessionRepository } = await import('../repositories/session.repository.js');
    const { verificationRepository } = await import('../repositories/verification.repository.js');

    const session = await sessionRepository.findById(sessionId);
    if (!session) return res.status(404).send('Session not found');

    try {
      const webhookUrl = (req.body.webhook_url || '').trim();
      const webhookSecret = (req.body.webhook_secret || '').trim();

      const webhookResult = await apiCompletionService.onInterviewCompleted(session, {
        webhookUrl: webhookUrl || undefined,
        webhookSecret: webhookSecret || undefined,
      });
      const delivery = webhookResult?.delivery;
      const webhookLogForStorage = webhookResult?.skipped
        ? { skipped: true, reason: webhookResult.reason, error: webhookResult.error || null }
        : {
            status: delivery?.statusLabel || (delivery?.delivered ? 'success' : 'failed'),
            savedAt: delivery?.savedAt || new Date().toISOString(),
            attempts: delivery?.attemptLog || [],
            finalError: delivery?.finalError || null,
            delivered: delivery?.delivered === true,
            http_status: delivery?.status ?? null,
            redispatched: true,
            manual_resend: Boolean(webhookUrl),
            target_url: delivery?.targetUrl || webhookUrl || null,
          };

      await verificationRepository.log({
        session_id: sessionId,
        event_type: 'webhook_retry',
        success: webhookResult?.delivery?.delivered === true,
        details_json: { webhook: webhookLogForStorage },
      });

      if (webhookResult?.skipped) {
        const skipMsg =
          webhookResult.reason === 'missing_secret'
            ? 'Webhook secret is required for a custom URL (or leave URL as configured and secret blank).'
            : `Webhook skipped: ${webhookResult.reason || 'unknown'}`;
        req.flash('error_msg', skipMsg);
      } else if (webhookResult?.delivery?.delivered) {
        req.flash('success_msg', `Webhook delivered (${webhookResult.delivery.attempts} attempt(s)).`);
      } else {
        req.flash('error_msg', `Webhook failed after ${webhookResult?.delivery?.attempts || 3} attempt(s).`);
      }
    } catch (e) {
      req.flash('error_msg', `Webhook retry failed: ${e.message}`);
    }

    return res.redirect(`/admin/interviews/session/${sessionId}?tab=summary`);
  },

  async remergeRecording(req, res) {
    const sessionId = Number(req.params.session_id || req.params.id);
    const { recordingService } = await import('../services/recording.service.js');
    const { apiCompletionService } = await import('../services/api-completion.service.js');
    const { sessionRepository } = await import('../repositories/session.repository.js');

    try {
      const result = await recordingService.remergeSessionRecording(sessionId);
      if (result.skipped) {
        req.flash('error_msg', `Merge skipped: ${result.reason || 'unknown'}`);
      } else {
        req.flash(
          'success_msg',
          `Recording re-merged (${result.chunkCount || 0} chunks, status=${result.recordingStatus || result.mergeStatus || 'done'}).`
        );

        const session = await sessionRepository.findById(sessionId);
        if (session) {
          try {
            await apiCompletionService.onInterviewCompleted(session, {});
          } catch (webhookErr) {
            console.warn('[remergeRecording] webhook redispatch failed:', webhookErr.message);
          }
        }
      }
    } catch (e) {
      req.flash('error_msg', `Merge failed: ${e.message}`);
    }

    if (req.params.id) {
      return res.redirect(`/admin/interviews/session/${req.params.id}`);
    }
    return res.redirect(`/admin/interviews/session/${sessionId}`);
  },

  async resendInvite(req, res) {
    const session = await sessionRepository.findById(req.params.id);
    if (!session) return res.status(404).send('Not found');
    await sessionService.sendInvite(session, baseUrl(req));
    req.flash('success_msg', 'Invite resent.');
    res.redirect(`/admin/interviews/session/${session.id}`);
  },

  async cancelSession(req, res) {
    await sessionRepository.update(req.params.id, { status: SESSION_STATUS.CANCELLED });
    req.flash('success_msg', 'Session cancelled.');
    res.redirect('/admin/interviews/scheduled');
  },

  async resolveFlag(req, res) {
    await flagRepository.resolve(req.params.flagId);
    res.redirect('back');
  },

  async playRecording(req, res) {
    const { recordingService } = await import('../services/recording.service.js');
    const rec = await recordingRepository.findById(req.params.recordingId);
    if (!rec) return res.status(404).send('Not found');
    try {
      await recordingService.streamRecordingForRequest(rec, req, res);
    } catch (e) {
      if (!res.headersSent) res.status(404).send(e.message || 'File not found');
    }
  },

  async serveSnapshot(req, res) {
    const { resolveStorageKey, assertPathWithinRoot } = await import('../services/storage.service.js');
    const { interviewConfig } = await import('../config.js');
    const db = (await import('../../../config/db.js')).default;
    const [rows] = await db.query(
      'SELECT * FROM interview_snapshots WHERE id = ? AND session_id = ?',
      [req.params.snapId, req.params.id]
    );
    const snap = rows[0];
    if (!snap) return res.status(404).send('Not found');
    const full = resolveStorageKey(snap.storage_key);
    assertPathWithinRoot(full, interviewConfig.uploadsRoot);
    res.sendFile(full);
  },

  async completeSessionAdmin(req, res) {
    await orchestratorService.completeInterview(req.params.id, {
      suspicious: req.body.suspicious === '1',
    });
    const fresh = await sessionRepository.findById(req.params.id);
    if (fresh) {
      const { summaryService } = await import('../services/summary.service.js');
      await summaryService.ensureSessionSummary(fresh);
    }
    req.flash('success_msg', 'Session marked complete.');
    res.redirect(`/admin/interviews/session/${req.params.id}`);
  },

  async regenerateSummary(req, res) {
    const session = await sessionRepository.findById(req.params.id);
    if (!session) return res.status(404).send('Session not found');
    const { summaryService, isTerminalSession } = await import('../services/summary.service.js');
    if (!isTerminalSession(session)) {
      req.flash('error_msg', 'Summary can only be generated after the interview has ended.');
      return res.redirect(`/admin/interviews/session/${req.params.id}`);
    }
    try {
      await summaryService.finalizeInterview(session);
      req.flash('success_msg', 'Interview summary regenerated.');
    } catch (err) {
      req.flash('error_msg', `Summary regeneration failed: ${err.message}`);
    }
    res.redirect(`/admin/interviews/session/${req.params.id}#tab-summary`);
  },
};
