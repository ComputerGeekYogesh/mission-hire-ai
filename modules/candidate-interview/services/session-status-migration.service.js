import db from '../../../config/db.js';

const TERMINATED_STATUS = 'terminated_due_to_proctoring_violation';

const FULL_STATUS_ENUM = [
  'created',
  'invited',
  'verified',
  'preflight_ok',
  'in_progress',
  'completed',
  'failed',
  'suspicious',
  TERMINATED_STATUS,
  'cancelled',
];

let ensured = false;
let ensurePromise = null;

async function getStatusColumnType() {
  const [rows] = await db.query(
    `SELECT COLUMN_TYPE AS column_type
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'interview_sessions'
       AND COLUMN_NAME = 'status'
     LIMIT 1`
  );
  return rows[0]?.column_type || null;
}

/** Extend interview_sessions.status ENUM for proctoring termination (idempotent). */
export async function ensureSessionStatusEnum() {
  if (ensured) return true;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    try {
      const columnType = await getStatusColumnType();
      if (!columnType) {
        console.warn('[session-status-migration] interview_sessions.status column not found — skip');
        return false;
      }

      if (String(columnType).includes(TERMINATED_STATUS)) {
        ensured = true;
        return true;
      }

      const enumSql = FULL_STATUS_ENUM.map((v) => `'${v}'`).join(', ');
      await db.query(
        `ALTER TABLE interview_sessions
         MODIFY COLUMN status ENUM(${enumSql}) NOT NULL DEFAULT 'created'`
      );

      ensured = true;
      console.log(
        `[session-status-migration] Added '${TERMINATED_STATUS}' to interview_sessions.status ENUM`
      );
      return true;
    } catch (err) {
      console.error('[session-status-migration] Failed to extend status ENUM:', err.message);
      throw err;
    } finally {
      ensurePromise = null;
    }
  })();

  return ensurePromise;
}

export { TERMINATED_STATUS };
