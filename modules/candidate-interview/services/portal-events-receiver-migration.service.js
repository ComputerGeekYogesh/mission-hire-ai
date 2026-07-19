import fs from 'fs';
import path from 'path';
import db from '../../../config/db.js';
import { interviewConfig } from '../config.js';

let ensured = false;

async function tableExists(name) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

export async function ensurePortalEventsTables() {
  if (ensured) return;

  if (await tableExists('assessment_portal_events')) {
    ensured = true;
    return;
  }

  const sqlPath = path.join(
    interviewConfig.moduleRoot,
    'migrations',
    'portal-events-receiver-reference.sql'
  );
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 10 && !s.startsWith('--'));

  for (const statement of statements) {
    await db.query(statement);
  }

  console.log('[candidate-interview] Portal events receiver tables ready');
  ensured = true;
}
