-- Composite index for session-scoped verification log listing (avoids filesort on large JSON rows)
ALTER TABLE interview_verification_logs
  ADD INDEX idx_ivl_session_created (session_id, created_at DESC);
