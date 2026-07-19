import { verifySessionToken } from '../services/token.service.js';
import { sessionRepository } from '../repositories/session.repository.js';
import { sessionService } from '../services/session.service.js';

function renderSessionError(req, res, err) {
  const status = err.status || 500;
  if (req.accepts('html')) {
    return res.status(status).render('modules/candidate-interview/candidate/error', {
      title: err.title || 'Assessment unavailable',
      message: err.message || 'This link is not valid.',
      layout: false,
    });
  }
  return res.status(status).json({ error: err.message, code: err.code || null });
}

async function resolveInterviewSession(token) {
  if (!verifySessionToken(token)) {
    const err = new Error('Invalid assessment link');
    err.status = 400;
    err.title = 'Invalid link';
    throw err;
  }

  let session = await sessionRepository.findByToken(token);
  if (!session) {
    const consumed = await sessionRepository.findByInviteToken(token);
    if (consumed) {
      throw sessionService.buildInviteLinkInvalidError(consumed);
    }
    const err = new Error('Interview session not found');
    err.status = 404;
    err.title = 'Link not found';
    throw err;
  }

  return session;
}

export async function loadInterviewSession(req, res, next) {
  try {
    const session = await resolveInterviewSession(req.params.token);
    sessionService.assertSessionAccessible(session);
    req.interviewSession = session;
    req.interviewToken = req.params.token;
    next();
  } catch (err) {
    return renderSessionError(req, res, err);
  }
}

/**
 * Permits recording chunk uploads and /end finalization even when proctoring
 * termination metadata is set or session status is already terminated.
 */
export async function loadInterviewSessionForRecording(req, res, next) {
  try {
    const session = await resolveInterviewSession(req.params.token);
    sessionService.assertSessionAccessible(session, { allowRecordingFlush: true });
    req.interviewSession = session;
    req.interviewToken = req.params.token;
    next();
  } catch (err) {
    return renderSessionError(req, res, err);
  }
}
