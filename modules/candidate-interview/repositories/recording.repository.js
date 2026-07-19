import db from '../../../config/db.js';

export const recordingRepository = {
  async create(data) {
    const [result] = await db.query(
      `INSERT INTO interview_recordings (
        session_id, recording_type, storage_key, mime_type,
        duration_seconds, file_size_bytes, transcript_text, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.session_id,
        data.recording_type,
        data.storage_key,
        data.mime_type ?? null,
        data.duration_seconds ?? null,
        data.file_size_bytes ?? null,
        data.transcript_text ?? null,
        data.metadata_json ? JSON.stringify(data.metadata_json) : null,
      ]
    );
    return result.insertId;
  },

  async list(filters = {}) {
    const where = ['1=1'];
    const params = [];
    if (filters.session_id) {
      where.push('r.session_id = ?');
      params.push(filters.session_id);
    }
    if (filters.recording_type) {
      where.push('r.recording_type = ?');
      params.push(filters.recording_type);
    }
    if (filters.search) {
      where.push('(s.candidate_name LIKE ? OR s.candidate_email LIKE ?)');
      const q = `%${filters.search}%`;
      params.push(q, q);
    }
    const limit = Math.min(Number(filters.limit) || 50, 200);
    const [rows] = await db.query(
      `SELECT r.*, s.candidate_name, s.candidate_email, s.session_token, s.job_title, s.scheduled_at
       FROM interview_recordings r
       JOIN interview_sessions s ON s.id = r.session_id
       WHERE ${where.join(' AND ')}
       ORDER BY r.created_at DESC LIMIT ?`,
      [...params, limit]
    );
    return rows;
  },

  async deleteById(id) {
    await db.query('DELETE FROM interview_recordings WHERE id = ?', [id]);
  },

  async findById(id) {
    const [rows] = await db.query(
      `SELECT r.*, s.session_token FROM interview_recordings r
       JOIN interview_sessions s ON s.id = r.session_id WHERE r.id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  async listChunksBySession(sessionId) {
    const [rows] = await db.query(
      `SELECT * FROM interview_recordings
       WHERE session_id = ?
         AND recording_type = 'video'
         AND (storage_key LIKE '%chunk_%' OR storage_key LIKE '%/chunk_%')
         AND (
           metadata_json IS NULL
           OR JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.merged')) IS NULL
           OR JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.merged')) != 'true'
         )
       ORDER BY
         CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.chunk_index')), '999999') AS UNSIGNED),
         id ASC`,
      [sessionId]
    );
    return rows;
  },

  async findMergedBySession(sessionId) {
    const [rows] = await db.query(
      `SELECT * FROM interview_recordings
       WHERE session_id = ?
         AND recording_type = 'video'
         AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.merged')) = 'true'
       ORDER BY file_size_bytes DESC, id DESC
       LIMIT 1`,
      [sessionId]
    );
    return rows[0] || null;
  },

  /** Admin list: merged videos, transcripts, audio — hide raw chunks */
  async listForAdmin(filters = {}) {
    const where = [
      `(JSON_EXTRACT(r.metadata_json, '$.is_chunk') IS NULL
        OR JSON_UNQUOTE(JSON_EXTRACT(r.metadata_json, '$.is_chunk')) != 'true')`,
    ];
    const params = [];
    if (filters.session_id) {
      where.push('r.session_id = ?');
      params.push(filters.session_id);
    }
    if (filters.recording_type) {
      where.push('r.recording_type = ?');
      params.push(filters.recording_type);
    }
    if (filters.search) {
      where.push('(s.candidate_name LIKE ? OR s.candidate_email LIKE ?)');
      const q = `%${filters.search}%`;
      params.push(q, q);
    }
    const limit = Math.min(Number(filters.limit) || 50, 200);
    const [rows] = await db.query(
      `SELECT r.*, s.candidate_name, s.candidate_email, s.session_token, s.job_title, s.scheduled_at
       FROM interview_recordings r
       JOIN interview_sessions s ON s.id = r.session_id
       WHERE ${where.join(' AND ')}
       ORDER BY r.created_at DESC LIMIT ?`,
      [...params, limit]
    );
    return rows;
  },
};
