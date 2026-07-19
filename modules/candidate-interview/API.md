# Candidate Interview Management — API

## Admin (session auth + `protectRoute`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/interviews/dashboard` | Dashboard |
| GET | `/admin/interviews/scheduled` | List sessions |
| GET | `/admin/interviews/schedule` | Schedule form |
| POST | `/admin/interviews/schedule` | Create session + invite |
| GET | `/admin/interviews/session/:id` | Session detail |

## Candidate (token in URL)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/interview/:token` | OTP gate |
| POST | `/interview/:token/otp/send` | Send OTP email |
| POST | `/interview/:token/otp/verify` | Verify OTP |
| GET | `/interview/:token/preflight` | Device check UI |
| POST | `/interview/:token/preflight/complete` | Mark preflight OK |
| POST | `/interview/:token/tts` | Synthesize speech (Vapi assistant voice, MP3 body) |
| POST | `/interview/:token/snapshot` | Upload webcam snapshot (multipart `snapshot`) |
| POST | `/interview/:token/telemetry` | Proctoring telemetry JSON |
| POST | `/interview/:token/start` | Start interview (+ Twilio for voice types) |
| POST | `/interview/:token/recording` | Upload recording chunk |
| POST | `/interview/:token/end` | Complete session |

### Telemetry body

```json
{
  "yaw": 0,
  "pitch": 0,
  "blink": 3,
  "faceDetected": true,
  "face_count": 1,
  "mic_active": true,
  "camera_active": true,
  "tab_visible": true,
  "window_blur": false,
  "timestamp": "2026-05-15T10:00:00.000Z"
}
```

## REST API (Bearer API key)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/schedule/video-interview` | `Authorization: Bearer <api_key>` (plain key, no Base64) | Schedule browser video interview, optional invite email, webhook on completion |

Request body: `candidate_name`, `email`, `interview_type` (`browser_video` | `voice_call` | `ai_interview`), optional `type` (`interview` | `skill_assessment`, defaults to `skill_assessment` when omitted), `scheduled_at` (naive ISO, e.g. `2026-05-25T10:30:00`), `timezone` (IANA), `send_email_invite_immediately`, `interview.questions[]` (`question_id`, `question`, `skill`), `callback.webhook_url`, `callback.webhook_secret`, optional `callback.events_webhook_url`, optional `callback.events_webhook_secret`.

The optional `type` field controls candidate-facing copy (invite email, in-call UI, audio prompts, termination, completion). Use `interview` for interview wording; omit or use `skill_assessment` for the default skill-assessment wording.

API-scheduled sessions use email subjects **Assessment Invitation** / **Assessment Feedback** (or **Interview Invitation** when `type` is `interview`) and POST a completion webhook (3 attempts, 2s between retries) with header `X-Webhook-Secret`. The payload includes **flags**, **snapshots** (absolute image URLs), and **recording** (absolute video URL). Full payload is logged to the server console on dispatch.

### Portal lifecycle events webhook (API-scheduled browser video)

When `callback.events_webhook_url` is set, MissionAI POSTs real-time assessment lifecycle events to your portal (3 attempts, 2s between retries). Uses header `X-Webhook-Secret` (falls back to `callback.webhook_secret` if `events_webhook_secret` is omitted). Each request also includes header `X-Portal-Event: <event_name>`.

| Event | When fired |
|-------|------------|
| `invite_sent` | Invite email sent at schedule time (`send_email_invite_immediately: true`) |
| `otp_sent` | Candidate requests OTP on gate page |
| `otp_verified` | Candidate successfully verifies OTP |
| `call_started` | Candidate clicks Start Call / assessment begins |
| `call_ended` | Session ends (normal completion or proctoring termination) |

Example schedule `callback` block:

```json
{
  "callback": {
    "webhook_url": "https://your-calling-server.com/api/v1/assessment/completed",
    "webhook_secret": "your-completion-secret",
    "events_webhook_url": "https://your-calling-server.com/api/v1/assessment/portal-events",
    "events_webhook_secret": "your-events-secret"
  }
}
```

Example portal event payload:

```json
{
  "type": "assessment_portal_event",
  "event": "otp_verified",
  "occurred_at": "2026-06-08T10:15:30.000Z",
  "session_id": 34,
  "session_token": "abc...",
  "email": "candidate@example.com",
  "candidate_name": "Jane Doe",
  "scheduled_at": "2026-06-08 10:00:00",
  "timezone": "Asia/Kolkata",
  "source": "api",
  "session_status": "verified",
  "timestamps": {
    "otp_verified_at": "2026-06-08T10:15:30.000Z",
    "started_at": null,
    "ended_at": null
  },
  "event_data": {
    "otp_verified_at": "2026-06-08 10:15:30"
  }
}
```

Server logs: search `[portal-events]` on MissionAI.

**Receiver troubleshooting:** If RMG/calling-server returns `{"ok":false,"message":"Failed to persist portal event."}`, the webhook reached your server but the **database insert failed**. On the calling server:

1. Run `modules/candidate-interview/migrations/portal-events-receiver-reference.sql` against the RMG database.
2. Check calling-server logs for the underlying MySQL error (ER_NO_SUCH_TABLE, ER_BAD_FIELD_ERROR, etc.).
3. Ensure `MISSIONAI_EVENTS_WEBHOOK_SECRET` matches `callback.events_webhook_secret` from schedule API.

### Completion webhook payload (API-scheduled browser video)

Base fields: `success`, `assessment_termination` (boolean — `true` when the session was forcefully ended by proctoring/integrity termination, `false` on normal completion), `mission_verdict`, `mission_recommendations`, `email`, `session_id`, `session_token`, `video_interview`, `qa`.

`video_interview.proctoring_terminated` mirrors `assessment_termination` for backward compatibility.

Additional fields:

- `flags` — `total_flags`, per-type counts (`tab_switches`, `face_not_detected`, `low_light_detected`, `suspicious_activity`), and `flag_details[]` (`type`, `timestamp`, `description`, `severity`)
- `snapshots` — `total_count`, `images[]` (`snapshot_id`, `captured_at`, `flag_type`, `url`)
- `recording` — `status` (`available` | `unavailable`), `duration_seconds`, `file_size_mb`, `url`, `thumbnail_url` (first snapshot when available)

Media URLs use your public `HOST_URL` (no trailing slash), e.g. `https://your-ngrok-or-domain.com`:

- Snapshots (filesystem): `{HOST_URL}/uploads/interview-gate/{session_token}/snap_*.jpg`
- Recording (filesystem): `{HOST_URL}/uploads/interview-recordings/{session_token}/merged_{session_id}.webm`
- Recording (mysql_blob): `{HOST_URL}/interview/recording-media/{recording_id}?t={signed_token}`

Browser interview room uses **voice auto-submit** (Web Speech API + silence detection + Claude confirmation via `POST /interview/:token/call/confirm-intent`). Set `ANTHROPIC_API_KEY` for intent classification.

## Environment

- `INTERVIEW_TOKEN_SECRET` — HMAC signing secret for session tokens
- `HOST_URL` — public base URL (invite links, webhook snapshot/recording URLs)
- `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM_ADDRESS` — SMTP for invite + OTP email
- `SESSION_SECRET` — Express session signing secret
- `API_KEY` or `MOCK_INTERVIEW_API_KEY` — Bearer token for `/api/v1/schedule/video-interview` (set in `.env`; never commit the value)
- `FEEDBACK_ADMIN_EMAIL` — optional override for admin CC on feedback emails
- `API_FEEDBACK_ADMIN_EMAIL` — optional admin CC override for API-scheduled sessions (falls back to `TO_EMAIL`)
- `FEEDBACK_CC_EMAIL` — optional extra CC on feedback emails (in addition to admin)

### Browser interview TTS (Vapi assistant voice)

Uses the same voice as your Vapi assistant (`VAPI_ASSISTANT_ID`) for preflight, greeting, questions, and confirmation prompts.

- `VAPI_PRIVATE_KEY` — required to read assistant voice from Vapi
- `VAPI_ASSISTANT_ID` — assistant UUID (same as phone interviews)
- `ELEVENLABS_API_KEY` — required if the Vapi assistant voice provider is ElevenLabs (most Indian-accent voices)
- `ELEVENLABS_MODEL_ID` — optional (default `eleven_multilingual_v2`)
- `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` — optional fallback (`en-IN-NeerjaNeural` via `INTERVIEW_AZURE_VOICE`)
- `INTERVIEW_TTS_ENABLED` — set to `0` to force browser-only speech
- `VAPI_VOICE` — optional JSON voice override (same as outbound calls)

### Session video recording (production)

- `INTERVIEW_RECORDING_STORAGE` — `mysql_blob` (recommended for multi-instance) or `filesystem` (local dev / single server)
- `INTERVIEW_MAX_RECORDING_BLOB_BYTES` — max final WebM size for BLOB storage (default 157286400 = 150 MB)
- `INTERVIEW_RECORDING_MEDIA_SECRET` — optional HMAC secret for signed playback URLs in webhooks (defaults to `INTERVIEW_TOKEN_SECRET`)

With `mysql_blob`:

- Browser uploads **one** assembled `session_full.webm` at end of call (no per-second chunks).
- Video bytes live in `interview_recording_blobs`; metadata row uses `storage_key = mysql_blob`.
- Webhook `recording.url` points to `/interview/recording-media/:id?t=…` (signed, 7-day token).
- Set MySQL `max_allowed_packet` ≥ largest expected recording (e.g. 128M).
- Nginx: `client_max_body_size` must allow the final upload (e.g. 150m).
