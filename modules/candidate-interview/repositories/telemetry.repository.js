import db from '../../../config/db.js';

export const telemetryRepository = {
  async create(payload) {
    const [result] = await db.query(
      `INSERT INTO interview_telemetry (
        session_id, blink_count, yaw, pitch, roll, movement_score,
        face_detected, face_count, mic_active, camera_active, tab_visible,
        suspicious_flag, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.session_id,
        payload.blink_count ?? 0,
        payload.yaw ?? null,
        payload.pitch ?? null,
        payload.roll ?? null,
        payload.movement_score ?? null,
        payload.face_detected ? 1 : 0,
        payload.face_count ?? 0,
        payload.mic_active ? 1 : 0,
        payload.camera_active ? 1 : 0,
        payload.tab_visible !== false ? 1 : 0,
        payload.suspicious_flag ? 1 : 0,
        payload.recorded_at,
      ]
    );
    return result.insertId;
  },

  async listBySession(sessionId, limit = 500) {
    const [rows] = await db.query(
      `SELECT * FROM interview_telemetry WHERE session_id = ? ORDER BY recorded_at DESC LIMIT ?`,
      [sessionId, limit]
    );
    return rows;
  },

  async getAggregates(sessionId) {
    const [[row]] = await db.query(
      `SELECT
        COUNT(*) AS samples,
        SUM(suspicious_flag) AS suspicious_samples,
        AVG(ABS(yaw)) AS avg_abs_yaw,
        AVG(ABS(pitch)) AS avg_abs_pitch,
        AVG(movement_score) AS avg_movement,
        SUM(face_detected = 0) AS no_face_samples
      FROM interview_telemetry WHERE session_id = ?`,
      [sessionId]
    );
    return row;
  },

  async listReports(filters = {}) {
    const where = ['1=1'];
    const params = [];
    if (filters.session_id) {
      where.push('t.session_id = ?');
      params.push(filters.session_id);
    }
    if (filters.suspicious_only) {
      where.push('t.suspicious_flag = 1');
    }
    if (filters.search) {
      where.push('(s.candidate_name LIKE ? OR s.candidate_email LIKE ? OR s.candidate_phone LIKE ?)');
      const q = `%${filters.search}%`;
      params.push(q, q, q);
    }
    const limit = Math.min(Number(filters.limit) || 50, 200);
    const offset = Math.max(0, Number(filters.offset) || 0);
    const showAllSamples = filters.all_samples === true || filters.all_samples === '1';
    const fromClause = showAllSamples
      ? `FROM interview_telemetry t JOIN interview_sessions s ON s.id = t.session_id`
      : `FROM interview_telemetry t
         JOIN interview_sessions s ON s.id = t.session_id
         INNER JOIN (
           SELECT session_id, MAX(recorded_at) AS max_recorded_at
           FROM interview_telemetry
           GROUP BY session_id
         ) tlatest ON t.session_id = tlatest.session_id AND t.recorded_at = tlatest.max_recorded_at`;
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total ${fromClause} WHERE ${where.join(' AND ')}`,
      params
    );
    const [rows] = await db.query(
      `SELECT t.id, t.session_id, t.blink_count, t.yaw, t.pitch, t.roll, t.movement_score,
              t.face_detected, t.face_count, t.mic_active, t.camera_active, t.tab_visible,
              t.suspicious_flag, t.recorded_at,
              s.candidate_name, s.candidate_email, s.candidate_phone, s.session_token, s.job_title
       ${fromClause}
       WHERE ${where.join(' AND ')}
       ORDER BY t.recorded_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { rows, total: Number(total || 0), limit, offset };
  },
};
