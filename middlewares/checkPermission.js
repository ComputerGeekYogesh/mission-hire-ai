import { ac } from "../accesscontrol.js";

export const checkPermission = (requiredPermission) => {
  return (req, res, next) => {
    try {
      // Permissions from attachPermissions middleware
      const permissions = res.locals.permissions || {};

      // Example: requiredPermission = "read:any_permissions"
      if (permissions[requiredPermission]) {
        // ✅ Permission allowed
        return next();
      }

      console.warn(`❌ Access denied for ${requiredPermission}`);
      return res.status(403).render('no-access', {
        message: `Access Denied: Missing permission "${requiredPermission}"`,
      });
    } catch (error) {
      console.error('Permission check error:', error);
      return res.status(500).send('Internal Server Error');
    }
  };
};


