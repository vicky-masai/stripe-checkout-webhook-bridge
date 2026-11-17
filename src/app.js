import express from 'express';
import { createStripeWebhookHandler } from './webhook.js';
import { logger as defaultLogger } from './logger.js';

/**
 * Builds the Express app. Kept separate from server.js so the tests can start
 * the same app on a random port with their own configuration.
 */
export function createApp({ config, logger = defaultLogger }) {
  const app = express();
  app.disable('x-powered-by');

  // Stripe signature verification requires the unmodified request bytes, so
  // this route gets express.raw() and must stay above any JSON body parser.
  const handleStripeWebhook = createStripeWebhookHandler({ config, logger });
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res, next) =>
    // Express 4 does not catch rejected promises by itself.
    handleStripeWebhook(req, res).catch(next)
  );

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.use(express.json());

  // Last resort: body parser errors and unexpected exceptions. The client
  // gets a generic message, the details stay in the log.
  app.use((err, _req, res, _next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    logger.error('unhandled_error', { http_status: status, message: err.message });
    res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request body' });
  });

  return app;
}
