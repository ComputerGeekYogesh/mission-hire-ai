import db from '../../../config/db.js';
import fs from 'fs';
import path from 'path';
import { interviewConfig } from '../config.js';
import { recordingDebug } from './recording-debug.service.js';

let ensured = false;
let ensurePromise = null;

const CREATE_METADATA_TABLE_SQL = `
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

export async function ensureRecordingMetadataTable() {
  if (ensured) return true;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    try {
      await db.query(CREATE_METADATA_TABLE_SQL);
      const base = interviewConfig.recordingsBasePath;
      if (!fs.existsSync(base)) {
        fs.mkdirSync(base, { recursive: true });
      }
      ensured = true;
      recordingDebug('recording_metadata_table_ready', { ok: true, base });
      return true;
    } catch (err) {
      recordingDebug('recording_metadata_table_ensure_failed', {
        error: err.message,
        code: err.code || null,
      });
      console.error(
        '[recording-disk] Failed to ensure interview_recording_metadata table:',
        err.message
      );
      throw err;
    } finally {
      ensurePromise = null;
    }
  })();

  return ensurePromise;
}

export function getMetadataMigrationSqlPath() {
  return path.join(interviewConfig.moduleRoot, 'migrations', '002_interview_recording_metadata.sql');
}
