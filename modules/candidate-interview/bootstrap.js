import fs from 'fs';
import path from 'path';
import db from '../../config/db.js';
import { interviewConfig } from './config.js';

let schemaEnsured = false;

/**
 * Split schema.sql into full CREATE TABLE statements (semicolons inside ENUMs are not an issue;
 * we split only on ");" line endings that terminate a CREATE).
 */
function parseCreateStatements(sql) {
  const cleaned = sql
    .replace(/--[^\n]*/g, '')
    .trim();

  const statements = [];
  let buf = '';
  let depth = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    buf += ch;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) {
      const stmt = buf.trim();
      if (stmt.length > 10) statements.push(stmt);
      buf = '';
    }
  }

  const tail = buf.trim();
  if (tail.length > 10) statements.push(tail);

  return statements;
}

async function tableExists(name) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

async function dropOrphanChildTables() {
  const children = [
    'interview_verification_logs',
    'interview_snapshots',
    'interview_telemetry',
    'interview_flags',
    'interview_recordings',
    'interview_audit_logs',
    'interview_session_questions',
    'interview_question_responses',
    'interview_call_summaries',
  ];

  const parentExists = await tableExists('interview_sessions');
  if (parentExists) return;

  for (const table of children) {
    if (await tableExists(table)) {
      console.warn(`[candidate-interview] Dropping orphan table ${table} (missing interview_sessions)`);
      await db.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
  }
}

async function getColumnType(table, column) {
  const [cols] = await db.query(
    `SELECT COLUMN_TYPE, COLUMN_KEY
     FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return cols[0] || null;
}

function isCompatibleSessionIdType(columnType) {
  const t = String(columnType || '').toLowerCase();
  return t === 'bigint' && !t.includes('unsigned');
}

const SESSION_CHILD_COLUMNS = [
  ['interview_verification_logs', 'BIGINT NOT NULL'],
  ['interview_snapshots', 'BIGINT NOT NULL'],
  ['interview_telemetry', 'BIGINT NOT NULL'],
  ['interview_flags', 'BIGINT NOT NULL'],
  ['interview_recordings', 'BIGINT NOT NULL'],
  ['interview_recording_metadata', 'BIGINT NOT NULL'],
  ['interview_audit_logs', 'BIGINT DEFAULT NULL'],
  ['interview_session_questions', 'BIGINT NOT NULL'],
  ['interview_question_responses', 'BIGINT NOT NULL'],
  ['interview_call_summaries', 'BIGINT NOT NULL'],
];

const SESSION_FK_RECREATE = [
  [
    'interview_verification_logs',
    'fk_ivl_session',
    'FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE',
  ],
  [
    'interview_snapshots',
    'fk_isnap_session',
    'FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE',
  ],
  [
    'interview_telemetry',
    'fk_itele_session',
    'FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE',
  ],
  [
    'interview_flags',
    'fk_iflags_session',
    'FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE',
  ],
  [
    'interview_recordings',
    'fk_irec_session',
    'FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE',
  ],
  [
    'interview_recording_metadata',
    'fk_irm_session',
    'FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE',
  ],
  [
    'interview_session_questions',
    'fk_isq_session',
    'FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE',
  ],
  [
    'interview_question_responses',
    'fk_iqr_session',
    'FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE',
  ],
  [
    'interview_call_summaries',
    'fk_ics_session',
    'FOREIGN KEY (session_id) REFERENCES interview_sessions (id) ON DELETE CASCADE',
  ],
];

async function dropForeignKey(table, constraintName) {
  try {
    await db.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${constraintName}\``);
  } catch (err) {
    if (err.errno !== 1091) throw err;
  }
}

async function foreignKeyExists(table, constraintName) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'
     LIMIT 1`,
    [table, constraintName]
  );
  return rows.length > 0;
}

async function needsSessionIdRepair() {
  if (!(await tableExists('interview_sessions'))) return false;

  const parent = await getColumnType('interview_sessions', 'id');
  if (!isCompatibleSessionIdType(parent?.COLUMN_TYPE)) return true;

  for (const [table] of SESSION_CHILD_COLUMNS) {
    if (!(await tableExists(table))) continue;
    const col = await getColumnType(table, 'session_id');
    if (col && !isCompatibleSessionIdType(col.COLUMN_TYPE)) return true;
  }
  return false;
}

/** Drop FKs, align id/session_id to signed BIGINT, recreate FKs (fixes MySQL #3780). */
async function repairSessionsPrimaryKey() {
  if (!(await tableExists('interview_sessions'))) return;

  const col = await getColumnType('interview_sessions', 'id');
  if (!col) return;

  const hasPk = col.COLUMN_KEY === 'PRI';
  const mustRepair = await needsSessionIdRepair();

  if (mustRepair) {
    console.warn('[candidate-interview] Repairing session FK types (drop FK → align BIGINT → re-add FK)');

    const [fks] = await db.query(
      `SELECT TABLE_NAME, CONSTRAINT_NAME
       FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE()
         AND REFERENCED_TABLE_NAME = 'interview_sessions'`
    );
    for (const row of fks) {
      await dropForeignKey(row.TABLE_NAME, row.CONSTRAINT_NAME);
    }

    if (await tableExists('interview_question_responses')) {
      await dropForeignKey('interview_question_responses', 'fk_iqr_question');
    }

    await db.query(`
      ALTER TABLE interview_sessions
        MODIFY COLUMN id BIGINT NOT NULL AUTO_INCREMENT
    `);

    for (const [table, sqlType] of SESSION_CHILD_COLUMNS) {
      if (await tableExists(table)) {
        await db.query(`ALTER TABLE \`${table}\` MODIFY COLUMN session_id ${sqlType}`);
      }
    }

    if (await tableExists('interview_session_questions')) {
      const qCol = await getColumnType('interview_session_questions', 'id');
      if (!isCompatibleSessionIdType(qCol?.COLUMN_TYPE)) {
        await db.query(`
          ALTER TABLE interview_session_questions
            MODIFY COLUMN id BIGINT NOT NULL AUTO_INCREMENT
        `);
      }
    }

    if (await tableExists('interview_question_responses')) {
      const qidCol = await getColumnType('interview_question_responses', 'question_id');
      if (qidCol && !isCompatibleSessionIdType(qidCol.COLUMN_TYPE)) {
        await db.query(`
          ALTER TABLE interview_question_responses
            MODIFY COLUMN question_id BIGINT NOT NULL
        `);
      }
      if (!(await foreignKeyExists('interview_question_responses', 'fk_iqr_question'))) {
        if (await tableExists('interview_session_questions')) {
          await db.query(`
            ALTER TABLE interview_question_responses
              ADD CONSTRAINT fk_iqr_question
              FOREIGN KEY (question_id) REFERENCES interview_session_questions (id) ON DELETE CASCADE
          `);
        }
      }
    }

    for (const [table, fkName, fkSql] of SESSION_FK_RECREATE) {
      if (!(await tableExists(table))) continue;
      if (await foreignKeyExists(table, fkName)) continue;
      await db.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${fkName}\` ${fkSql}`);
    }
  } else if (!hasPk) {
    await db.query(`ALTER TABLE interview_sessions ADD PRIMARY KEY (id)`);
  }

  const [engineRows] = await db.query(
    `SELECT ENGINE FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'interview_sessions'`
  );
  if (engineRows[0]?.ENGINE && engineRows[0].ENGINE !== 'InnoDB') {
    console.warn('[candidate-interview] Converting interview_sessions to InnoDB');
    await db.query('ALTER TABLE interview_sessions ENGINE=InnoDB');
  }
}

async function dropBrokenChildTable(tableName) {
  if (!(await tableExists(tableName))) return;
  console.warn(`[candidate-interview] Dropping ${tableName} for clean recreate (FK mismatch)`);
  await db.query(`DROP TABLE IF EXISTS \`${tableName}\``);
}

export async function ensureInterviewSchema() {
  if (schemaEnsured) return;

  await dropOrphanChildTables();
  await repairSessionsPrimaryKey();

  const schemaPath = path.join(interviewConfig.moduleRoot, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const statements = parseCreateStatements(sql);

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    const nameMatch = statement.match(/CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?/i);
    const tableName = nameMatch?.[1] || 'unknown';

    try {
      await db.query(statement);
    } catch (err) {
      if (err.code === 'ER_TABLE_EXISTS_ERR') continue;

      const fkIncompatible =
        err.errno === 150 ||
        /incompatible|foreign key constraint/i.test(String(err.message || ''));

      if (fkIncompatible && tableName !== 'interview_sessions') {
        console.warn(`[candidate-interview] FK error on ${tableName}, repairing id types and retrying`);
        await repairSessionsPrimaryKey();
        await dropBrokenChildTable(tableName);
        const parentStmt = statements.find((s) =>
          /CREATE TABLE IF NOT EXISTS\s+`?interview_sessions`?/i.test(s)
        );
        if (parentStmt) await db.query(parentStmt);
        await repairSessionsPrimaryKey();
        await db.query(statement);
        continue;
      }

      console.error(`[candidate-interview] Failed creating ${tableName}:`, err.message);
      throw err;
    }
  }

  await repairSessionsPrimaryKey();

  if (!(await tableExists('interview_sessions'))) {
    throw new Error('interview_sessions table was not created — check MySQL user permissions and logs above');
  }

  for (const dir of [interviewConfig.uploadsRoot, interviewConfig.recordingsBasePath]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  schemaEnsured = true;
  const { ensureRecordingMetadataTable } = await import('./services/recording-metadata-migration.service.js');
  const { ensureSessionStatusEnum } = await import('./services/session-status-migration.service.js');
  try {
    await ensureRecordingMetadataTable();
  } catch (err) {
    console.error('[candidate-interview] Recording metadata table migration failed:', err.message);
  }
  try {
    await ensureSessionStatusEnum();
  } catch (err) {
    console.error('[candidate-interview] Session status ENUM migration failed:', err.message);
  }
  try {
    const { ensureVerificationLogIndexes } = await import('./services/verification-log-migration.service.js');
    await ensureVerificationLogIndexes();
  } catch (err) {
    console.error('[candidate-interview] Verification log index migration failed:', err.message);
  }
  try {
    const { ensurePortalEventsTables } = await import('./services/portal-events-receiver-migration.service.js');
    await ensurePortalEventsTables();
  } catch (err) {
    console.error('[candidate-interview] Portal events table migration failed:', err.message);
  }
  try {
    const { ensureSummaryColumns } = await import('./services/summary-columns-migration.service.js');
    await ensureSummaryColumns();
  } catch (err) {
    console.error('[candidate-interview] Summary columns migration failed:', err.message);
  }
  console.log('[candidate-interview] Database schema ready (recording storage: disk)');
}
