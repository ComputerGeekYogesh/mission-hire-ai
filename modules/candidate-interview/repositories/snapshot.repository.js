import db from '../../../config/db.js';

export const snapshotRepository = {
  async create({ session_id, storage_key, confidence_score, face_count, captured_at }) {
    const [result] = await db.query(
      `INSERT INTO interview_snapshots (session_id, storage_key, confidence_score, face_count, captured_at)
       VALUES (?, ?, ?, ?, ?)`,
      [session_id, storage_key, confidence_score ?? null, face_count ?? 1, captured_at]
    );
    return result.insertId;
  },

  async listBySession(sessionId, limit = 100) {
    const [rows] = await db.query(
      `SELECT * FROM interview_snapshots WHERE session_id = ? ORDER BY captured_at DESC LIMIT ?`,
      [sessionId, limit]
    );
    return rows;
  },

  async countBySession(sessionId) {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS total FROM interview_snapshots WHERE session_id = ?`,
      [sessionId]
    );
    return row.total;
  },
};
