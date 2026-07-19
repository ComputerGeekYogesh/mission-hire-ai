import db from '../../../config/db.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { interviewChatScheduleService } from '../services/interview-chat-schedule.service.js';
import { scheduleChatFulfillmentService } from '../services/schedule-chat-fulfillment.service.js';
import { logInterviewError } from '../services/interview-error-log.service.js';
function baseUrl(req) {
  return process.env.HOST_URL || `${req.protocol}://${req.get('host')}`;
}

function parseMeta(session) {
  try {
    return typeof session.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session.metadata_json || {};
  } catch {
    return {};
  }
}

function jsonFromResult(result, extra = {}) {
  return {
    ok: true,
    reply: result.reply,
    step: result.step,
    errors: result.errors || null,
    summary: result.summary || null,
    questions: result.questions || null,
    ui: result.ui || null,
    done: !!result.done,
    schedulePayload: result.schedulePayload || null,
    ...extra,
  };
}

export const interviewChatController = {
  async scheduleChatPage(req, res) {
    const [companies] = await db.query(`SELECT id, name FROM companies ORDER BY created_at ASC`);
    const selectedCompanyId = req.session.selectedCompanyId || req.session.company_id;
    res.render('modules/candidate-interview/admin/schedule-chat', {
      title: 'Schedule Interview',
      currentPath: '/admin/interviews/schedule',
      email: req.session.email,
      companies: companies || [],
      selectedCompanyId,
      permissions: res.locals.permissions || {},
    });
  },

  async history(req, res) {
    const recruiterId = req.session.user_id ? parseInt(req.session.user_id, 10) : null;
    const companyId = req.session.company_id ? parseInt(req.session.company_id, 10) : null;
    const roleId = parseInt(req.session.role_id, 10) || 0;

    const { rows } = await sessionRepository.list({
      recruiter_id: recruiterId,
      limit: 60,
      offset: 0,
    });

    const sessionItems = rows.map((s) => {
      const meta = parseMeta(s);
      const job = meta.job || {};
      const interview = meta.interview || {};
      const questions = (interview.questions || meta.questions || [])
        .map((q) => (typeof q === 'string' ? q : q.question || ''))
        .filter(Boolean);
      const promptText = [
        `Job Profile : ${job.title || s.job_title || '-'}`,
        `Job Description : ${job.description || '-'}`,
        `Experience Required : ${job.experience ?? '-'}`,
        `Number of Questions to Ask : ${interview.question_count || meta.interview?.question_count || questions.length || '-'}`,
        `Name: ${s.candidate_name}`,
        `Email: ${s.candidate_email}`,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        id: `session-${s.id}`,
        source: 'browser',
        candidate_name: s.candidate_name,
        candidate_email: s.candidate_email,
        job_title: s.job_title || job.title,
        interview_type: s.interview_type,
        status: s.status,
        scheduled_at: s.scheduled_at,
        created_at: s.created_at,
        detail_url: `/admin/interviews/session/${s.id}`,
        prompt_text: promptText,
        questions,
        sort_at: s.scheduled_at || s.created_at,
      };
    });

    const items = sessionItems
      .sort((a, b) => new Date(b.sort_at || 0) - new Date(a.sort_at || 0))
      .slice(0, 60)
      .map(({ sort_at, ...rest }) => rest);

    return res.json({ ok: true, items });
  },

  async message(req, res) {
    const clientId = req.body?.clientId || req.sessionID || 'web';
    const body = req.body || {};

    try {
      const result = await interviewChatScheduleService.handleInput({
        clientId,
        userId: req.session.user_id,
        message: body.message?.trim() || '',
        action: body.action || null,
        value: body.value ?? null,
        phones: body.phones ?? null,
        questionsText: body.questionsText ?? null,
        historyPrompt: body.historyPrompt ?? null,
        historyQuestions: body.historyQuestions ?? null,
        fromHistoryTemplate: body.fromHistoryTemplate === true,
      });

      if (result.done && result.schedulePayload) {
        const recruiter = {
          user_id: req.session.user_id,
          company_id: req.session.company_id,
          is_super_admin: req.session.is_super_admin || 0,
        };

        const fulfill = await scheduleChatFulfillmentService.fulfill(
          result.schedulePayload,
          recruiter,
          baseUrl(req)
        );

        const extra = {
          ok: true,
          done: true,
          reply: fulfill.reply,
          interview_type: result.schedulePayload.interview_type,
        };

        if (fulfill.mode === 'browser' && fulfill.session) {
          extra.interview_url = fulfill.interviewUrl;
          extra.session_id = fulfill.session.id;
          if (process.env.NODE_ENV !== 'production' && fulfill.otp) {
            extra.dev_otp = fulfill.otp;
          }
        }

        interviewChatScheduleService.reset(clientId, req.session.user_id);

        return res.json(extra);
      }

      return res.json(jsonFromResult(result));
    } catch (err) {
      await logInterviewError({
        severity: 'error',
        sourceTag: 'schedule_chat',
        message: err.message,
        err,
        context: { clientId, action: body.action },
      });
      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || 'Could not process request',
      });
    }
  },

  async reset(req, res) {
    const clientId = req.body?.clientId || req.sessionID || 'web';
    const result = await interviewChatScheduleService.handleInput({
      clientId,
      userId: req.session.user_id,
      action: 'reset',
    });
    return res.json(jsonFromResult(result));
  },
};
