-- Reference schema for RMG / calling-server portal-events receiver
-- Run on the database used by https://rmg.360degreecloud.in

CREATE TABLE IF NOT EXISTS assessment_portal_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  session_token VARCHAR(128) DEFAULT NULL,
  mock_call_id VARCHAR(128) DEFAULT NULL,
  event VARCHAR(64) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  email VARCHAR(255) DEFAULT NULL,
  candidate_name VARCHAR(255) DEFAULT NULL,
  payload_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ape_session (session_id),
  KEY idx_ape_event (event),
  KEY idx_ape_mock_call (mock_call_id),
  KEY idx_ape_occurred (occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assessment_portal_timeline (
  session_id BIGINT NOT NULL,
  session_token VARCHAR(128) DEFAULT NULL,
  mock_call_id VARCHAR(128) DEFAULT NULL,
  email VARCHAR(255) DEFAULT NULL,
  candidate_name VARCHAR(255) DEFAULT NULL,
  invite_sent_at DATETIME(3) DEFAULT NULL,
  otp_sent_at DATETIME(3) DEFAULT NULL,
  otp_verified_at DATETIME(3) DEFAULT NULL,
  call_started_at DATETIME(3) DEFAULT NULL,
  call_ended_at DATETIME(3) DEFAULT NULL,
  last_event VARCHAR(64) DEFAULT NULL,
  last_event_at DATETIME(3) DEFAULT NULL,
  proctoring_terminated TINYINT(1) NOT NULL DEFAULT 0,
  interview_link VARCHAR(2048) DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id),
  KEY idx_apt_mock_call (mock_call_id),
  KEY idx_apt_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
