import { logInterviewError } from '../services/interview-error-log.service.js';

export function interviewErrorHandler(err, req, res, _next) {
  console.error('[candidate-interview]', err);
  logInterviewError({
    severity: 'error',
    sourceTag: 'http_error',
    sourceFile: 'error-handler.middleware.js',
    message: err.message,
    err,
    context: { path: req.path, method: req.method },
  }).catch(() => {});
  const status = err.status || 500;
  const message = err.message || 'Internal server error';

  if (req.accepts('html') && !req.xhr && req.method === 'GET') {
    return res.status(status).render('modules/candidate-interview/candidate/error', {
      title: 'Error',
      message,
      layout: false,
    });
  }

  return res.status(status).json({ error: message });
}
