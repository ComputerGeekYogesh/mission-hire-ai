/**
 * Question generation + jobs/api_calls rows for browser video interviews.
 * (Extracted from legacy twilio.js telephony stack.)
 */
import db from '../../../config/db.js';
import { getOpenAI } from '../../../config/openaiClient.js';

const openai = getOpenAI();
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'Asia/Kolkata';
const FALLBACK_API_USER_ID = Number(process.env.MOCK_INTERVIEW_DEFAULT_USER_ID || 1);

function toNullableInt(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw || raw === 'null' || raw === 'undefined' || raw === 'nan') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toMysqlDateTime(input) {
  if (!input) return null;
  const dt = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dt.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

function missionMinQuestionCountFromDescription(description = '') {
  const text = String(description || '');
  const match =
    text.match(/(?:ask|at\s*least|minimum|least)\D{0,20}(\d{1,2})\s+questions?/i) ||
    text.match(/\b(\d{1,2})\s+questions?\b/i);
  if (!match) return 1;
  return Math.max(1, Math.min(Number(match[1]) || 1, 15));
}

function toTimezoneAbbreviation(tz = '') {
  const value = String(tz || '').trim();
  if (!value) return 'IST';
  const upper = value.toUpperCase();
  if (['IST', 'UTC', 'GMT', 'PST', 'EST', 'CST', 'MST', 'CET', 'EET', 'BST'].includes(upper)) {
    return upper;
  }
  const map = {
    'ASIA/KOLKATA': 'IST',
    'AMERICA/NEW_YORK': 'EST',
    'AMERICA/CHICAGO': 'CST',
    'AMERICA/DENVER': 'MST',
    'AMERICA/LOS_ANGELES': 'PST',
    'EUROPE/LONDON': 'GMT',
    'EUROPE/PARIS': 'CET',
  };
  return map[upper] || 'IST';
}

function getTimezoneOffsetMinutes(tz = '') {
  const value = String(tz || '').trim().toUpperCase();
  const table = {
    IST: 330,
    UTC: 0,
    GMT: 0,
    PST: -480,
    PDT: -420,
    MST: -420,
    MDT: -360,
    CST: -360,
    CDT: -300,
    EST: -300,
    EDT: -240,
    'ASIA/KOLKATA': 330,
    'AMERICA/LOS_ANGELES': -480,
    'AMERICA/NEW_YORK': -300,
    'EUROPE/LONDON': 0,
  };
  return table[value] ?? 330;
}

function toMysqlDateTimeByOffset(utcDate, offsetMinutes = 0) {
  if (!(utcDate instanceof Date) || Number.isNaN(utcDate.getTime())) return null;
  const shifted = new Date(utcDate.getTime() + offsetMinutes * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

export function extractQuestionCountFromDescription(description = '') {
  const text = String(description || '');
  const match =
    text.match(/(?:ask|at\s*least|minimum|least)\D{0,20}(\d{1,2})\s+questions?/i) ||
    text.match(/(\d{1,2})\s+questions?/i);
  const count = match ? Number(match[1]) : 5;
  return Math.max(3, Math.min(count, 15));
}

export async function generateMockInterviewQuestions({ jobTitle, experience, description, count }) {
  const prompt = `Generate exactly ${count} interview questions for a ${jobTitle} role.
Candidate experience: ${experience || 'Not specified'}.
Context: ${description || 'No additional context provided'}.
Rules:
- Questions must be concise and interview-friendly.
- Mix technical and practical scenario-based questions.
- Return ONLY a valid JSON array of strings.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
  });

  let raw = response.choices?.[0]?.message?.content?.trim() || '[]';
  raw = raw.replace(/```json|```/gi, '').trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((q) => String(q || '').trim())
    .filter(Boolean)
    .slice(0, count);
}

export async function generateMissionInterviewQuestionsFromJob({ jobTitle, experience, description }) {
  const title = String(jobTitle || 'Open role').trim();
  const exp = String(experience || 'Not specified').trim();
  const desc = String(description || '').trim().slice(0, 8000);
  const minFromDesc = missionMinQuestionCountFromDescription(description);

  const prompt = `You design a structured video screening interview for a job opening.

Job title: ${title}
Expected experience: ${exp}
Full job description:
${desc || '(none)'}

Tasks:
1) Extract 3-10 key skills or topics to assess from the title and description only.
2) Decide targetCount: how many distinct main interview questions to ask.
   - If the description specifies a minimum or exact number of questions, targetCount must be at least that number.
   - Otherwise targetCount = max(1, number of skills you listed).
   - targetCount must be between 1 and 15 inclusive.
3) Write exactly targetCount concise interview questions (one sentence each).

Return ONLY valid JSON:
{"skills":["skill one"],"targetCount":5,"questions":["..."]}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.35,
    response_format: { type: 'json_object' },
  });

  let raw = response.choices?.[0]?.message?.content?.trim() || '{}';
  raw = raw.replace(/```json|```/gi, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
  const rawQs = Array.isArray(parsed.questions) ? parsed.questions : [];
  let target = Number(parsed.targetCount);
  if (!Number.isFinite(target) || target < 1) {
    target = skills.length > 0 ? Math.max(minFromDesc, skills.length) : Math.max(minFromDesc, 3);
  }
  target = Math.min(15, Math.max(minFromDesc, target));

  const questions = rawQs.map((q) => String(q || '').trim()).filter(Boolean);

  if (questions.length >= target) {
    return questions.slice(0, target);
  }
  if (questions.length) {
    const pad = await generateMockInterviewQuestions({
      jobTitle,
      experience,
      description,
      count: target - questions.length,
    });
    return [...questions, ...pad].filter(Boolean).slice(0, target);
  }
  return generateMockInterviewQuestions({
    jobTitle,
    experience,
    description,
    count: target,
  });
}

export function normalizeCustomQuestions(questions = []) {
  return questions
    .map((q) => {
      if (typeof q === 'string') return q.trim();
      if (q && typeof q.question === 'string') return q.question.trim();
      return '';
    })
    .filter(Boolean);
}

export async function insertApiMockInterviewData({
  callId,
  payload,
  normalizedQuestions,
  status,
  feedbackUrl,
  scheduledAtUtcDate,
}) {
  const { candidate = {}, job = {}, interview = {}, schedule = {}, callback = {} } = payload;

  const timezoneOffset = getTimezoneOffsetMinutes(schedule.timezone || 'IST');
  const scheduledAt = toMysqlDateTimeByOffset(scheduledAtUtcDate, timezoneOffset);
  const [callInsert] = await db.query(
    `INSERT INTO api_calls
      (call_id, status, candidate_name, candidate_email, candidate_phone, job_title, department, description, company, experience, interview_type, follow_up_enabled, scoring_enabled, scheduled_at, timezone_name, retry_attempts, retry_interval_minutes, callback_webhook_url, callback_webhook_secret, feedback_url, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      callId,
      status,
      candidate.name || null,
      candidate.email || null,
      candidate.phone || null,
      job.title || null,
      job.department || null,
      job.description || null,
      job.company || null,
      job.experience || null,
      interview.type || null,
      interview.follow_up_enabled ? 1 : 0,
      interview.scoring_enabled ? 1 : 0,
      scheduledAt,
      schedule.timezone || null,
      Number(schedule.retry_attempts || 0),
      Number(schedule.retry_interval_minutes || 0),
      callback.webhook_url || null,
      callback.webhook_secret || null,
      feedbackUrl,
      JSON.stringify(payload),
    ]
  );

  const apiCallPk = callInsert.insertId;

  for (let i = 0; i < normalizedQuestions.length; i++) {
    await db.query(
      `INSERT INTO api_call_questions (api_call_id, call_id, question_order, question, category, required_flag, source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        apiCallPk,
        callId,
        i + 1,
        normalizedQuestions[i],
        payload.interview?.questions?.[i]?.category || null,
        payload.interview?.questions?.[i]?.required ? 1 : 0,
        payload.interview?.questions?.length ? 'custom' : 'ai_generated',
      ]
    );
  }

  await db.query(
    `INSERT INTO api_call_callbacks (api_call_id, call_id, webhook_url, webhook_secret, delivery_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`,
    [apiCallPk, callId, payload.callback?.webhook_url || null, payload.callback?.webhook_secret || null]
  );
}

export async function insertJobForMockInterview({
  callId,
  candidate,
  job,
  normalizedQuestions,
  schedule,
  accountContext,
}) {
  const callAt = schedule?.call_at ? new Date(schedule.call_at) : new Date();
  const isFuture = callAt.getTime() > Date.now() + 5000;
  const timezone = schedule?.timezone || DEFAULT_TZ;
  const timezoneAbbreviation = toTimezoneAbbreviation(timezone);
  const timezoneOffset = getTimezoneOffsetMinutes(timezone || timezoneAbbreviation);
  const scheduledDatetimeLocal = toMysqlDateTimeByOffset(callAt, timezoneOffset);
  const scheduledDatetimeUtc = toMysqlDateTime(callAt);

  const normalizedUserId = toNullableInt(accountContext?.userId) ?? FALLBACK_API_USER_ID;
  const normalizedSuperAdmin = toNullableInt(accountContext?.isSuperAdmin) ?? 0;
  const normalizedAccountId = toNullableInt(accountContext?.accountId);
  const callSchedule =
    schedule?.skip_outbound === true || schedule?.call_schedule === 'no' ? 'no' : 'yes';
  const enhancedDescription = JSON.stringify({
    source: 'browser_video_interview',
    department: job.department || null,
    ...(schedule?.transport ? { transport: schedule.transport } : {}),
  });

  await db.query(
    `INSERT INTO jobs
      (user_id, is_super_admin, account_id, job_id, title, description, experience, job_status, names, emails, numbers, questions, question_count, call_schedule, scheduled_datetime, scheduled_datetime_utc, timezone_abbreviation, created_by, enhanced_description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normalizedUserId,
      normalizedSuperAdmin,
      normalizedAccountId,
      callId,
      job.title || 'Interview',
      job.description || '',
      job.experience || '',
      'Pending',
      candidate.name || 'Candidate',
      candidate.email || null,
      candidate.phone,
      JSON.stringify(normalizedQuestions),
      normalizedQuestions.length,
      callSchedule,
      scheduledDatetimeLocal,
      scheduledDatetimeUtc,
      timezoneAbbreviation,
      normalizedUserId,
      enhancedDescription,
    ]
  );

  return { callAt, isFuture };
}
