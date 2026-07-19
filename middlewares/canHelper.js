export const canHelper = (req, res, next) => {
  // Make sure attachPermissions middleware runs BEFORE this
  res.locals.can = (action, resource) => {
    return (
      res.locals.permissions?.[`${action}_${resource}`] === true ||
      res.locals.permissions?.[`${action}:any_${resource}`] === true
    );
  };
  next();
};