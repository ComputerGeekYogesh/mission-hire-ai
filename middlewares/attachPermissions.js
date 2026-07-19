import { ac } from "../accesscontrol.js";

export const attachPermissions = (req, res, next) => {
  const roleId = req.session.role_id?.toString(); // get role ID as string
  const grants = ac.getGrants()[roleId] || {};

  const formatted = {};
  Object.keys(grants).forEach(resource => {
    Object.keys(grants[resource]).forEach(action => {
      formatted[`${action}_${resource}`] = true;
    });
  });

  res.locals.permissions = formatted; // attach for EJS
  res.locals.roleId = parseInt(roleId, 10) || 0;
  //  console.log('Permissions for role:', roleId, res.locals.permissions);
  next();
};
