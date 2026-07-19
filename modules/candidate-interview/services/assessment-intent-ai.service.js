/**
 * AI-based semantic intent classification for candidate voice input during assessment.
 */
import { ASSESSMENT_INTENTS } from '../lib/assessment-intent.js';

const VALID_INTENTS = new Set(Object.values(ASSESSMENT_INTENTS));

const INTENT_ACTIONS = Object.freeze({
  [ASSESSMENT_INTENTS.ANSWER]: 'Continue recording answer',
  [ASSESSMENT_INTENTS.REPEAT_REQUEST]: 'Repeat question',
  [ASSESSMENT_INTENTS.CLARIFICATION_REQUEST]: 'Clarify and rephrase question',
  [ASSESSMENT_INTENTS.GENERAL_QUERY]: 'Answer or redirect general question and offer resume',
  [ASSESSMENT_INTENTS.IRRELEVANT_RESPONSE]: 'Prompt candidate to stay on topic',
  [ASSESSMENT_INTENTS.NOISE_OR_UNCLEAR_INPUT]: 'Ask candidate to repeat response',
  [ASSESSMENT_INTENTS.RESUME_REQUEST]: 'Resume current interview question',
  [ASSESSMENT_INTENTS.MOVE_TO_NEXT]: 'Acknowledge answer and advance to next question',
});

export function logAiIntent({ questionText, spokenText, intent, action, source = 'ai' }) {
  const question = String(questionText || '').trim() || '(none)';
  const input = String(spokenText || '').trim() || '(empty)';
  const classification = intent || 'UNKNOWN';
  const resolvedAction = action || INTENT_ACTIONS[classification] || 'Continue recording answer';
  console.log(`[AI_INTENT] Current Question: ${question}`);
  console.log(`[AI_INTENT] Candidate Input: ${input}`);
  console.log(`[AI_INTENT] Classification: ${classification}${source !== 'ai' ? ` (${source})` : ''}`);
  console.log(`[AI_INTENT] Action: ${resolvedAction}`);
}

function buildAssessmentStateBlock(assessmentState = {}) {
  const parts = [];
  if (assessmentState.phase) parts.push(`phase=${assessmentState.phase}`);
  if (assessmentState.question_index != null) parts.push(`question_index=${assessmentState.question_index}`);
  if (assessmentState.answered_count != null) parts.push(`answered_count=${assessmentState.answered_count}`);
  if (assessmentState.total_questions != null) parts.push(`total_questions=${assessmentState.total_questions}`);
  if (assessmentState.recording != null) parts.push(`recording=${assessmentState.recording}`);
  if (assessmentState.confirmation_pending != null) {
    parts.push(`confirmation_pending=${assessmentState.confirmation_pending}`);
  }
  if (assessmentState.is_paused != null) parts.push(`is_paused=${assessmentState.is_paused}`);
  return parts.length ? parts.join(', ') : 'recording_answer';
}

function parseAiJson(raw) {
  const cleaned = String(raw || '')
    .replace(/```json|```/gi, '')
    .trim();
  return JSON.parse(cleaned);
}

/**
 * @param {{ spokenText: string, questionText: string, assessmentState?: object }} params
 */
export async function classifyAssessmentIntentWithAI({
  spokenText,
  questionText,
  assessmentState = {},
}) {
  const text = String(spokenText || '').trim();
  const question = String(questionText || '').trim();

  if (!text) {
    return {
      intent: ASSESSMENT_INTENTS.NOISE_OR_UNCLEAR_INPUT,
      confidence: 0.95,
      reasoning: 'empty_input',
      source: 'local',
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 120,
        messages: [
          {
            role: 'user',
            content: `You classify candidate voice input during a structured video assessment interview.

Current interview question:
"${question || '(unknown)'}"

Candidate spoken transcript (may contain speech-to-text errors, filler words, or informal phrasing):
"${text}"

Assessment state: ${buildAssessmentStateBlock(assessmentState)}

Classify the candidate input into exactly ONE intent:

1. ANSWER — Candidate is attempting to answer the interview question (including partial answers, "I don't know", profanity venting, or answers that relate semantically even without repeating question keywords).
2. REPEAT_REQUEST — Candidate wants the question read again (repeat, say again, pardon, didn't hear, what was the question, etc.).
3. CLARIFICATION_REQUEST — Candidate wants the current question explained or rephrased for understanding (explain the question, what do you mean by X, clarify the requirement, etc.). NOT general knowledge or off-topic questions.
4. GENERAL_QUERY — Candidate asks a question directed at the system rather than answering the interview question. Includes trivia/off-topic chat AND interview-relevant questions (role, team, process, assessment format/duration). Set general_relevance to "relevant" for role/process/company/assessment-meta questions; "irrelevant" for trivia, news, weather, jokes, homework, unrelated facts.
5. IRRELEVANT_RESPONSE — Candidate speaks substantively but the content has no meaningful relationship to the current interview question (unrelated personal anecdotes, off-topic statements that are not questions).
6. NOISE_OR_UNCLEAR_INPUT — Background noise, fragments, single filler words, incomplete/unrecognizable speech, or too little content to classify.
7. RESUME_REQUEST — Candidate wants to resume the interview after a pause (e.g. "let's resume", "okay continue", "ready to go back"). Only when is_paused=true. NOT when they say "resume" during confirmation to keep answering.
8. MOVE_TO_NEXT — Candidate explicitly wants to finish the current question and advance (e.g. "next question", "move on", "that covers it, next please"). Only when is_paused=false and NOT during confirmation_pending.

Rules:
- Use semantic relevance to the CURRENT question, not keyword matching.
- "I have worked on REST APIs using Express and MongoDB" for a Node.js question → ANSWER.
- "Who is the Prime Minister of India?" → GENERAL_QUERY with general_relevance "irrelevant".
- "What's the team size I'd be joining?" → GENERAL_QUERY with general_relevance "relevant".
- "Can you repeat the question?" → REPEAT_REQUEST.
- "What do you mean by leadership experience?" → CLARIFICATION_REQUEST.
- "I went to the market yesterday" for a Java experience question → IRRELEVANT_RESPONSE.
- "Next question please" while recording an answer → MOVE_TO_NEXT.
- When is_paused=true and candidate says "let's resume" → RESUME_REQUEST.
- Prefer ANSWER when the candidate is clearly attempting a substantive response related to the question topic.
- Do NOT classify based on keywords alone.

Reply ONLY with JSON, no markdown:
{"intent":"ANSWER"|"REPEAT_REQUEST"|"CLARIFICATION_REQUEST"|"GENERAL_QUERY"|"IRRELEVANT_RESPONSE"|"NOISE_OR_UNCLEAR_INPUT"|"RESUME_REQUEST"|"MOVE_TO_NEXT","confidence":0.0-1.0,"reasoning":"brief","general_relevance":"relevant"|"irrelevant"|null}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.warn('[assessment-intent-ai] API error', response.status);
      return null;
    }

    const data = await response.json();
    const raw = data.content?.find((b) => b.type === 'text')?.text ?? '';
    const parsed = parseAiJson(raw);
    const intent = VALID_INTENTS.has(parsed.intent) ? parsed.intent : ASSESSMENT_INTENTS.ANSWER;
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5));

    const generalRelevance =
      parsed.general_relevance === 'relevant' || parsed.general_relevance === 'irrelevant'
        ? parsed.general_relevance
        : null;

    return {
      intent,
      confidence,
      reasoning: String(parsed.reasoning || 'ai_classification').slice(0, 200),
      generalRelevance,
      source: 'ai',
    };
  } catch (e) {
    console.warn('[assessment-intent-ai]', e.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export { INTENT_ACTIONS };
