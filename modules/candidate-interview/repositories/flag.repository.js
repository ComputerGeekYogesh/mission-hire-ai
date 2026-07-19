import db from '../../../config/db.js';

export const flagRepository = {
  async create({ session_id, flag_type, severity, message, payload_json }) {
    const [result] = await db.query(
      `INSERT INTO interview_flags (session_id, flag_type, severity, message, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        session_id,
        flag_type,
        severity,
        message ?? null,
        payload_json ? JSON.stringify(payload_json) : null,
      ]
    );
    return result.insertId;
  },

  async list(filters = {}) {
    const where = ['1=1'];
    const params = [];
    if (filters.session_id) {
      where.push('f.session_id = ?');
      params.push(filters.session_id);
    }
    if (filters.severity) {
      where.push('f.severity = ?');
      params.push(filters.severity);
    }
    if (filters.unresolved_only) {
      where.push('f.resolved = 0');
    }
    const limit = Math.min(Number(filters.limit) || 100, 300);
    const [rows] = await db.query(
      `SELECT f.*, s.candidate_name, s.candidate_email, s.session_token, s.status AS session_status
       FROM interview_flags f
       JOIN interview_sessions s ON s.id = f.session_id
       WHERE ${where.join(' AND ')}
       ORDER BY f.created_at DESC LIMIT ?`,
      [...params, limit]
    );
    return rows;
  },

  async resolve(id) {
    await db.query(`UPDATE interview_flags SET resolved = 1 WHERE id = ?`, [id]);
  },
};
