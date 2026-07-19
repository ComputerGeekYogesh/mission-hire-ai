import db from '../../../config/db.js';

const BASE_SELECT = `
  SELECT s.*,
    (SELECT COUNT(*) FROM interview_flags f WHERE f.session_id = s.id AND f.resolved = 0) AS open_flags_count,
    (SELECT COUNT(*) FROM interview_recordings r WHERE r.session_id = s.id) AS recordings_count
  FROM interview_sessions s
`;

export const sessionRepository = {
  async create(data) {
    const [result] = await db.query(
      `INSERT INTO interview_sessions (
        session_token, candidate_id, candidate_name, candidate_email, candidate_phone,
        recruiter_id, job_id, job_title, company_id, interview_type,
        scheduled_at, expires_at, status, otp_hash, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.session_token,
        data.candidate_id ?? null,
        data.candidate_name,
        data.candidate_email,
        data.candidate_phone ?? null,
        data.recruiter_id ?? null,
        data.job_id ?? null,
        data.job_title ?? null,
        data.company_id ?? null,
        data.interview_type,
        data.scheduled_at,
        data.expires_at,
        data.status,
        data.otp_hash ?? null,
        data.metadata_json ? JSON.stringify(data.metadata_json) : null,
      ]
    );
    return this.findById(result.insertId);
  },

  async findById(id) {
    const [rows] = await db.query(`${BASE_SELECT} WHERE s.id = ?`, [id]);
    return rows[0] || null;
  },

  async findByToken(token) {
    const [rows] = await db.query(`${BASE_SELECT} WHERE s.session_token = ?`, [token]);
    return rows[0] || null;
  },

  /** Lookup by original invite token stored in metadata after Start Call. */
  async findByInviteToken(token) {
    const [rows] = await db.query(
      `${BASE_SELECT}
       WHERE JSON_UNQUOTE(JSON_EXTRACT(s.metadata_json, '$.invite_token')) = ?
       LIMIT 1`,
      [token]
    );
    return rows[0] || null;
  },

  async findByEmailAndScheduledAt(candidateEmail, scheduledAt) {
    const [rows] = await db.query(
      `${BASE_SELECT}
       WHERE s.candidate_email = ?
         AND s.scheduled_at = ?
         AND s.status NOT IN ('cancelled')
       LIMIT 1`,
      [candidateEmail, scheduledAt]
    );
    return rows;
  },

  async update(id, fields) {
    const allowed = [
      'status', 'session_token', 'otp_verified', 'otp_verified_at', 'preflight_completed', 'preflight_completed_at',
      'headphone_status', 'invite_sent_at', 'started_at', 'ended_at', 'duration_seconds',
      'external_call_sid', 'metadata_json', 'otp_hash',
    ];
    const sets = [];
    const values = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(key === 'metadata_json' && fields[key] != null ? JSON.stringify(fields[key]) : fields[key]);
      }
    }
    if (!sets.length) return this.findById(id);
    values.push(id);
    await db.query(`UPDATE interview_sessions SET ${sets.join(', ')} WHERE id = ?`, values);
    return this.findById(id);
  },

  async list(filters = {}) {
    const where = ['1=1'];
    const params = [];

    if (filters.status) {
      where.push('s.status = ?');
      params.push(filters.status);
    }
    if (filters.recruiter_id) {
      where.push('s.recruiter_id = ?');
      params.push(filters.recruiter_id);
    }
    if (filters.job_id) {
      where.push('s.job_id = ?');
      params.push(filters.job_id);
    }
    if (filters.interview_type) {
      where.push('s.interview_type = ?');
      params.push(filters.interview_type);
    }
    if (filters.date_from) {
      where.push('s.scheduled_at >= ?');
      params.push(filters.date_from);
    }
    if (filters.date_to) {
      where.push('s.scheduled_at <= ?');
      params.push(filters.date_to);
    }
    if (filters.search) {
      where.push('(s.candidate_name LIKE ? OR s.candidate_email LIKE ? OR s.candidate_phone LIKE ?)');
      const q = `%${filters.search}%`;
      params.push(q, q, q);
    }
    if (filters.active_only) {
      where.push(`s.status IN ('invited','verified','preflight_ok','in_progress')`);
    }

    const limit = Math.min(Number(filters.limit) || 50, 200);
    const offset = Number(filters.offset) || 0;

    const [rows] = await db.query(
      `${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.scheduled_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM interview_sessions s WHERE ${where.join(' AND ')}`,
      params
    );

    return { rows, total, limit, offset };
  },

  async getDashboardStats(filters = {}) {
    const where = ['1=1'];
    const params = [];
    if (filters.recruiter_id) {
      where.push('recruiter_id = ?');
      params.push(filters.recruiter_id);
    }

    const w = where.join(' AND ');
    const [[stats]] = await db.query(
      `SELECT
        COUNT(*) AS total,
        SUM(status = 'completed') AS completed,
        SUM(status = 'suspicious') AS suspicious,
        SUM(status IN ('invited','verified','preflight_ok','in_progress')) AS active,
        SUM(status = 'failed') AS failed,
        SUM(otp_verified = 0 AND status NOT IN ('cancelled','completed')) AS pending_verification,
        AVG(CASE WHEN duration_seconds IS NOT NULL THEN duration_seconds END) AS avg_duration_seconds
      FROM interview_sessions WHERE ${w}`,
      params
    );
    return stats;
  },
};
