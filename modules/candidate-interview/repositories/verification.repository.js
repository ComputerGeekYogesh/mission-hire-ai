import db from '../../../config/db.js';
import { ensureVerificationLogIndexes } from '../services/verification-log-migration.service.js';

export const verificationRepository = {
  async log({ session_id, event_type, success, ip_address, user_agent, details_json }) {
    await db.query(
      `INSERT INTO interview_verification_logs (session_id, event_type, success, ip_address, user_agent, details_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        session_id,
        event_type,
        success ? 1 : 0,
        ip_address ?? null,
        user_agent ?? null,
        details_json ? JSON.stringify(details_json) : null,
      ]
    );
  },

  async list(filters = {}) {
    await ensureVerificationLogIndexes();

    const where = ['1=1'];
    const params = [];
    if (filters.session_id) {
      where.push('v.session_id = ?');
      params.push(filters.session_id);
    }
    if (filters.success !== undefined) {
      where.push('v.success = ?');
      params.push(filters.success ? 1 : 0);
    }
    const limit = Math.min(Number(filters.limit) || 100, 300);

    // Narrow column set — omit details_json/user_agent to avoid sort buffer pressure on large JSON rows.
    const [rows] = await db.query(
      `SELECT v.id, v.session_id, v.event_type, v.success, v.ip_address, v.created_at,
              s.candidate_name, s.candidate_email, s.session_token
       FROM interview_verification_logs v
       INNER JOIN interview_sessions s ON s.id = v.session_id
       WHERE ${where.join(' AND ')}
       ORDER BY v.created_at DESC
       LIMIT ?`,
      [...params, limit]
    );
    return rows;
  },

  /** Full rows for a single session (includes details_json for admin session detail). */
  async listBySessionWithDetails(sessionId, { limit = 100 } = {}) {
    const cap = Math.min(Number(limit) || 100, 300);
    const [rows] = await db.query(
      `SELECT v.id, v.session_id, v.event_type, v.success, v.ip_address, v.user_agent,
              v.details_json, v.created_at
       FROM interview_verification_logs v
       WHERE v.session_id = ?
       ORDER BY v.created_at DESC
       LIMIT ?`,
      [sessionId, cap]
    );
    return rows;
  },
};
