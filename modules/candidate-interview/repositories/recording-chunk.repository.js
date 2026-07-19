import db from '../../../config/db.js';

export const recordingChunkRepository = {
  async upsert(data) {
    const [existing] = await db.query(
      'SELECT id, sha256, file_size_bytes FROM interview_recording_chunks WHERE session_id = ? AND chunk_index = ? LIMIT 1',
      [data.session_id, data.chunk_index]
    );
    if (existing.length) {
      const row = existing[0];
      if (row.sha256 === data.sha256 && row.file_size_bytes === data.file_size_bytes) {
        return { id: row.id, duplicate: true, chunk_index: data.chunk_index };
      }
      await db.query(
        `UPDATE interview_recording_chunks
         SET content = ?, mime_type = ?, file_size_bytes = ?, sha256 = ?
         WHERE id = ?`,
        [data.content, data.mime_type ?? 'video/webm', data.file_size_bytes, data.sha256, row.id]
      );
      return { id: row.id, replaced: true, chunk_index: data.chunk_index };
    }

    const [result] = await db.query(
      `INSERT INTO interview_recording_chunks
        (session_id, chunk_index, mime_type, file_size_bytes, content, sha256)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        data.session_id,
        data.chunk_index,
        data.mime_type ?? 'video/webm',
        data.file_size_bytes,
        data.content,
        data.sha256 ?? null,
      ]
    );
    return { id: result.insertId, created: true, chunk_index: data.chunk_index };
  },

  async listBySession(sessionId) {
    const [rows] = await db.query(
      `SELECT id, session_id, chunk_index, mime_type, file_size_bytes, sha256, created_at
       FROM interview_recording_chunks
       WHERE session_id = ?
       ORDER BY chunk_index ASC, id ASC`,
      [sessionId]
    );
    return rows;
  },

  async loadContentsBySession(sessionId) {
    const [rows] = await db.query(
      `SELECT id, chunk_index, mime_type, file_size_bytes, content, sha256
       FROM interview_recording_chunks
       WHERE session_id = ?
       ORDER BY chunk_index ASC, id ASC`,
      [sessionId]
    );
    return rows.map((row) => ({
      ...row,
      content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content),
    }));
  },

  async countBySession(sessionId) {
    const [rows] = await db.query(
      'SELECT COUNT(*) AS cnt, COALESCE(SUM(file_size_bytes), 0) AS total_bytes, COALESCE(MAX(chunk_index), -1) AS max_index FROM interview_recording_chunks WHERE session_id = ?',
      [sessionId]
    );
    return rows[0] || { cnt: 0, total_bytes: 0, max_index: -1 };
  },

  async findBySessionAndIndex(sessionId, chunkIndex) {
    const [rows] = await db.query(
      `SELECT id, session_id, chunk_index, file_size_bytes, sha256, created_at
       FROM interview_recording_chunks
       WHERE session_id = ? AND chunk_index = ?
       LIMIT 1`,
      [sessionId, chunkIndex]
    );
    return rows[0] || null;
  },

  async deleteBySession(sessionId) {
    await db.query('DELETE FROM interview_recording_chunks WHERE session_id = ?', [sessionId]);
  },
};
