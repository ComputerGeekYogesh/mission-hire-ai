import { isValidApiBearerToken, resolveApiBearerKeys } from '../../../config/env.js';

/**
 * Plain Bearer API key (no Base64).
 * Header: Authorization: Bearer <MOCK_INTERVIEW_API_KEY from .env>
 */
function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export default function apiBearerAuth(req, res, next) {
  if (resolveApiBearerKeys().size === 0) {
    return res.status(503).json({
      success: false,
      message: 'API authentication is not configured',
      errors: ['Set API_KEY or MOCK_INTERVIEW_API_KEY in .env'],
    });
  }

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized',
      errors: ['Authorization header missing or malformed. Use: Bearer <api_key>'],
    });
  }

  if (!isValidApiBearerToken(token)) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized',
      errors: ['Invalid API key'],
    });
  }

  next();
}
