import db from '../../../config/db.js';

export const recordingBlobRepository = {
  async upsert(recordingId, buffer, sha256 = null) {
    const [existing] = await db.query(
      'SELECT id FROM interview_recording_blobs WHERE recording_id = ? LIMIT 1',
      [recordingId]
    );
    if (existing.length) {
      await db.query(
        'UPDATE interview_recording_blobs SET content = ?, sha256 = ? WHERE recording_id = ?',
        [buffer, sha256, recordingId]
      );
      return existing[0].id;
    }
    const [result] = await db.query(
      'INSERT INTO interview_recording_blobs (recording_id, content, sha256) VALUES (?, ?, ?)',
      [recordingId, buffer, sha256]
    );
    return result.insertId;
  },

  async findByRecordingId(recordingId) {
    const [rows] = await db.query(
      'SELECT id, recording_id, content, sha256, created_at FROM interview_recording_blobs WHERE recording_id = ? LIMIT 1',
      [recordingId]
    );
    const row = rows[0];
    if (!row) return null;
    return row;
  },

  async existsForRecording(recordingId) {
    const [rows] = await db.query(
      'SELECT 1 FROM interview_recording_blobs WHERE recording_id = ? LIMIT 1',
      [recordingId]
    );
    return rows.length > 0;
  },

  async deleteByRecordingId(recordingId) {
    await db.query('DELETE FROM interview_recording_blobs WHERE recording_id = ?', [recordingId]);
  },
};
