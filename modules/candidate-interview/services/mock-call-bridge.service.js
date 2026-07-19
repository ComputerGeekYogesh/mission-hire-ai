/** Reuses mock-interview job rows for browser in-app interviews. */

import {
  generateMockInterviewQuestions,
  generateMissionInterviewQuestionsFromJob,
  normalizeCustomQuestions,
  insertJobForMockInterview,
  insertApiMockInterviewData,
  extractQuestionCountFromDescription,
} from './mock-interview-questions.service.js';



function getTargetQuestionCount(meta = {}, description = '', explicitListLength = 0) {
  const override = Number(meta.interview?.question_count ?? meta.question_count);
  if (Number.isFinite(override) && override >= 1 && override <= 15) {
    return Math.trunc(override);
  }
  if (explicitListLength > 0) {
    return Math.min(15, explicitListLength);
  }
  return extractQuestionCountFromDescription(description || '') || 5;
}



function toQuestionRows(texts, sourceType) {

  return texts.map((text, i) => ({

    order: i + 1,

    question: text,

    category: sourceType === 'ai_generated' ? 'general' : null,

    required: true,

    source_type: sourceType,

  }));

}



async function ensureQuestionCount(texts, targetCount, jobContext, { allowPad = true } = {}) {
  let list = [...texts].filter(Boolean);

  if (list.length > targetCount) {

    return list.slice(0, targetCount);

  }

  if (!allowPad) {
    return list;
  }

  if (list.length < targetCount) {

    const pad = await generateMockInterviewQuestions({

      jobTitle: jobContext.jobTitle || 'Interview',

      experience: jobContext.experience || '',

      description: jobContext.description || '',

      count: targetCount - list.length,

    });

    const existing = new Set(list.map((q) => q.toLowerCase()));

    for (const q of pad) {

      if (list.length >= targetCount) break;

      if (!existing.has(q.toLowerCase())) list.push(q);

    }

  }

  return list.slice(0, targetCount);

}



export const mockCallBridge = {
  generateMockInterviewQuestions,

  generateMissionInterviewQuestionsFromJob,

  normalizeCustomQuestions,

  insertJobForMockInterview,

  insertApiMockInterviewData,

  extractQuestionCountFromDescription,

  getTargetQuestionCount,

  async findJobByCallId(callId) {
    const db = (await import('../../../config/db.js')).default;
    const [rows] = await db.query(
      `SELECT job_id, questions, title, description, experience FROM jobs WHERE job_id = ? LIMIT 1`,
      [callId]
    );
    return rows[0] || null;
  },

  questionsFromJobRow(jobRow) {
    if (!jobRow) return [];
    let qs = jobRow.questions;
    if (typeof qs === 'string') {
      try {
        qs = JSON.parse(qs);
      } catch {
        qs = [];
      }
    }
    if (!Array.isArray(qs)) return [];
    return qs
      .map((entry, i) => {
        const text = typeof entry === 'string' ? entry : entry?.question || '';
        const trimmed = String(text || '').trim();
        if (!trimmed) return null;
        return {
          order: i + 1,
          question: trimmed,
          category: null,
          required: true,
          source_type: 'job',
        };
      })
      .filter(Boolean);
  },

  buildCallId(sessionId) {

    return `call_web_${sessionId}`;

  },



  buildCallSid(sessionId) {

    return `web_sess_${sessionId}`;

  },



  async resolveQuestions(session, metadata = {}) {

    const meta = typeof metadata === 'object' && metadata ? metadata : {};

    const jobDesc = meta.job?.description || '';

    const rawQuestions = meta.interview?.questions || meta.questions || [];
    const custom = mockCallBridge.normalizeCustomQuestions(rawQuestions);
    const targetCount = getTargetQuestionCount(
      meta,
      jobDesc || session.job_title || '',
      custom.length
    );
    if (meta.source === 'api' && Array.isArray(rawQuestions) && rawQuestions[0]?.question_id != null) {
      const questions = rawQuestions.map((q, i) => ({
        order: q.order ?? i + 1,
        question: String(q.question || '').trim(),
        category: q.skill ? String(q.skill).trim() : null,
        api_question_id: q.question_id,
        required: true,
        source_type: 'api',
      })).filter((q) => q.question);
      return {
        questions,
        plan: {
          source: 'api',
          count: questions.length,
          target_count: questions.length,
          reason: 'Questions supplied via schedule video interview API.',
        },
      };
    }

    if (custom.length) {
      const isManualList =
        meta.interview?.question_source === 'manual' ||
        meta.question_source === 'manual' ||
        meta.source === 'schedule_chat' ||
        (rawQuestions[0] && typeof rawQuestions[0] === 'object' && rawQuestions[0].source_type === 'custom');
      const texts = await ensureQuestionCount(
        custom,
        targetCount,
        {
          jobTitle: session.job_title,
          experience: meta.job?.experience,
          description: jobDesc,
        },
        { allowPad: !isManualList }
      );

      return {
        questions: toQuestionRows(texts, 'custom'),
        plan: {
          source: 'custom',
          count: texts.length,
          target_count: isManualList ? texts.length : targetCount,
          reason: isManualList
            ? `Using ${texts.length} question(s) from your provided list.`
            : `Custom/scheduled questions, adjusted to target count ${targetCount}.`,
        },
      };
    }



    if (session.job_id) {

      const db = (await import('../../../config/db.js')).default;

      const [rows] = await db.query(

        `SELECT questions, title, experience, description FROM jobs WHERE id = ? OR job_id = ? ORDER BY id DESC LIMIT 1`,

        [session.job_id, session.job_id]

      );

      const jobRow = rows[0];

      const description = jobRow?.description || jobDesc;

      const target = getTargetQuestionCount(meta, description);



      if (jobRow?.questions) {

        let qs = jobRow.questions;

        if (typeof qs === 'string') {

          try {

            qs = JSON.parse(qs);

          } catch {

            qs = [];

          }

        }

        const normalized = mockCallBridge.normalizeCustomQuestions(qs);

        if (normalized.length) {

          const texts = await ensureQuestionCount(normalized, target, {

            jobTitle: jobRow.title || session.job_title,

            experience: jobRow.experience,

            description,

          });

          return {

            questions: toQuestionRows(texts, 'job'),

            plan: {

              source: 'job',

              count: texts.length,

              target_count: target,

              reason: `Job #${session.job_id} had ${normalized.length} question(s); expanded/trimmed to ${target} (schedule override or description).`,

            },

          };

        }

      }



      if (jobRow) {

        let generated = await mockCallBridge.generateMissionInterviewQuestionsFromJob({

          jobTitle: jobRow.title || session.job_title,

          experience: jobRow.experience,

          description,

        });

        generated = await ensureQuestionCount(generated, target, {

          jobTitle: jobRow.title,

          experience: jobRow.experience,

          description,

        });

        return {

          questions: toQuestionRows(generated, 'ai_generated'),

          plan: {

            source: 'ai_job',

            count: generated.length,

            target_count: target,

            reason: `AI generated from job, normalized to ${target} question(s).`,

          },

        };

      }

    }



    const generated = await generateMockInterviewQuestions({

      jobTitle: session.job_title || 'Interview',

      experience: meta.job?.experience || '',

      description: jobDesc || session.job_title || '',

      count: targetCount,

    });



    return {

      questions: toQuestionRows(generated, 'ai_generated'),

      plan: {

        source: 'ai_default',

        count: generated.length,

        target_count: targetCount,

        reason: `Default AI question set: ${targetCount} question(s).`,

      },

    };

  },

};


