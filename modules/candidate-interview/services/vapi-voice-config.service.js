/**
 * Minimal Vapi assistant voice config for browser interview TTS (no telephony).
 */
import axios from 'axios';

const VAPI_BASE = 'https://api.vapi.ai';

function trimEnvId(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s || null;
}

export function getInterviewAssistantId() {
  const raw = process.env.VAPI_ASSISTANT_ID || process.env.VAPI_ASSISTANT_ID_INTERVIEW;
  return trimEnvId(raw);
}

function voiceOverridesFromEnv() {
  const raw = process.env.VAPI_VOICE;
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).trim();
  if (s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object' && parsed.provider === 'elevenlabs') {
        parsed.provider = '11labs';
      }
      return parsed;
    } catch {
      return null;
    }
  }
  return { provider: '11labs', voiceId: s };
}

export function buildAssistantOverridesBase() {
  const voice = voiceOverridesFromEnv();
  if (!voice) return undefined;
  return { voice };
}

/** Fetch assistant config (voice, model) from Vapi dashboard assistant id. */
export async function vapiGetAssistant(assistantId) {
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) throw new Error('VAPI_PRIVATE_KEY is not set');
  const id = trimEnvId(assistantId) || getInterviewAssistantId();
  if (!id) throw new Error('VAPI_ASSISTANT_ID is not set');
  const { data } = await axios.get(`${VAPI_BASE}/assistant/${id}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
  return data;
}
