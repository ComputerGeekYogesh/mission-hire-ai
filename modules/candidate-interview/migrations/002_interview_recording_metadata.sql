-- Lightweight recording metadata (no binary data). Chunks and merged files live on disk.
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
