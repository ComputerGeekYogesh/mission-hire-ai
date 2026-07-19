-- Fix MySQL #3780: incompatible FK on interview_sessions.id
-- Run in phpMyAdmin / MySQL Workbench (one block at a time if needed).
-- Backup first if you have real interview data.

-- Step 1: Remove foreign keys (required before changing id type)
ALTER TABLE interview_verification_logs DROP FOREIGN KEY fk_ivl_session;
ALTER TABLE interview_snapshots DROP FOREIGN KEY fk_isnap_session;
ALTER TABLE interview_telemetry DROP FOREIGN KEY fk_itele_session;
ALTER TABLE interview_flags DROP FOREIGN KEY fk_iflags_session;
ALTER TABLE interview_recordings DROP FOREIGN KEY fk_irec_session;

-- Step 2: Fix parent id (now allowed)
ALTER TABLE interview_sessions
  MODIFY COLUMN id BIGINT NOT NULL AUTO_INCREMENT;

-- Step 3: Fix child session_id columns to match (signed BIGINT)
ALTER TABLE interview_verification_logs MODIFY COLUMN session_id BIGINT NOT NULL;
ALTER TABLE interview_snapshots MODIFY COLUMN session_id BIGINT NOT NULL;
ALTER TABLE interview_telemetry MODIFY COLUMN session_id BIGINT NOT NULL;
ALTER TABLE interview_flags MODIFY COLUMN session_id BIGINT NOT NULL;
ALTER TABLE interview_recordings MODIFY COLUMN session_id BIGINT NOT NULL;
ALTER TABLE interview_audit_logs MODIFY COLUMN session_id BIGINT DEFAULT NULL;

-- Step 4: Re-add foreign keys
ALTER TABLE interview_verification_logs
  ADD CONSTRAINT fk_ivl_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE;
ALTER TABLE interview_snapshots
  ADD CONSTRAINT fk_isnap_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE;
ALTER TABLE interview_telemetry
  ADD CONSTRAINT fk_itele_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE;
ALTER TABLE interview_flags
  ADD CONSTRAINT fk_iflags_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE;
ALTER TABLE interview_recordings
  ADD CONSTRAINT fk_irec_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE;

-- Step 5: Restart npm run dev — bootstrap will create missing tables:
--   interview_session_questions, interview_question_responses, interview_call_summaries
