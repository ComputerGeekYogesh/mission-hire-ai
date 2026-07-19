import db from '../../../config/db.js';

export const summaryRepository = {
  async upsert(data) {
    const [existing] = await db.query(
      `SELECT id FROM interview_call_summaries WHERE session_id = ?`,
      [data.session_id]
    );
    if (existing.length) {
      await db.query(
        `UPDATE interview_call_summaries SET
          mock_call_id = ?, call_sid = ?, mission_verdict = ?, mission_recommendations = ?,
          summary_json = ?, duration_seconds = ?, updated_at = NOW()
         WHERE session_id = ?`,
        [
          data.mock_call_id,
          data.call_sid,
          data.mission_verdict ?? null,
          data.mission_recommendations ? JSON.stringify(data.mission_recommendations) : null,
          data.summary_json ? JSON.stringify(data.summary_json) : null,
          data.duration_seconds ?? null,
          data.session_id,
        ]
      );
      return existing[0].id;
    }

    const [r] = await db.query(
      `INSERT INTO interview_call_summaries
        (session_id, mock_call_id, call_sid, mission_verdict, mission_recommendations, summary_json, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.session_id,
        data.mock_call_id,
        data.call_sid,
        data.mission_verdict ?? null,
        data.mission_recommendations ? JSON.stringify(data.mission_recommendations) : null,
        data.summary_json ? JSON.stringify(data.summary_json) : null,
        data.duration_seconds ?? null,
      ]
    );
    return r.insertId;
  },

  async findBySession(sessionId) {
    const [rows] = await db.query(`SELECT * FROM interview_call_summaries WHERE session_id = ?`, [
      sessionId,
    ]);
    return rows[0] || null;
  },
};
