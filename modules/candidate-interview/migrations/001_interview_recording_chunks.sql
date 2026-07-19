-- Incremental recording chunk storage (run once on existing databases).
CREATE TABLE IF NOT EXISTS interview_recording_chunks (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  chunk_index INT NOT NULL,
  mime_type VARCHAR(128) DEFAULT 'video/webm',
  file_size_bytes BIGINT NOT NULL,
  content LONGBLOB NOT NULL,
  sha256 CHAR(64) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_irc_session_chunk (session_id, chunk_index),
  KEY idx_irc_session (session_id),
  CONSTRAINT fk_irc_session FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
