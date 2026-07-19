/**
 * Classify spoken confirmation (yes/no) for auto-submit flow via Anthropic API.
 */
import {
  classifyConfirmation,
  CONFIDENCE_PROCEED,
  CONFIDENCE_CLARIFY,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  shouldProceed,
} from '../lib/confirmation-intent.js';

export {
  classifyConfirmation,
  CONFIDENCE_PROCEED,
  CONFIDENCE_CLARIFY,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  shouldProceed,
};

export async function classifyConfirmationIntent(spokenText) {
  const text = String(spokenText || '').trim();
  if (!text) return { intent: 'UNCLEAR', confidence: 0, tier: 'low' };

  const local = classifyConfirmation(text);
  if (shouldProceed(local)) {
    return { intent: local.intent, confidence: local.confidence, tier: local.tier };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[intent-classification] ANTHROPIC_API_KEY missing');
    return local;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

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
        max_tokens: 80,
        messages: [
          {
            role: 'user',
            content: `You classify voice responses for a video interview.

The candidate was asked: "Have you finished answering this question? Say next to move on, or resume to continue."

Their spoken response (may contain STT errors, filler words, or informal phrasing):
"${text}"

Intent rules:
- YES = wants to submit and go to the next question (next, move on, done, finished, proceed, go ahead, submit, etc.)
- NO = wants more time or to keep answering (resume, keep answering, not yet, wait, hold on, thinking, more time, skip for now, etc.)
- REPEAT_QUESTION = wants the interview question read again (repeat the question, say again, didn't catch, pardon, what was the question, etc.)
- UNCLEAR = ambiguous, off-topic, or cannot tell (maybe, hmm, unrelated)

Handle typos and STT errors generously (e.g. "yaa plz continew" = YES).

Reply ONLY with JSON, no markdown:
{"intent":"YES"|"NO"|"REPEAT_QUESTION"|"UNCLEAR","confidence":0.0-1.0}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.warn('[intent-classification] API error', response.status);
      return mergeLocalAndRemote(local, null);
    }

    const data = await response.json();
    const raw = data.content?.find((b) => b.type === 'text')?.text ?? '';
    const parsed = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    const intent = ['YES', 'NO', 'REPEAT_QUESTION', 'UNCLEAR'].includes(parsed.intent)
      ? parsed.intent
      : 'UNCLEAR';
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
    const remote = {
      intent,
      confidence,
      tier: tierFromConfidence(confidence),
    };
    return mergeLocalAndRemote(local, remote);
  } catch (e) {
    console.warn('[intent-classification]', e.message);
    return mergeLocalAndRemote(local, null);
  } finally {
    clearTimeout(timeoutId);
  }
}

function tierFromConfidence(confidence) {
  if (confidence >= CONFIDENCE_PROCEED) return 'high';
  if (confidence >= CONFIDENCE_CLARIFY) return 'medium';
  return 'low';
}

function mergeLocalAndRemote(local, remote) {
  if (!remote) return local;
  if (local.intent === remote.intent) {
    return {
      intent: remote.intent,
      confidence: Math.max(local.confidence, remote.confidence),
      tier: tierFromConfidence(Math.max(local.confidence, remote.confidence)),
    };
  }
  if (shouldProceed(local)) return local;
  if (remote.confidence >= CONFIDENCE_CLARIFY) return remote;
  return local.confidence >= remote.confidence ? local : remote;
}
