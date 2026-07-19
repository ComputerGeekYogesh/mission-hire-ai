-- Add proctoring termination status to interview_sessions.status ENUM.
ALTER TABLE interview_sessions
  MODIFY COLUMN status ENUM(
    'created',
    'invited',
    'verified',
    'preflight_ok',
    'in_progress',
    'completed',
    'failed',
    'suspicious',
    'terminated_due_to_proctoring_violation',
    'cancelled'
  ) NOT NULL DEFAULT 'created';
