import { getOpenAI } from '../../../config/openaiClient.js';
import moment from 'moment-timezone';
import db from '../../../config/db.js';
import { questionRepository } from '../repositories/question.repository.js';
import { mockCallBridge } from './mock-call-bridge.service.js';
import { recordingService } from './recording.service.js';
import { suspiciousService } from './suspicious.service.js';
import { flagRepository } from '../repositories/flag.repository.js';
import { FLAG_TYPES, FLAG_SEVERITY } from '../constants.js';
import { detectQuestionRepetition } from '../lib/question-repeat-detect.js';
import { logInterviewError } from './interview-error-log.service.js';
import { proctoringViolationService } from './proctoring-violation.service.js';
import { proctorDebug, proctorDebugFlow, proctorLogActivityDetected, proctorLog } from './proctoring-debug.service.js';
import {
  normalizeQuestionScore,
} from './score-normalization.service.js';
import { noteFocusLossEvent } from './attention-analysis.service.js';
import { canonicalFlagType } from '../lib/proctoring-flag-naming.js';
import { assessmentLog } from './assessment-interaction-log.service.js';
import { resolveAnswerTranscriptForScoring } from './answer-transcription.service.js';
import {
  sanitizeAnswerTranscript,
  meaningfulAnswerTokenCount,
} from './answer-transcript-sanitize.service.js';

const openai = getOpenAI();

const CLEAR_NON_ANSWER_RE =
  /\b(i (?:have )?(?:no idea|don't know|do not know|am not sure|cannot answer|can't answer)|no experience|not aware|no answer)\b/i;

function detectNonAnswer(answerText, questionText = '') {
  const { cleaned } = sanitizeAnswerTranscript(answerText, { questionText });
  const tokens = meaningfulAnswerTokenCount(cleaned);

  if (!cleaned || tokens < 3) {
    return {
      nonAnswer: true,
      cleanedAnswer: cleaned,
      reason: 'empty_or_non_substantive',
    };
  }

  if (CLEAR_NON_ANSWER_RE.test(cleaned)) {
    if (tokens < 8) {
      return {
        nonAnswer: true,
        cleanedAnswer: cleaned,
        reason: 'explicit_no_answer',
      };
    }
  }

  return {
    nonAnswer: false,
    cleanedAnswer: cleaned,
    reason: null,
  };
}

function computeQuestionRepeatSignal(questionText, answerText) {
  const result = detectQuestionRepetition(questionText, answerText);
  return {
    repeated: result.repeated,
    overlapRatio: result.overlapRatio,
    overlapCount: 0,
    extraAnswerTokens: result.extraAnswerTokens ?? 0,
  };
}

async function scoreAnswer(questionText, answerText, { skill = null } = {}) {
  const nonAnswer = detectNonAnswer(answerText, questionText);
  if (nonAnswer.nonAnswer) {
    return {
      feedback:
        'No relevant answer provided for this question. Response contained confirmation or non-substantive speech.',
      score: 0,
      cleanedAnswer: nonAnswer.cleanedAnswer,
      non_answer_reason: nonAnswer.reason,
    };
  }

  const skillLine = skill ? `\nSKILL / COMPETENCY BEING ASSESSED:\n${skill}\n` : '';

  const prompt = `You are a fair and balanced interview evaluator.
Your job is to score the candidate GENEROUSLY but honestly on the specific skill/competency this question targets.
${skillLine}
CRITICAL SCORING RULES — READ CAREFULLY:
- Score based on the FULL spoken answer transcript (not a partial snippet)
- Always reward what the candidate got RIGHT for this skill area
- Give meaningful partial credit for partial knowledge
- A good answer that covers the core concept deserves 75-90% of the max score
- Never score below 2 out of 10 for any genuine attempt at answering
- Do NOT penalize for imperfect phrasing, accent, or verbal fillers
- A concise correct answer scores HIGHER than a long vague one
- Missing minor details should NOT tank the entire score
- Score like a senior hiring manager who wants to find the best in candidates

SCORING SCALE (0–10):
- 10: Excellent — covers all key points well for this skill
- 8: Good — covers core concepts, minor gaps
- 6: Satisfactory — covers main idea, missing some depth
- 4: Partial — shows some understanding
- 2: Weak attempt — minimal relevant content
- 0: No genuine attempt only — off-topic, empty, or meta phrases only

QUESTION:
${questionText}

CANDIDATE ANSWER (full transcript):
${nonAnswer.cleanedAnswer || answerText || 'No answer given'}

Score this answer on a 0–10 scale for the skill/competency above.
Be generous — if the candidate clearly understands the concept, give them credit even if they did not use exact terminology.
Respond ONLY valid JSON: { "feedback": "short feedback referencing skill demonstrated", "score": number 0-10 }`;

  try {
    const aiResp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    });
    let raw = aiResp.choices[0]?.message?.content?.trim() || '{}';
    raw = raw.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(raw);
    const scoreNum = Number(parsed.score);
    const score = normalizeQuestionScore(
      Number.isFinite(scoreNum) ? scoreNum : 0,
      `answer: ${String(questionText).slice(0, 48)}`
    );
    return {
      feedback: parsed.feedback || 'Unable to evaluate.',
      score,
      cleanedAnswer: nonAnswer.cleanedAnswer,
      non_answer_reason: null,
    };
  } catch (err) {
    logInterviewError({
      severity: 'error',
      sessionId: null,
      sourceTag: 'openai_evaluation',
      sourceFile: 'question-engine.service.js',
      message: 'OpenAI answer evaluation failed',
      err,
    }).catch(() => {});
    return { feedback: 'Unable to evaluate.', score: 0, cleanedAnswer: nonAnswer.cleanedAnswer, non_answer_reason: null };
  }
}

export const questionEngineService = {
  async getCallState(session, { includeQuestions = true } = {}) {
    const [questions, answered] = await Promise.all([
      questionRepository.listBySession(session.id),
      questionRepository.countAnswered(session.id),
    ]);
    const current = questions.find((_, idx) => idx === answered) || null;

    let meta = {};
    try {
      meta =
        typeof session.metadata_json === 'string'
          ? JSON.parse(session.metadata_json)
          : session.metadata_json || {};
    } catch {
      meta = {};
    }

    return {
      mock_call_id: meta.mock_call_id,
      call_sid: meta.call_sid,
      total_questions: questions.length,
      answered_count: answered,
      current_question: current,
      completed: answered >= questions.length && questions.length > 0,
      ...(includeQuestions ? { questions } : {}),
    };
  },

  async submitAnswer(session, questionId, file, { textAnswer } = {}) {
    const question = await questionRepository.findById(questionId);
    if (!question || question.session_id !== session.id) {
      const err = new Error('Invalid question');
      err.status = 400;
      throw err;
    }

    let meta = {};
    try {
      meta =
        typeof session.metadata_json === 'string'
          ? JSON.parse(session.metadata_json)
          : session.metadata_json || {};
    } catch {
      meta = {};
    }

    const callSid = meta.call_sid || mockCallBridge.buildCallSid(session.id);
    const mockCallId = meta.mock_call_id || mockCallBridge.buildCallId(session.id);

    let storageKey = null;
    let answerRecordingId = null;
    const clientTranscript = textAnswer?.trim() || '';
    let transcript = '';
    let transcriptSource = 'none';
    let transcriptMeta = null;

    if (!file?.path && !clientTranscript) {
      const err = new Error('No answer provided');
      err.status = 400;
      throw err;
    }

    if (file?.path) {
      transcriptMeta = await resolveAnswerTranscriptForScoring({
        filePath: file.path,
        clientText: clientTranscript,
        questionText: question.question_text,
        skill: question.category,
        sessionId: session.id,
        questionId,
      });
      transcript = transcriptMeta.transcript;
      transcriptSource = transcriptMeta.source;

      const saved = await recordingService.saveAnswerRecording(session, file, questionId);
      storageKey = saved.storageKey;
      answerRecordingId = saved.id;
    } else {
      transcript = clientTranscript;
      transcriptSource = 'client_text_only';
      transcriptMeta = {
        transcript,
        source: transcriptSource,
        clientText: clientTranscript,
        whisperText: '',
        usedClientFallback: true,
      };
    }

    if (!transcript) {
      const err = new Error(
        'Could not transcribe your answer. Please speak clearly for a few seconds and try again.'
      );
      err.status = 400;
      throw err;
    }

    await db.query(
      `DELETE FROM interview_question_responses WHERE session_id = ? AND question_id = ?`,
      [session.id, questionId]
    );

    const { feedback, score, cleanedAnswer } = await scoreAnswer(question.question_text, transcript, {
      skill: question.category,
    });
    const finalTranscript = cleanedAnswer || transcript;
    const repeatFromRaw = computeQuestionRepeatSignal(question.question_text, transcript);
    const repeatFromFinal = computeQuestionRepeatSignal(question.question_text, finalTranscript);
    const repeatSignal = repeatFromRaw.repeated ? repeatFromRaw : repeatFromFinal;
    if (repeatSignal.repeated) {
      // Red flag for possible use of external voice assistant / reading prompts aloud.
      try {
        await suspiciousService.flagQuestionRepetition(session, {
          overlapRatio: repeatSignal.overlapRatio,
          questionText: question.question_text,
          answerText: finalTranscript || transcript,
          questionId: questionId,
        });
      } catch (e) {
        console.warn('[question-engine] question repetition flag failed:', e.message);
      }
    }

    if (question.feedback_id) {
      await db.query(`UPDATE feedback SET user_answer = ?, feedback = ?, score = ? WHERE id = ?`, [
        finalTranscript,
        feedback,
        score,
        question.feedback_id,
      ]);
    }

    await db.query(
      `INSERT INTO interview_question_responses
        (session_id, question_id, response_text, audio_storage_key, score, ai_feedback, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        questionId,
        finalTranscript,
        storageKey,
        score,
        feedback,
        moment().format('YYYY-MM-DD HH:mm:ss'),
      ]
    );

    const callState = await questionEngineService.getCallState(session);

    assessmentLog.answer('Candidate answer recorded', {
      sessionId: session.id,
      questionId,
      answerText: finalTranscript.slice(0, 500),
      transcriptSource,
      rawWhisperPreview: transcriptMeta?.whisperText?.slice(0, 200) || null,
      sanitizedPreview: transcriptMeta?.sanitizedWhisper?.slice(0, 200) || null,
      whisperChars: transcriptMeta?.whisperText?.length ?? 0,
      clientChars: transcriptMeta?.clientText?.length ?? 0,
      duration: null,
    });
    assessmentLog.answer(
      'Answer stored to session',
      {
        sessionId: session.id,
        questionId,
        storedAt: new Date().toISOString(),
      },
      'DEBUG'
    );

    return {
      question_id: questionId,
      transcript: finalTranscript,
      transcript_source: transcriptSource,
      score,
      feedback,
      answer_recording_id: answerRecordingId,
      audio_storage_key: storageKey,
      next_index: question.question_order,
      call_state: callState,
    };
  },

  async logSuspiciousEvent(session, eventType, message, payload = {}) {
    const rawCanonical = canonicalFlagType(eventType);
    const canonicalType =
      rawCanonical === FLAG_TYPES.WINDOW_BLUR || rawCanonical === FLAG_TYPES.TAB_SWITCH
        ? FLAG_TYPES.TAB_SWITCH
        : rawCanonical;

    if (canonicalType === FLAG_TYPES.TAB_SWITCH && proctoringViolationService.isDuplicateFocusViolation(session)) {
      proctorDebugFlow('focus_coalesced_skip_flag', {
        session_id: session.id,
        focus_source: payload.focus_source || null,
        raw_event_type: eventType,
      });
      return {
        deduped: true,
        message,
        proctoring: proctoringViolationService.getClientSnapshot(session),
        proctoring_action: 'none',
        trigger_flag_type: canonicalType,
      };
    }

    const severity =
      canonicalType === FLAG_TYPES.HEADPHONES_REMOVED ||
      canonicalType === FLAG_TYPES.CAMERA_DISABLED ||
      canonicalType === FLAG_TYPES.FACE_ROTATION ||
      canonicalType === FLAG_TYPES.QUESTION_REPEATED ||
      canonicalType === FLAG_TYPES.IDENTITY_MISMATCH ||
      canonicalType === FLAG_TYPES.HIDDEN_DEVICE_ATTENTION ||
      canonicalType === FLAG_TYPES.ATTENTION_CORRELATION ||
      canonicalType === FLAG_TYPES.DOWNWARD_GAZE ||
      canonicalType === FLAG_TYPES.OFF_SCREEN_GAZE ||
      canonicalType === FLAG_TYPES.MOBILE_PHONE_DETECTED ||
      canonicalType === FLAG_TYPES.WEBCAM_OBSTRUCTION ||
      canonicalType === FLAG_TYPES.LIVENESS_FAILURE ||
      canonicalType === FLAG_TYPES.IDENTITY_DRIFT ||
      canonicalType === FLAG_TYPES.VIRTUAL_CAMERA ||
      canonicalType === FLAG_TYPES.VOICE_COACHING ||
      canonicalType === FLAG_TYPES.INTEGRITY_ANOMALY ||
      canonicalType === FLAG_TYPES.VERIFICATION_FAILED ||
      canonicalType === FLAG_TYPES.LEAVING_CAMERA_FRAME ||
      canonicalType === FLAG_TYPES.FACE_ABSENT_DURATION ||
      canonicalType === FLAG_TYPES.NO_FACE
        ? FLAG_SEVERITY.HIGH
        : canonicalType === FLAG_TYPES.TAB_SWITCH || canonicalType === FLAG_TYPES.WINDOW_BLUR
          ? FLAG_SEVERITY.MEDIUM
          : FLAG_SEVERITY.LOW;

    const flagId = await flagRepository.create({
      session_id: session.id,
      flag_type: canonicalType,
      severity,
      message,
      payload_json: {
        ...payload,
        at: new Date().toISOString(),
        raw_event_type: eventType,
        focus_source: payload.focus_source || null,
      },
    });

    proctorDebugFlow('flag_created', {
      session_id: session.id,
      flag_type: canonicalType,
      raw_event_type: eventType,
      flag_id: flagId,
      severity,
      source: payload.source || 'client',
    });

    proctorLogActivityDetected(session, canonicalType, {
      flag_id: flagId,
      source: payload.source || 'client',
    });

    if (canonicalType === FLAG_TYPES.WEBCAM_OBSTRUCTION) {
      proctorLog('suspicious_activity_webcam_obstruction', {
        session_id: session.id,
        candidate_id: session.candidate_id ?? session.id,
        flag_id: flagId,
        detail: `confidence=${payload.confidence ?? payload.webcam_obstruction_confidence ?? 'n/a'}`,
      });
    }

    const integrityTypes = new Set([
      FLAG_TYPES.LIVENESS_FAILURE,
      FLAG_TYPES.IDENTITY_DRIFT,
      FLAG_TYPES.INTEGRITY_ANOMALY,
      FLAG_TYPES.VOICE_COACHING,
      FLAG_TYPES.VIRTUAL_CAMERA,
      FLAG_TYPES.VERIFICATION_FAILED,
    ]);
    if (integrityTypes.has(canonicalType)) {
      proctorLog(`Integrity flag: ${canonicalType}`, {
        session_id: session.id,
        candidate_id: session.candidate_id ?? session.id,
        flag_id: flagId,
        detail: `confidence=${payload.confidence ?? 'n/a'}, sub_type=${payload.integrity_sub_type ?? 'n/a'}`,
      });
    }

    logInterviewError({
      severity: severity === FLAG_SEVERITY.HIGH ? 'warning' : 'info',
      sessionId: session.id,
      sessionToken: session.session_token,
      sourceTag: 'suspicious_event',
      message: `[${canonicalType}] ${message}`,
      context: { flag_id: flagId, event_type: canonicalType },
    }).catch(() => {});

    proctorDebug('client_suspicious_event', {
      session_id: session.id,
      event_type: canonicalType,
      flag_id: flagId,
      severity,
    });

    if (canonicalType === FLAG_TYPES.TAB_SWITCH) {
      noteFocusLossEvent(session.id);
    }

    const escalation = await proctoringViolationService.processViolation(session, canonicalType, {
      flagId,
      message,
      source: payload.source || 'client',
      payload,
    });

    proctorDebugFlow('client_escalation', {
      session_id: session.id,
      flag_type: canonicalType,
      flag_id: flagId,
      action: escalation.action,
      risk_score: escalation.proctoring?.risk_score,
      effective_score: escalation.proctoring?.effective_score,
    });

    return {
      id: flagId,
      message,
      proctoring: escalation.proctoring,
      proctoring_action: escalation.action,
      terminate: escalation.action === 'terminate',
      trigger_flag_type: escalation.trigger_flag_type || canonicalType,
    };
  },
};
