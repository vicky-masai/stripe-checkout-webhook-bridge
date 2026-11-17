import express from 'express';

/**
 * Local receiver for testing the internal notification contract
 * (fixtures/notification-contract.json). Supplied with the assignment; it is a
 * development stand-in, not a real messaging service.
 *
 *   GET  /health                   liveness check
 *   GET  /internal/notifications   everything received so far
 *   POST /internal/notifications   202 accepted | 401 bad token | 422 missing fields
 *
 * Two request headers let a caller simulate trouble:
 *   x-test-delay-ms  wait this long before answering (max 15000)
 *   x-test-status    answer with this 4xx/5xx status instead
 */
export function startMockNotificationApi(port = 5050) {
  const app = express();
  app.use(express.json());
  const received = []; // kept in memory only

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/internal/notifications', (_req, res) => res.json({ items: received }));

  app.post('/internal/notifications', async (req, res) => {
    // Optional fault injection for timeout and error tests.
    const delay = Math.min(Number(req.get('x-test-delay-ms') || 0), 15000);
    const forcedStatus = Number(req.get('x-test-status') || 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (forcedStatus >= 400 && forcedStatus <= 599) {
      return res.status(forcedStatus).json({ error: 'Configured local receiver test response' });
    }

    // Authentication: the Bearer token must match INTERNAL_API_TOKEN.
    const expected = `Bearer ${process.env.INTERNAL_API_TOKEN || 'replace_with_local_test_token'}`;
    if (req.get('authorization') !== expected) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Validation: every contract field must be present (customer_email may be null).
    const required = ['transaction_id', 'customer_email', 'amount', 'currency', 'status'];
    const missing = required.filter((field) => req.body?.[field] === undefined);
    if (missing.length) return res.status(422).json({ error: 'Missing fields', fields: missing });

    received.push({ ...req.body, received_at: new Date().toISOString() });
    return res.status(202).json({ accepted: true, count: received.length });
  });

  return app.listen(port, () => console.log(`Local notification API listening on http://localhost:${port}`));
}
