export default function redirectIfAuthenticated(req, res, next) {
    if (req.session.isLoggedIn) {
      return res.redirect('/admin/dashboard');
    }
    next();
  }
  