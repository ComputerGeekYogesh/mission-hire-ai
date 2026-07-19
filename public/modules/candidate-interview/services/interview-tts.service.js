Add below code in files 
 
/**
 * Browser interview TTS.
 * Prefer ElevenLabs with an Indian female voice. If a Vapi assistant is configured, its
 * voice can still be used as a fallback/default source.
 */
import axios from 'axios';
import { getOpenAI } from '../../../../config/openaiClient.js';
import {
  getInterviewAssistantId,
  vapiGetAssistant,
  buildAssistantOverridesBase,
} from '../../voice/vapi.client.js';
 
const MAX_TEXT_LEN = 2500;
const ASSISTANT_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_ELEVENLABS_SPEED = 0.85;
 
let assistantCache = { at: 0, voice: null, assistantId: null };
let elevenVoiceCache = { at: 0, voiceId: null, name: null };
 
function getElevenLabsApiKey() {
  return (
    process.env.ELEVENLABS_API_KEY?.trim() ||
    process.env.ELEVEN_LABS_API_KEY?.trim() ||
    process.env.ELEVEN_LAPS_API_KEY?.trim() ||
    ''
  );
}
 
function defaultVoiceFromEnv() {
  const envEleven = voiceFromElevenLabsEnv();
  if (envEleven) return envEleven;
  if (process.env.AZURE_SPEECH_KEY?.trim()) {
    return {
      provider: 'azure',
      voiceId: process.env.INTERVIEW_AZURE_VOICE?.trim() || 'en-IN-NeerjaNeural',
    };
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return { provider: 'openai', voiceId: process.env.INTERVIEW_OPENAI_TTS_VOICE?.trim() || 'nova' };
  }
  return null;
}
 
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
 
/** Prefer ELEVENLABS_VOICE_ID from .env for browser interview (Indian female voice). */
function voiceFromElevenLabsEnv() {
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) return null;
 
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  return {
    provider: '11labs',
    voiceId: voiceId || null,
    voiceName: process.env.ELEVENLABS_VOICE_NAME?.trim() || null,
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
  return !!(
    getElevenLabsApiKey() ||
    process.env.AZURE_SPEECH_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    (process.env.VAPI_PRIVATE_KEY?.trim() && getInterviewAssistantId())
  );
}
 
async function loadVapiVoiceConfig() {
  const assistantId = getInterviewAssistantId();
  const envDefault = defaultVoiceFromEnv();
  if (envDefault) return envDefault;
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
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is required when using ElevenLabs TTS');
  }
  const voiceId = await resolveElevenLabsVoiceId(voice);
  if (!voiceId) throw new Error('ElevenLabs voice id could not be resolved');
 
  const modelId =
    voice.model ||
    voice.modelId ||
    process.env.ELEVENLABS_MODEL_ID ||
    'eleven_multilingual_v2';
 
  const body = {
    text,
    model_id: modelId,
  };
  const voiceSettings = {};
  if (voice.stability != null) voiceSettings.stability = voice.stability;
  if (voice.similarityBoost != null) voiceSettings.similarity_boost = voice.similarityBoost;
  if (voice.similarity_boost != null) voiceSettings.similarity_boost = voice.similarity_boost;
  voiceSettings.speed = clampNumber(
    process.env.ELEVENLABS_VOICE_SPEED ?? voice.speed,
    0.7,
    1.2,
    DEFAULT_ELEVENLABS_SPEED
  );
  if (Object.keys(voiceSettings).length) body.voice_settings = voiceSettings;
 
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
 
function scoreElevenVoice(voice, preferredName) {
  const name = String(voice?.name || '').toLowerCase();
  const labels = voice?.labels && typeof voice.labels === 'object' ? voice.labels : {};
  const labelText = Object.values(labels).join(' ').toLowerCase();
  const text = `${name} ${labelText}`;
 
  let score = 0;
  if (preferredName && name === preferredName.toLowerCase()) score += 1000;
  else if (preferredName && name.includes(preferredName.toLowerCase())) score += 700;
 
  if (/\bindian\b|\bindia\b|\ben-in\b|\bhindi\b|\bhinglish\b/.test(text)) score += 250;
  if (/\bfemale\b|\bwoman\b|\bgirl\b/.test(text)) score += 170;
  if (/\benglish\b|\ben\b/.test(text)) score += 50;
 
  if (/\bmale\b|\bman\b|\bboy\b/.test(text)) score -= 220;
  if (/\baustralian\b|\bbritish\b|\bamerican\b|\bus\b/.test(text)) score -= 35;
  return score;
}
 
async function resolveElevenLabsVoiceId(voice = {}) {
  const explicit = process.env.ELEVENLABS_VOICE_ID?.trim() || voice.voiceId || voice.voice_id;
  if (explicit) return explicit;
 
  const now = Date.now();
  if (elevenVoiceCache.voiceId && now - elevenVoiceCache.at < ASSISTANT_CACHE_MS) {
    return elevenVoiceCache.voiceId;
  }
 
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) return null;
 
  const preferredName = process.env.ELEVENLABS_VOICE_NAME?.trim() || voice.voiceName || voice.name || '';
  const { data } = await axios.get('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
    timeout: 30000,
  });
 
  const voices = Array.isArray(data?.voices) ? data.voices : [];
  if (!voices.length) return null;
 
  const ranked = voices
    .map((v) => ({ voice: v, score: scoreElevenVoice(v, preferredName) }))
    .sort((a, b) => b.score - a.score);
 
  const selected = ranked[0]?.voice;
  elevenVoiceCache = {
    at: now,
    voiceId: selected?.voice_id || null,
    name: selected?.name || null,
  };
 
  if (selected?.voice_id) {
    console.log(`[InterviewTTS] Using ElevenLabs voice: ${selected.name || selected.voice_id}`);
  }
  return selected?.voice_id || null;
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
 
  if (getElevenLabsApiKey()) {
    return synthesize11labs(text, {
      voiceId: process.env.ELEVENLABS_VOICE_ID || voice?.voiceId,
      model: 'eleven_multilingual_v2',
    });
  }
 
  if (process.env.OPENAI_API_KEY?.trim()) {
    return synthesizeOpenAI(text, { voiceId: 'nova' });
  }
 
  throw new Error(`Unsupported voice provider for browser TTS: ${provider || 'unknown'}`);
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
    throw new Error('Interview TTS voice is not configured');
  }
 
  return synthesizeWithVoice(trimmed, voice);
}
 