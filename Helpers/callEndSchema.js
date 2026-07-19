import db from '../config/db.js';

let schemaReady = null;

async function columnExists(table, column) {
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  return rows.length > 0;
}

/**
 * Ensure columns needed for call-end error capture exist (idempotent).
 */
export async function ensureCallEndSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await db.query(
          'ALTER TABLE overall_status MODIFY COLUMN feedback_status VARCHAR(255) DEFAULT NULL'
        );
      } catch (e) {
        console.warn('[callEndSchema] feedback_status widen:', e?.message || e);
      }

      if (!(await columnExists('overall_status', 'eval_error_summary'))) {
        await db.query(
          'ALTER TABLE overall_status ADD COLUMN eval_error_summary TEXT DEFAULT NULL AFTER feedback_status'
        );
      }

      if (!(await columnExists('feedback', 'eval_error'))) {
        await db.query(
          'ALTER TABLE feedback ADD COLUMN eval_error VARCHAR(512) DEFAULT NULL AFTER feedback'
        );
      }

      try {
        const [idx] = await db.query(
          `SHOW INDEX FROM voice_platform_errors WHERE Key_name = 'idx_vpe_job'`
        );
        if (!idx.length) {
          await db.query(
            'ALTER TABLE voice_platform_errors ADD INDEX idx_vpe_job (job_id(191))'
          );
        }
      } catch (e) {
        console.warn('[callEndSchema] voice_platform_errors index:', e?.message || e);
      }
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}
