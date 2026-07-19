import { getOpenAI } from '../../../config/openaiClient.js';
import { interviewConfig } from '../config.js';
import { questionRepository } from '../repositories/question.repository.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { integrityService } from './integrity.service.js';
import { verificationRepository } from '../repositories/verification.repository.js';
import { flagRepository } from '../repositories/flag.repository.js';
import { FLAG_TYPES, FLAG_SEVERITY } from '../constants.js';
import { classifyQuestionRepeatRequest } from '../lib/question-repeat-request-intent.js';

const openai = getOpenAI();

function parseSessionMeta(session) {
  try {
    return typeof session.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session.metadata_json || {};
  } catch {
    return {};
  }
}

function getQuestionAudioMeta(meta, questionId) {
  const root = meta.question_audio_meta || {};
  const key = String(questionId);
  return root[key] || { repeat_count: 0, spoken_versions: [] };
}

function setQuestionAudioMeta(meta, questionId, entry) {
  const root = { ...(meta.question_audio_meta || {}) };
  root[String(questionId)] = entry;
  return { ...meta, question_audio_meta: root };
}

async function generateRephrasedQuestion(originalText, priorSpoken = []) {
  const priorList = priorSpoken.filter(Boolean).slice(-6);
  const priorBlock = priorList.length
    ? `\nAlready spoken versions (use clearly different wording):\n${priorList.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
    : '';

  const prompt = `Rephrase this interview question for spoken delivery in a video interview.
Rules:
- Preserve the exact intent, scope, and difficulty level.
- Do not add hints, examples, or extra sub-questions.
- Use natural conversational wording suitable for text-to-speech.
- One or two sentences maximum.
- Do not repeat wording from prior versions.
${priorBlock}

Original question:
${originalText}

Reply with only the rephrased question text, no quotes or preamble.`;

  const aiResp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
  });

  const text = aiResp.choices[0]?.message?.content?.trim() || '';
  return text.replace(/^["']|["']$/g, '').trim();
}

async function generateQuestionClarification(originalText, candidateAsk = '') {
  const prompt = `You clarify an interview question for a candidate in a video assessment.
Rules:
- Explain or rephrase the question in simpler, clearer language.
- Preserve the exact intent, scope, and difficulty level.
- Do not provide hints, sample answers, or leading information.
- One or two sentences maximum, suitable for text-to-speech.
- Do not answer unrelated candidate questions.

Original question:
${originalText}

Candidate clarification request (if any):
${candidateAsk || '(none)'}

Reply with only the clarified question text, no quotes or preamble.`;

  const aiResp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
  });

  const text = aiResp.choices[0]?.message?.content?.trim() || '';
  return text.replace(/^["']|["']$/g, '').trim();
}

export const questionRephraseService = {
  maxRepeats: interviewConfig.maxQuestionRepeatRequests,

  async handleRepeatRequest(session, questionId, { spokenText, ip, userAgent } = {}) {
    const question = await questionRepository.findById(questionId);
    if (!question || question.session_id !== session.id) {
      const err = new Error('Invalid question');
      err.status = 400;
      throw err;
    }

    const repeatIntent = classifyQuestionRepeatRequest(spokenText || '');
    if (!repeatIntent.isRepeatRequest) {
      return {
        ok: false,
        reason: 'not_repeat_request',
        confidence: repeatIntent.confidence,
      };
    }

    const meta = parseSessionMeta(session);
    const audioMeta = getQuestionAudioMeta(meta, questionId);
    const repeatCount = Number(audioMeta.repeat_count) || 0;
    const spokenVersions = Array.isArray(audioMeta.spoken_versions) ? [...audioMeta.spoken_versions] : [];

    if (!spokenVersions.length) {
      spokenVersions.push(question.question_text);
    }

    if (repeatCount >= this.maxRepeats) {
      await verificationRepository.log({
        session_id: session.id,
        event_type: 'question_repeat_limit',
        success: false,
        ip_address: ip,
        user_agent: userAgent,
        details_json: {
          question_id: questionId,
          repeat_count: repeatCount,
          spoken_text: String(spokenText || '').slice(0, 300),
        },
      });

      return {
        ok: true,
        limit_reached: true,
        repeat_count: repeatCount,
        max_repeats: this.maxRepeats,
        spoken_text:
          "I've repeated this question the maximum number of times. Please answer based on what you heard, or say next when you are ready to move on.",
        rephrased_text: null,
      };
    }

    let rephrased = '';
    try {
      if (process.env.OPENAI_API_KEY) {
        rephrased = await generateRephrasedQuestion(question.question_text, spokenVersions);
      }
    } catch (e) {
      console.warn('[question-rephrase] AI rephrase failed:', e.message);
    }

    if (!rephrased || rephrased.length < 12) {
      rephrased = question.question_text;
    }

    const nextCount = repeatCount + 1;
    const updatedVersions = [...spokenVersions, rephrased];
    const updatedMeta = setQuestionAudioMeta(meta, questionId, {
      repeat_count: nextCount,
      spoken_versions: updatedVersions,
    });
    await sessionRepository.update(session.id, { metadata_json: updatedMeta });

    await verificationRepository.log({
      session_id: session.id,
      event_type: 'question_repeat_request',
      success: true,
      ip_address: ip,
      user_agent: userAgent,
      details_json: {
        question_id: questionId,
        repeat_count: nextCount,
        confidence: repeatIntent.confidence,
        spoken_text: String(spokenText || '').slice(0, 300),
        rephrased_preview: rephrased.slice(0, 200),
      },
    });

    if (nextCount >= this.maxRepeats) {
      await flagRepository.create({
        session_id: session.id,
        flag_type: FLAG_TYPES.SUSPICIOUS_PATTERN,
        severity: FLAG_SEVERITY.LOW,
        message: `Candidate requested question repeat ${nextCount} times (limit reached)`,
        payload_json: {
          question_id: questionId,
          repeat_count: nextCount,
          event: 'excessive_question_repeats',
        },
      });
      await integrityService.escalateRepeatQuestionAbuse(session, {
        questionId,
        repeatCount: nextCount,
      });
    }

    const intro =
      nextCount === 1
        ? 'Certainly.'
        : nextCount === 2
          ? 'Of course.'
          : 'Sure.';

    return {
      ok: true,
      limit_reached: false,
      repeat_count: nextCount,
      max_repeats: this.maxRepeats,
      rephrased_text: rephrased,
      spoken_text: `${intro} ${rephrased}`,
      original_question_id: questionId,
    };
  },

  async handleClarificationRequest(session, questionId, { spokenText = '', questionText = '' } = {}) {
    const question = questionId ? await questionRepository.findById(questionId) : null;
    const original =
      question?.question_text ||
      String(questionText || '').trim() ||
      '';

    if (!original) {
      return {
        ok: false,
        reason: 'no_question',
        spoken_text: 'Please listen to the question again and answer when you are ready.',
      };
    }

    let clarified = '';
    try {
      if (process.env.OPENAI_API_KEY) {
        clarified = await generateQuestionClarification(original, spokenText);
      }
    } catch (e) {
      console.warn('[question-rephrase] clarification failed:', e.message);
    }

    if (!clarified || clarified.length < 12) {
      clarified = original;
    }

    await verificationRepository.log({
      session_id: session.id,
      event_type: 'question_clarification_request',
      success: true,
      details_json: {
        question_id: questionId,
        spoken_text: String(spokenText || '').slice(0, 300),
        clarified_preview: clarified.slice(0, 200),
      },
    });

    return {
      ok: true,
      clarified_text: clarified,
      spoken_text: `Sure. ${clarified}`,
      original_question_id: questionId,
    };
  },
};
