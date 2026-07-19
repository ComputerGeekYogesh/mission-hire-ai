import fs from 'fs';
import path from 'path';
import { getOpenAI } from '../../../config/openaiClient.js';
import { interviewConfig } from '../config.js';
import { pickBestSanitizedTranscript } from './answer-transcript-sanitize.service.js';

const openai = getOpenAI();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTranscriptText(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildWhisperPrompt({ skill } = {}) {
  const parts = [
    'Spoken answer by a job candidate during a technical interview.',
    skill ? `Topic: ${skill}.` : 'Topics: software development, Salesforce, Apex.',
    'Transcribe only what the candidate says, not the interviewer.',
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Transcribe answer audio with Whisper — retries once on transient failure.
 */
export async function transcribeAnswerAudio(filePath, { questionText, skill, sessionId, questionId } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[answer-transcription] OPENAI_API_KEY missing — cannot transcribe audio');
    return '';
  }
  if (!filePath || !fs.existsSync(filePath)) {
    console.warn('[answer-transcription] Audio file not found for transcription');
    return '';
  }

  const stat = fs.statSync(filePath);
  if (stat.size < (interviewConfig.answerTranscriptionMinBytes || 800)) {
    console.warn(
      `[answer-transcription] Audio too small (${stat.size} bytes) session=${sessionId} question=${questionId}`
    );
    return '';
  }

  const model = interviewConfig.answerTranscriptionModel || 'whisper-1';
  const language = interviewConfig.answerTranscriptionLanguage || 'en';
  const prompt = buildWhisperPrompt({ skill });
  const ext = path.extname(filePath).toLowerCase();
  const mimeHint = ext === '.webm' ? 'audio/webm' : ext === '.mp4' ? 'audio/mp4' : 'audio/mpeg';

  const maxAttempts = Math.max(1, Number(interviewConfig.answerTranscriptionRetries || 2));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const started = Date.now();
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model,
        language,
        prompt,
        response_format: 'verbose_json',
      });

      const text = normalizeTranscriptText(transcription.text);
      console.log(
        `[answer-transcription] Whisper OK session=${sessionId} question=${questionId} attempt=${attempt} bytes=${stat.size} chars=${text.length} ms=${Date.now() - started} format=${mimeHint}`
      );
      return text;
    } catch (err) {
      console.warn(
        `[answer-transcription] Whisper failed session=${sessionId} question=${questionId} attempt=${attempt}/${maxAttempts}:`,
        err.message
      );
      if (attempt < maxAttempts) {
        await sleep(interviewConfig.answerTranscriptionRetryDelayMs || 600);
      }
    }
  }

  return '';
}

/**
 * Pick transcript used for scoring — Whisper from audio is authoritative when available.
 */
export function resolveAuthoritativeAnswerTranscript({
  whisperText,
  clientText,
  minWhisperChars = 8,
  minClientChars = 10,
} = {}) {
  const whisper = normalizeTranscriptText(whisperText);
  const client = normalizeTranscriptText(clientText);

  if (whisper.length >= minWhisperChars) {
    return {
      transcript: whisper,
      source: 'whisper',
      whisperText: whisper,
      clientText: client,
      usedClientFallback: false,
    };
  }

  if (client.length >= minClientChars) {
    return {
      transcript: client,
      source: whisper.length ? 'client_fallback_whisper_short' : 'client_fallback',
      whisperText: whisper,
      clientText: client,
      usedClientFallback: true,
    };
  }

  const best = whisper.length >= client.length ? whisper : client;
  return {
    transcript: best,
    source: best === whisper && whisper ? 'whisper_partial' : best ? 'client_partial' : 'none',
    whisperText: whisper,
    clientText: client,
    usedClientFallback: best === client && !!client,
  };
}

/**
 * Resolve scoring transcript: always attempt Whisper when audio exists.
 */
export async function resolveAnswerTranscriptForScoring({
  filePath,
  clientText,
  questionText,
  skill,
  sessionId,
  questionId,
} = {}) {
  let whisperText = '';

  if (filePath) {
    whisperText = await transcribeAnswerAudio(filePath, {
      questionText,
      skill,
      sessionId,
      questionId,
    });
  }

  const resolved = resolveAuthoritativeAnswerTranscript({
    whisperText,
    clientText,
    minWhisperChars: Number(interviewConfig.answerTranscriptionMinChars || 8),
    minClientChars: Number(interviewConfig.answerTranscriptionClientFallbackMinChars || 10),
  });

  const sanitized = pickBestSanitizedTranscript(resolved.whisperText, resolved.clientText, {
    questionText,
  });

  const finalTranscript = sanitized.transcript || resolved.transcript;

  if (sanitized.sanitization?.whisper?.removedChars > 20) {
    console.log(
      `[answer-transcription] Sanitized whisper session=${sessionId} question=${questionId} removed=${sanitized.sanitization.whisper.removedChars} chars tokens=${sanitized.sanitization.whisper.meaningfulTokens}`
    );
  }

  return {
    ...resolved,
    transcript: finalTranscript,
    source: sanitized.source,
    whisperText: resolved.whisperText,
    clientText: resolved.clientText,
    sanitizedWhisper: sanitized.whisperCleaned,
    sanitizedClient: sanitized.clientCleaned,
    usedClientFallback: resolved.usedClientFallback,
  };
}
