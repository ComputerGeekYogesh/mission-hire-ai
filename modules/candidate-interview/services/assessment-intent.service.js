import {
  classifyIntent,
  ASSESSMENT_INTENTS,
  normalizeAssessmentIntent,
} from '../lib/assessment-intent.js';
import {
  classifyAssessmentIntentWithAI,
  logAiIntent,
  INTENT_ACTIONS,
} from './assessment-intent-ai.service.js';
import { assessmentLog } from './assessment-interaction-log.service.js';

function mergeAiAndLocal(aiResult, localResult) {
  if (!aiResult) return { ...localResult, source: localResult.source || 'local' };

  const merged = { ...aiResult, source: 'ai' };

  if (aiResult.intent === ASSESSMENT_INTENTS.ANSWER && localResult?.edgeCase) {
    merged.edgeCase = localResult.edgeCase;
  }

  if (!merged.generalRelevance && localResult?.generalRelevance) {
    merged.generalRelevance = localResult.generalRelevance;
  }
  if (!merged.scopeCategory && localResult?.scopeCategory) {
    merged.scopeCategory = localResult.scopeCategory;
  }

  return merged;
}

export async function classifyCandidateInput(
  rawInput,
  {
    questionText = '',
    questionId = null,
    sessionId = null,
    assessmentState = null,
  } = {}
) {
  const raw = String(rawInput || '').trim();
  const isPaused = !!assessmentState?.is_paused;

  assessmentLog.intent('Input received', {
    sessionId,
    questionId,
    rawInput: raw.slice(0, 500),
    assessmentState,
    timestamp: new Date().toISOString(),
  });

  const local = classifyIntent(raw, { questionText, questionId, isPaused });

  let classification = local;
  if (raw) {
    const aiResult = await classifyAssessmentIntentWithAI({
      spokenText: raw,
      questionText,
      assessmentState: assessmentState || {},
    });
    classification = mergeAiAndLocal(aiResult, local);
    classification.intent = normalizeAssessmentIntent(classification.intent);
  }

  const actionLabel = INTENT_ACTIONS[classification.intent] || 'Continue recording answer';
  logAiIntent({
    questionText,
    spokenText: raw,
    intent: classification.intent,
    action: actionLabel,
    source: classification.source || 'local',
  });

  assessmentLog.intent('Intent classified', {
    sessionId,
    questionId,
    intent: classification.intent,
    confidence: Number(classification.confidence?.toFixed?.(3) ?? classification.confidence),
    reasoning: classification.reasoning,
    edgeCase: classification.edgeCase || null,
    scopeCategory: classification.scopeCategory || null,
    source: classification.source || 'local',
  });

  if (classification.ambiguous) {
    assessmentLog.intent(
      'Ambiguous intent detected',
      {
        sessionId,
        questionId,
        rawInput: raw.slice(0, 200),
        candidateIntents: (classification.candidates || []).map((c) => ({
          intent: c.intent,
          confidence: c.confidence,
        })),
        resolvedTo: classification.intent,
      },
      'WARN'
    );
  }

  return classification;
}

export { ASSESSMENT_INTENTS };
