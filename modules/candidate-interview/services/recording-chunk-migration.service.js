import db from '../../../config/db.js';
import { recordingDebug } from './recording-debug.service.js';

let ensured = false;
let ensurePromise = null;

const CREATE_CHUNKS_TABLE_SQL = `
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/** Ensure incremental chunk table exists (idempotent). */
export async function ensureRecordingChunksTable() {
  if (ensured) return true;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    try {
      await db.query(CREATE_CHUNKS_TABLE_SQL);
      ensured = true;
      recordingDebug('chunks_table_ready', { ok: true });
      return true;
    } catch (err) {
      recordingDebug('chunks_table_ensure_failed', { error: err.message, code: err.code || null });
      console.error('[recording-persist] Failed to ensure interview_recording_chunks table:', err.message);
      throw err;
    } finally {
      ensurePromise = null;
    }
  })();

  return ensurePromise;
}
