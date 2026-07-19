import { ASSESSMENT_INTENTS } from '../lib/assessment-intent.js';
import { pickResponseForIntent, pickSilencePrompt } from '../lib/assessment-responses.js';
import { assessmentLog } from './assessment-interaction-log.service.js';
import { questionRephraseService } from './question-rephrase.service.js';
import {
  answerRelevantGeneralQuestion,
  isAssessmentMetaQuery,
} from './interview-general-answer.service.js';
import {
  appendResumeOffer,
  buildResumePrompt,
  buildWelcomeBackPrompt,
  getInterviewAgentState,
  saveInterviewAgentState,
} from './interview-agent-state.service.js';

function questionIndexFrom(assessmentState = {}, agentState = {}) {
  return (
    Number(assessmentState.question_index) ||
    Number(agentState.currentQuestionIndex) ||
    1
  );
}

function totalQuestionsFrom(assessmentState = {}, callState = {}, agentState = {}) {
  return (
    Number(assessmentState.total_questions) ||
    Number(callState?.total_questions) ||
    Number(agentState.totalQuestions) ||
    0
  );
}

function resolveGeneralRelevance(classification) {
  if (classification.generalRelevance === 'relevant' || classification.generalRelevance === 'irrelevant') {
    return classification.generalRelevance;
  }
  if (isAssessmentMetaQuery(classification.reasoning, classification.scopeCategory)) {
    return 'relevant';
  }
  const cat = String(classification.scopeCategory || '').toLowerCase();
  if (cat.includes('role_context') || cat.includes('process_context') || cat.includes('company_context')) {
    return 'relevant';
  }
  if (cat === 'assessment_meta') return 'relevant';
  return 'irrelevant';
}

export const assessmentResponseRouter = {
  /**
   * Build spoken response for a classified intent.
   * Returns null responseText for ANSWER (no AI speech — candidate keeps answering).
   */
  async dispatch(
    session,
    classification,
    {
      questionText = '',
      questionId = null,
      spokenText = '',
      callState = {},
      assessmentState = {},
    } = {}
  ) {
    const sessionId = session?.id;
    const { intent, reasoning, edgeCase, scopeCategory } = classification;
    const agentState = getInterviewAgentState(session);
    const qIndex = questionIndexFrom(assessmentState, agentState);
    const totalQuestions = totalQuestionsFrom(assessmentState, callState, agentState);

    assessmentLog.response('Generating response for intent', {
      sessionId,
      questionId,
      intent,
      templateUsed: null,
    });

    if (intent === ASSESSMENT_INTENTS.ANSWER && edgeCase) {
      const picked = pickResponseForIntent(sessionId, intent, { edgeCase });
      assessmentLog.edgeCase('Edge case triggered', { sessionId, questionId, type: edgeCase, input: null }, 'WARN');
      assessmentLog.edgeCase('Edge case handler response sent', {
        sessionId,
        handlerUsed: edgeCase,
        responseText: picked.text?.slice(0, 200),
      });
      return {
        intent,
        responseText: picked.text,
        templateIndex: picked.templateIndex,
        action: 'speak',
        removeFromTranscript: true,
        continueRecording: true,
      };
    }

    if (intent === ASSESSMENT_INTENTS.ANSWER) {
      return {
        intent,
        responseText: null,
        action: 'continue_recording',
        removeFromTranscript: false,
        continueRecording: true,
      };
    }

    if (intent === ASSESSMENT_INTENTS.MOVE_TO_NEXT) {
      const picked = pickResponseForIntent(sessionId, intent, { reasoning });
      return {
        intent,
        responseText: picked.text,
        templateIndex: picked.templateIndex,
        action: 'request_advance',
        removeFromTranscript: true,
        continueRecording: false,
      };
    }

    if (intent === ASSESSMENT_INTENTS.RESUME_REQUEST) {
      await saveInterviewAgentState(session, {
        isPaused: false,
        pauseReason: null,
        currentQuestionIndex: qIndex,
        currentQuestionId: questionId,
        currentQuestionText: questionText,
        totalQuestions,
      });

      const welcome = buildWelcomeBackPrompt(qIndex, questionText);
      return {
        intent,
        responseText: welcome,
        action: 'resume_current_question',
        resumeQuestionText: questionText,
        questionIndex: qIndex,
        removeFromTranscript: true,
        continueRecording: true,
        agentState: { isPaused: false },
      };
    }

    if (intent === ASSESSMENT_INTENTS.REPEAT_REQUEST) {
      return {
        intent,
        responseText: null,
        action: 'repeat_question',
        removeFromTranscript: true,
        continueRecording: true,
      };
    }

    if (intent === ASSESSMENT_INTENTS.CLARIFICATION_REQUEST) {
      let clarifiedText = null;
      try {
        const result = await questionRephraseService.handleClarificationRequest(session, questionId, {
          spokenText,
          questionText,
        });
        clarifiedText = result?.spoken_text || null;
      } catch (e) {
        console.warn('[assessment-router] clarification failed:', e.message);
      }

      if (!clarifiedText) {
        clarifiedText = questionText
          ? `Let me clarify. ${questionText}`
          : 'Let me rephrase the question for you.';
      }

      assessmentLog.response('Clarification response dispatched', {
        sessionId,
        questionId,
        responseText: clarifiedText.slice(0, 220),
      });

      return {
        intent,
        responseText: clarifiedText,
        action: 'speak',
        removeFromTranscript: true,
        continueRecording: true,
      };
    }

    if (intent === ASSESSMENT_INTENTS.GENERAL_QUERY) {
      const relevance = resolveGeneralRelevance(classification);
      assessmentLog.scope(
        'General query detected',
        {
          sessionId,
          questionId,
          category: scopeCategory || 'unknown',
          relevance,
        },
        'WARN'
      );

      let answerText;
      if (relevance === 'relevant') {
        if (isAssessmentMetaQuery(reasoning, scopeCategory)) {
          const picked = pickResponseForIntent(sessionId, intent, { reasoning, scopeCategory, edgeCase });
          answerText = picked.text;
        } else {
          answerText = await answerRelevantGeneralQuestion(session, {
            spokenText,
            questionText,
            questionIndex: qIndex,
            totalQuestions,
          });
        }
      } else {
        const picked = pickResponseForIntent(sessionId, intent, {
          reasoning,
          scopeCategory,
          edgeCase,
          irrelevant: true,
        });
        answerText = picked.text;
      }

      const resumePrompt = buildResumePrompt(qIndex, questionText);
      const responseText = appendResumeOffer(answerText, qIndex, questionText);

      await saveInterviewAgentState(session, {
        currentQuestionIndex: qIndex,
        totalQuestions,
        currentQuestionId: questionId,
        currentQuestionText: questionText,
        isPaused: true,
        pauseReason: 'candidate_general_question',
        lastGeneralQuestion: spokenText,
        resumePrompt,
      });

      assessmentLog.scope('General query response sent', {
        sessionId,
        responseText: responseText.slice(0, 200),
        relevance,
      });

      return {
        intent,
        responseText,
        action: 'speak_with_resume_offer',
        resumeQuestionText: questionText,
        questionIndex: qIndex,
        removeFromTranscript: true,
        continueRecording: true,
        agentState: { isPaused: true, pauseReason: 'candidate_general_question' },
      };
    }

    if (intent === ASSESSMENT_INTENTS.IRRELEVANT_RESPONSE) {
      const picked = pickResponseForIntent(sessionId, intent, { reasoning });
      const responseText = appendResumeOffer(picked.text, qIndex, questionText);
      return {
        intent,
        responseText,
        templateIndex: picked.templateIndex,
        action: 'speak_with_resume_offer',
        resumeQuestionText: questionText,
        questionIndex: qIndex,
        removeFromTranscript: true,
        continueRecording: true,
      };
    }

    if (intent === ASSESSMENT_INTENTS.NOISE_OR_UNCLEAR_INPUT) {
      const picked = pickResponseForIntent(sessionId, intent, { reasoning });
      return {
        intent,
        responseText: picked.text,
        templateIndex: picked.templateIndex,
        action: 'speak',
        removeFromTranscript: true,
        continueRecording: true,
      };
    }

    const picked = pickResponseForIntent(sessionId, intent, { reasoning, edgeCase, scopeCategory });
    assessmentLog.response('Response dispatched', {
      sessionId,
      questionId,
      intent,
      responseText: picked.text?.slice(0, 220),
      audioGenerated: true,
      templateIndex: picked.templateIndex,
    });

    return {
      intent,
      responseText: picked.text,
      templateIndex: picked.templateIndex,
      action: picked.text ? 'speak' : 'continue_recording',
      removeFromTranscript: !!picked.text,
      continueRecording: true,
    };
  },

  silencePrompt(session) {
    const picked = pickSilencePrompt(session?.id);
    assessmentLog.question(
      'Silence threshold reached (30s)',
      { sessionId: session?.id, action: 'prompted_candidate' },
      'WARN'
    );
    return picked.text;
  },
};
