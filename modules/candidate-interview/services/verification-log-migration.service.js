import db from '../../../config/db.js';

let ensured = false;

async function indexExists(table, indexName) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, indexName]
  );
  return rows.length > 0;
}

export async function ensureVerificationLogIndexes() {
  if (ensured) return;
  if (!(await indexExists('interview_verification_logs', 'idx_ivl_session_created'))) {
    try {
      await db.query(`
        ALTER TABLE interview_verification_logs
          ADD INDEX idx_ivl_session_created (session_id, created_at DESC)
      `);
      console.log('[candidate-interview] Added index idx_ivl_session_created on interview_verification_logs');
    } catch (err) {
      if (err.errno !== 1061) {
        console.warn('[candidate-interview] verification log index migration:', err.message);
      }
    }
  }
  ensured = true;
}
