export default function protectRoute(req, res, next) {
    if (!req.session.isLoggedIn) {
      return res.redirect('/login');
    }
    res.locals.name = req.session ? req.session.name : undefined;
    next();
  }
  