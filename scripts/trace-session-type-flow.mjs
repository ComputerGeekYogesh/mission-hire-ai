/**
 * Traces where session_type is lost for Mission chat vs API schedule paths.
 * Run: node scripts/trace-session-type-flow.mjs
 */
import { SESSION_TYPES, resolveSessionLabelsFromSession, getSessionTypeFromSession } from '../modules/candidate-interview/lib/session-labels.js';

// Simulates buildSchedulePayload() output (interview-chat-schedule.service.js:402-423)
const chatSchedulePayload = {
  candidate_name: 'Yogesh Saini',
  candidate_email: process.env.TRACE_TEST_EMAIL || 'candidate@example.com',
  interview_type: 'browser_video',
  scheduled_at: '2026-07-09 14:00:00',
  timezone: 'Asia/Kolkata',
  send_invite: true,
  source: 'schedule_chat',
  session_type: 'interview',
  job_meta: { title: 'Software Engineer' },
  interview_questions: [{ order: 1, question: 'Tell me about yourself', source_type: 'custom' }],
};

// Simulates metadata_json written by sessionService.scheduleInterview (session.service.js:76-93)
function simulateStoredMetadata(input) {
  return {
    timezone: input.timezone || 'Asia/Kolkata',
    source: input.source || 'web',
    ...(input.session_type ? { session_type: input.session_type } : {}),
    job: input.job_meta || null,
    interview: input.interview_questions?.length ? { questions: input.interview_questions } : {},
  };
}

// Simulates API path validated payload (schedule-video-api.validator.js)
const apiValidatedPayload = {
  ...chatSchedulePayload,
  session_type: SESSION_TYPES.INTERVIEW,
  source: 'api',
};

console.log('=== 1. Mission chat UI path (POST /admin/interviews/schedule/message) ===');
console.log('Endpoint called:', 'POST /admin/interviews/schedule/message');
console.log('NOT called:', 'POST /api/v1/schedule/video-interview');
console.log('Chat schedulePayload keys:', Object.keys(chatSchedulePayload).join(', '));
console.log('Chat schedulePayload.type / session_type present?', {
  type: chatSchedulePayload.type ?? '(missing)',
  session_type: chatSchedulePayload.session_type ?? '(missing)',
});

const chatMeta = simulateStoredMetadata(chatSchedulePayload);
console.log('Stored metadata_json.session_type:', chatMeta.session_type ?? '(missing — defaults to skill_assessment)');

const chatSession = { metadata_json: chatMeta, candidate_name: chatSchedulePayload.candidate_name };
console.log('Resolved session type:', getSessionTypeFromSession(chatSession));
console.log('Resolved completionTitle:', resolveSessionLabelsFromSession(chatSession).completionTitle);

console.log('\n=== 2. API path (POST /api/v1/schedule/video-interview) ===');
console.log('API validated.session_type:', apiValidatedPayload.session_type);
const apiMeta = simulateStoredMetadata(apiValidatedPayload);
console.log('Stored metadata_json.session_type:', apiMeta.session_type);
const apiSession = { metadata_json: apiMeta, candidate_name: apiValidatedPayload.candidate_name };
console.log('Resolved completionTitle:', resolveSessionLabelsFromSession(apiSession).completionTitle);

console.log('\n=== 3. Invite email path (after fix) ===');
console.log('Chat fulfillBrowserSingle → sendInvite(..., { sessionLabels }) — labels now passed');
console.log('API scheduleVideoInterview → sendInvite(..., { sessionLabels }) — labels passed');

console.log('\n=== 4. Regression: API without type field ===');
const apiNoTypeInput = {
  candidate_name: 'Jane Doe',
  source: 'api',
  timezone: 'Asia/Kolkata',
};
const apiNoTypeMeta = simulateStoredMetadata(apiNoTypeInput);
const apiNoTypeSession = { metadata_json: apiNoTypeMeta };
console.log('No session_type, source=api →', getSessionTypeFromSession(apiNoTypeSession));
console.log('completionTitle →', resolveSessionLabelsFromSession(apiNoTypeSession).completionTitle);

console.log('\n=== 5. Backfill: existing chat session without session_type in DB ===');
const legacyChatMeta = { source: 'schedule_chat' };
const legacyChatSession = { metadata_json: legacyChatMeta };
console.log('source=schedule_chat, no session_type →', getSessionTypeFromSession(legacyChatSession));
console.log('completionTitle →', resolveSessionLabelsFromSession(legacyChatSession).completionTitle);
