/**
 * Browser interview TTS via the same voice as the Vapi assistant (Indian accent from dashboard).
 * Requires VAPI_PRIVATE_KEY + VAPI_ASSISTANT_ID and a provider API key (ELEVENLABS_API_KEY, etc.).
 */
import axios from 'axios';
import { getOpenAI } from '../../../config/openaiClient.js';
import {
  getInterviewAssistantId,
  vapiGetAssistant,
  buildAssistantOverridesBase,
} from './vapi-voice-config.service.js';

const MAX_TEXT_LEN = 2500;
const ASSISTANT_CACHE_MS = 10 * 60 * 1000;

let assistantCache = { at: 0, voice: null, assistantId: null };

/** Prefer ELEVENLABS_VOICE_ID from .env for browser interview (Indian accent). */
function voiceFromElevenLabsEnv() {
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!voiceId || !apiKey) return null;
  return {
    provider: '11labs',
    voiceId,
    model: process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_multilingual_v2',
  };
}

function mergeInterviewVoice(voice) {
  const envEleven = voiceFromElevenLabsEnv();
  if (envEleven) {
    return { ...(voice && typeof voice === 'object' ? voice : {}), ...envEleven };
  }
  const vapiEnv = buildAssistantOverridesBase()?.voice;
  if (vapiEnv) {
    return { ...(voice && typeof voice === 'object' ? voice : {}), ...vapiEnv };
  }
  return voice;
}

function normalizeProvider(provider) {
  const p = String(provider || '')
    .toLowerCase()
    .trim();
  if (p === 'elevenlabs') return '11labs';
  return p;
}

export function isInterviewVapiTtsEnabled() {
  if (process.env.INTERVIEW_TTS_ENABLED === '0') return false;
  if (!process.env.VAPI_PRIVATE_KEY?.trim()) return false;
  if (!getInterviewAssistantId()) return false;
  return !!(
    process.env.ELEVENLABS_API_KEY?.trim() ||
    process.env.AZURE_SPEECH_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim()
  );
}

async function loadVapiVoiceConfig() {
  const assistantId = getInterviewAssistantId();
  if (!assistantId) return null;

  const now = Date.now();
  if (
    assistantCache.voice &&
    assistantCache.assistantId === assistantId &&
    now - assistantCache.at < ASSISTANT_CACHE_MS
  ) {
    return assistantCache.voice;
  }

  const envVoice = buildAssistantOverridesBase()?.voice;
  let voice = envVoice || null;

  try {
    const assistant = await vapiGetAssistant(assistantId);
    voice = assistant?.voice || voice;
  } catch (e) {
    console.warn('[InterviewTTS] Could not load Vapi assistant voice:', e.message);
    if (!voice) throw e;
  }

  voice = mergeInterviewVoice(voice);

  assistantCache = { at: now, voice, assistantId };
  return voice;
}

async function synthesize11labs(text, voice) {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is required when the Vapi assistant uses ElevenLabs');
  }
  const voiceId =
    process.env.ELEVENLABS_VOICE_ID?.trim() || voice.voiceId || voice.voice_id;
  if (!voiceId) throw new Error('Vapi assistant voice is missing voiceId');

  const modelId =
    voice.model ||
    voice.modelId ||
    process.env.ELEVENLABS_MODEL_ID ||
    'eleven_multilingual_v2';

  const body = {
    text,
    model_id: modelId,
  };
  if (voice.stability != null) body.stability = voice.stability;
  if (voice.similarityBoost != null) body.similarity_boost = voice.similarityBoost;
  if (voice.similarity_boost != null) body.similarity_boost = voice.similarity_boost;

  const { data } = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    body,
    {
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      responseType: 'arraybuffer',
      timeout: 60000,
    }
  );

  return { buffer: Buffer.from(data), contentType: 'audio/mpeg' };
}

async function synthesizeOpenAI(text, voice) {
  const openai = getOpenAI();
  const allowed = new Set(['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer']);
  let voiceName = String(voice.voiceId || voice.voice || 'nova').toLowerCase();
  if (!allowed.has(voiceName)) voiceName = 'nova';

  const model = voice.model || process.env.INTERVIEW_OPENAI_TTS_MODEL || 'tts-1';
  const response = await openai.audio.speech.create({
    model,
    voice: voiceName,
    input: text,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType: 'audio/mpeg' };
}

async function synthesizeAzureIndian(text, voiceNameOverride) {
  const key = process.env.AZURE_SPEECH_KEY?.trim();
  const region = process.env.AZURE_SPEECH_REGION?.trim() || 'centralindia';
  if (!key) throw new Error('AZURE_SPEECH_KEY is not set');

  const voiceName =
    voiceNameOverride ||
    process.env.INTERVIEW_AZURE_VOICE?.trim() ||
    'en-IN-NeerjaNeural';

  const ssml = `<speak version="1.0" xml:lang="en-IN"><voice name="${voiceName}">${escapeXml(
    text
  )}</voice></speak>`;

  const { data } = await axios.post(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    ssml,
    {
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
      },
      responseType: 'arraybuffer',
      timeout: 60000,
    }
  );

  return { buffer: Buffer.from(data), contentType: 'audio/mpeg' };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function synthesizeWithVoice(text, voice) {
  const provider = normalizeProvider(voice?.provider);

  if (provider === '11labs') {
    try {
      return await synthesize11labs(text, voice);
    } catch (e) {
      if (process.env.AZURE_SPEECH_KEY?.trim()) {
        console.warn('[InterviewTTS] ElevenLabs failed, using Azure en-IN:', e.message);
        return synthesizeAzureIndian(text);
      }
      throw e;
    }
  }

  if (provider === 'openai') {
    return synthesizeOpenAI(text, voice);
  }

  if (provider === 'azure') {
    const azureVoice = voice.voiceId || voice.voice;
    return synthesizeAzureIndian(text, azureVoice);
  }

  if (process.env.AZURE_SPEECH_KEY?.trim()) {
    console.warn(`[InterviewTTS] Unsupported Vapi provider "${provider}", using Azure en-IN fallback`);
    return synthesizeAzureIndian(text);
  }

  if (process.env.ELEVENLABS_API_KEY?.trim()) {
    return synthesize11labs(text, {
      voiceId: process.env.ELEVENLABS_VOICE_ID || voice?.voiceId,
      model: 'eleven_multilingual_v2',
    });
  }

  if (process.env.OPENAI_API_KEY?.trim()) {
    return synthesizeOpenAI(text, { voiceId: 'nova' });
  }

  throw new Error(`Unsupported Vapi voice provider for browser TTS: ${provider || 'unknown'}`);
}

/**
 * @param {string} text
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function synthesizeInterviewSpeech(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Text is required');
  if (trimmed.length > MAX_TEXT_LEN) {
    throw new Error(`Text exceeds maximum length (${MAX_TEXT_LEN})`);
  }

  const voice = await loadVapiVoiceConfig();
  if (!voice) {
    throw new Error('Vapi assistant voice is not configured');
  }

  return synthesizeWithVoice(trimmed, voice);
}
