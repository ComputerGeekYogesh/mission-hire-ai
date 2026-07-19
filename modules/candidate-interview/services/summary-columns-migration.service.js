import db from '../../../config/db.js';

let migrationDone = false;

async function columnExists(table, column) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

/**
 * Migrate legacy mira_* summary columns to mission_* (Mira → Mission rebrand).
 */
export async function ensureSummaryColumns() {
  if (migrationDone) return;
  if (!(await columnExists('interview_call_summaries', 'session_id'))) {
    migrationDone = true;
    return;
  }

  const hasMiraVerdict = await columnExists('interview_call_summaries', 'mira_verdict');
  const hasMissionVerdict = await columnExists('interview_call_summaries', 'mission_verdict');

  if (hasMiraVerdict && !hasMissionVerdict) {
    await db.query(
      'ALTER TABLE interview_call_summaries CHANGE COLUMN mira_verdict mission_verdict LONGTEXT DEFAULT NULL'
    );
  }

  const hasMiraRecs = await columnExists('interview_call_summaries', 'mira_recommendations');
  const hasMissionRecs = await columnExists('interview_call_summaries', 'mission_recommendations');

  if (hasMiraRecs && !hasMissionRecs) {
    await db.query(
      'ALTER TABLE interview_call_summaries CHANGE COLUMN mira_recommendations mission_recommendations JSON DEFAULT NULL'
    );
  }

  migrationDone = true;
}
