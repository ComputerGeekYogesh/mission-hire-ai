-- Candidate Interview Management module schema
-- Parent: interview_sessions (must exist before child tables)

CREATE TABLE IF NOT EXISTS interview_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_token VARCHAR(128) NOT NULL,
  candidate_id BIGINT DEFAULT NULL,
  candidate_name VARCHAR(255) NOT NULL,
  candidate_email VARCHAR(255) NOT NULL,
  candidate_phone VARCHAR(30) DEFAULT NULL,
  recruiter_id BIGINT DEFAULT NULL,
  job_id BIGINT DEFAULT NULL,
  job_title VARCHAR(255) DEFAULT NULL,
  company_id BIGINT DEFAULT NULL,
  interview_type ENUM('browser_video', 'voice_call', 'ai_interview') NOT NULL DEFAULT 'browser_video',
  scheduled_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  status ENUM('created', 'invited', 'verified', 'preflight_ok', 'in_progress', 'completed', 'failed', 'suspicious', 'terminated_due_to_proctoring_violation', 'cancelled') NOT NULL DEFAULT 'created',
  otp_hash VARCHAR(255) DEFAULT NULL,
  otp_verified TINYINT(1) NOT NULL DEFAULT 0,
  otp_verified_at DATETIME DEFAULT NULL,
  preflight_completed TINYINT(1) NOT NULL DEFAULT 0,
  preflight_completed_at DATETIME DEFAULT NULL,
  headphone_status ENUM('unknown', 'detected', 'not_detected') NOT NULL DEFAULT 'unknown',
  invite_sent_at DATETIME DEFAULT NULL,
  started_at DATETIME DEFAULT NULL,
  ended_at DATETIME DEFAULT NULL,
  duration_seconds INT DEFAULT NULL,
  external_call_sid VARCHAR(100) DEFAULT NULL,
  metadata_json JSON DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_interview_sessions_token (session_token),
  KEY idx_interview_sessions_status (status),
  KEY idx_interview_sessions_scheduled (scheduled_at),
  KEY idx_interview_sessions_recruiter (recruiter_id),
  KEY idx_interview_sessions_job (job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interview_verification_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  success TINYINT(1) NOT NULL DEFAULT 0,
  ip_address VARCHAR(45) DEFAULT NULL,
  user_agent TEXT DEFAULT NULL,
  details_json JSON DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ivl_session (session_id),
  KEY idx_ivl_session_created (session_id, created_at DESC),
  CONSTRAINT fk_ivl_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interview_snapshots (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  confidence_score DECIMAL(5,4) DEFAULT NULL,
  face_count INT DEFAULT 1,
  captured_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_isnap_session (session_id),
  CONSTRAINT fk_isnap_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interview_telemetry (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  blink_count INT DEFAULT 0,
  yaw DECIMAL(8,4) DEFAULT NULL,
  pitch DECIMAL(8,4) DEFAULT NULL,
  roll DECIMAL(8,4) DEFAULT NULL,
  movement_score DECIMAL(8,4) DEFAULT NULL,
  face_detected TINYINT(1) NOT NULL DEFAULT 0,
  face_count INT DEFAULT 0,
  mic_active TINYINT(1) DEFAULT 1,
  camera_active TINYINT(1) DEFAULT 1,
  tab_visible TINYINT(1) DEFAULT 1,
  suspicious_flag TINYINT(1) NOT NULL DEFAULT 0,
  recorded_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_itele_session (session_id),
  KEY idx_itele_suspicious (suspicious_flag),
  CONSTRAINT fk_itele_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interview_flags (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  flag_type VARCHAR(64) NOT NULL,
  severity ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'low',
  message TEXT DEFAULT NULL,
  payload_json JSON DEFAULT NULL,
  resolved TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_iflags_session (session_id),
  KEY idx_iflags_severity (severity),
  CONSTRAINT fk_iflags_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interview_recordings (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  recording_type ENUM('video', 'audio', 'screen', 'transcript') NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  mime_type VARCHAR(128) DEFAULT NULL,
  duration_seconds INT DEFAULT NULL,
  file_size_bytes BIGINT DEFAULT NULL,
  transcript_text LONGTEXT DEFAULT NULL,
  metadata_json JSON DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_irec_session (session_id),
  CONSTRAINT fk_irec_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interview_recording_metadata (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  total_chunks_expected INT DEFAULT NULL,
  chunks_received INT NOT NULL DEFAULT 0,
  merge_status ENUM('pending', 'in_progress', 'completed', 'failed', 'partial') NOT NULL DEFAULT 'pending',
  merged_file_path VARCHAR(1024) DEFAULT NULL,
  merged_file_size_bytes BIGINT DEFAULT NULL,
  signed_url TEXT DEFAULT NULL,
  webhook_sent_at DATETIME DEFAULT NULL,
  webhook_status VARCHAR(64) DEFAULT NULL,
  recording_status ENUM('full', 'partial') DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_irm_session (session_id),
  KEY idx_irm_merge_status (merge_status),
  CONSTRAINT fk_irm_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interview_audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT DEFAULT NULL,
  actor_type ENUM('admin', 'candidate', 'system') NOT NULL DEFAULT 'system',
  actor_id BIGINT DEFAULT NULL,
  action VARCHAR(128) NOT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  details_json JSON DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_iala_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interview_session_questions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  question_order INT NOT NULL,
  question_text TEXT NOT NULL,
  category VARCHAR(100) DEFAULT NULL,
  required_flag TINYINT(1) NOT NULL DEFAULT 1,
  source_type VARCHAR(32) DEFAULT 'custom',
  feedback_id BIGINT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_isq_session (session_id),
  CONSTRAINT fk_isq_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interview_question_responses (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  response_text LONGTEXT DEFAULT NULL,
  audio_storage_key VARCHAR(512) DEFAULT NULL,
  score DECIMAL(5,2) DEFAULT NULL,
  ai_feedback TEXT DEFAULT NULL,
  answered_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_iqr_session (session_id),
  CONSTRAINT fk_iqr_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_iqr_question FOREIGN KEY (question_id) REFERENCES interview_session_questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS interview_call_summaries (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  mock_call_id VARCHAR(128) NOT NULL,
  call_sid VARCHAR(128) NOT NULL,
  mission_verdict LONGTEXT DEFAULT NULL,
  mission_recommendations JSON DEFAULT NULL,
  summary_json JSON DEFAULT NULL,
  duration_seconds INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ics_session (session_id),
  KEY idx_ics_call (mock_call_id),
  CONSTRAINT fk_ics_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
