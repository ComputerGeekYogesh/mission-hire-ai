import db from '../../../config/db.js';

export const auditRepository = {
  async log({ session_id, actor_type, actor_id, action, ip_address, details_json }) {
    await db.query(
      `INSERT INTO interview_audit_logs (session_id, actor_type, actor_id, action, ip_address, details_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        session_id ?? null,
        actor_type,
        actor_id ?? null,
        action,
        ip_address ?? null,
        details_json ? JSON.stringify(details_json) : null,
      ]
    );
  },
};
