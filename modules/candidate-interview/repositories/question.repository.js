import db from '../../../config/db.js';

export const questionRepository = {
  async bulkCreate(sessionId, questions) {
    const ids = [];
    for (const q of questions) {
      const [r] = await db.query(
        `INSERT INTO interview_session_questions
          (session_id, question_order, question_text, category, required_flag, source_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          q.order,
          q.question,
          q.category ?? null,
          q.required !== false ? 1 : 0,
          q.source_type || 'custom',
        ]
      );
      ids.push(r.insertId);
    }
    return ids;
  },

  async listBySession(sessionId) {
    const [rows] = await db.query(
      `SELECT * FROM interview_session_questions WHERE session_id = ? ORDER BY question_order ASC`,
      [sessionId]
    );
    return rows;
  },

  async findById(id) {
    const [rows] = await db.query(`SELECT * FROM interview_session_questions WHERE id = ?`, [id]);
    return rows[0] || null;
  },

  async setFeedbackId(questionId, feedbackId) {
    await db.query(`UPDATE interview_session_questions SET feedback_id = ? WHERE id = ?`, [
      feedbackId,
      questionId,
    ]);
  },

  async countAnswered(sessionId) {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS c FROM interview_question_responses WHERE session_id = ?`,
      [sessionId]
    );
    return row.c;
  },

  async listWithResponses(sessionId) {
    const [rows] = await db.query(
      `SELECT
         q.*,
         resp.id AS response_id,
         resp.response_text,
         resp.score,
         resp.ai_feedback,
         resp.answered_at,
         resp.audio_storage_key,
         rec.id AS answer_recording_id,
         rec.mime_type AS answer_mime_type
       FROM interview_session_questions q
       LEFT JOIN interview_question_responses resp
         ON resp.question_id = q.id AND resp.session_id = q.session_id
       LEFT JOIN interview_recordings rec
         ON rec.session_id = q.session_id
         AND rec.recording_type = 'audio'
         AND CAST(JSON_UNQUOTE(JSON_EXTRACT(rec.metadata_json, '$.question_id')) AS UNSIGNED) = q.id
       WHERE q.session_id = ?
       ORDER BY q.question_order ASC, resp.id DESC, rec.id DESC`,
      [sessionId]
    );
    const seen = new Set();
    return rows.filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  },
};
