import {
  persistPortalEvent,
  validatePortalEventsSecret,
} from '../services/portal-events-receiver.service.js';

export const portalEventsReceiverController = {
  async receive(req, res) {
    if (!validatePortalEventsSecret(req)) {
      return res.status(401).json({ ok: false, message: 'Invalid or missing X-Webhook-Secret' });
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ ok: false, message: 'JSON body required' });
    }

    try {
      const result = await persistPortalEvent(payload);
      return res.status(200).json(result);
    } catch (err) {
      const status = err.status || 500;
      console.error('[portal-events-receiver] HTTP', status, err.message);
      return res.status(status).json({
        ok: false,
        message: err.message || 'Failed to persist portal event.',
      });
    }
  },
};
