import AccessControl from "accesscontrol";
import db from './config/db.js';

export const ac = new AccessControl();

const validActions = ["create", "read", "update", "delete"];

export async function initAccessControl() {

  // Get roles, permissions, and pivot
  const [roles] = await db.execute("SELECT id, name FROM roles");
  const [permissions] = await db.execute("SELECT id, resource, action FROM permissions");
  const [rolePerms] = await db.execute("SELECT role_id, permission_id FROM role_permissions");

  // Build AccessControl rules
  for (const role of roles) {
    const grants = rolePerms
      .filter(rp => rp.role_id === role.id)
      .map(rp => {
        const perm = permissions.find(p => p.id === rp.permission_id);
        return perm ? { resource: perm.resource, action: perm.action } : null;
      })
      .filter(Boolean);

    grants.forEach(g => {
      ac.grant(role.id.toString())[g.action](g.resource);
    });
  }

//   await db.end();
}