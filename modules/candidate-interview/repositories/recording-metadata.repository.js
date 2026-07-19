import db from '../../../config/db.js';

export const recordingMetadataRepository = {
  async upsertForSession(sessionId, data = {}) {
    const existing = await this.findBySessionId(sessionId);
    if (existing) {
      const fields = [];
      const params = [];
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        fields.push(`${key} = ?`);
        params.push(value);
      }
      if (!fields.length) return existing.id;
      params.push(sessionId);
      await db.query(
        `UPDATE interview_recording_metadata SET ${fields.join(', ')} WHERE session_id = ?`,
        params
      );
      return existing.id;
    }

    const [result] = await db.query(
      `INSERT INTO interview_recording_metadata (
        session_id, total_chunks_expected, chunks_received, merge_status,
        merged_file_path, merged_file_size_bytes, signed_url,
        webhook_sent_at, webhook_status, recording_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        data.total_chunks_expected ?? null,
        data.chunks_received ?? 0,
        data.merge_status ?? 'pending',
        data.merged_file_path ?? null,
        data.merged_file_size_bytes ?? null,
        data.signed_url ?? null,
        data.webhook_sent_at ?? null,
        data.webhook_status ?? null,
        data.recording_status ?? null,
      ]
    );
    return result.insertId;
  },

  async findBySessionId(sessionId) {
    const [rows] = await db.query(
      'SELECT * FROM interview_recording_metadata WHERE session_id = ? LIMIT 1',
      [sessionId]
    );
    return rows[0] || null;
  },

  async updateBySessionId(sessionId, data) {
    return this.upsertForSession(sessionId, data);
  },
};
