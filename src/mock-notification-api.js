import express from 'express';
/** Local receiver for testing the internal notification contract. */
export function startMockNotificationApi(port = 5050) {
  const app = express(); app.use(express.json()); const received = [];
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/internal/notifications', (_req, res) => res.json({ items: received }));
  app.post('/internal/notifications', async (req, res) => {
    const delay = Math.min(Number(req.get('x-test-delay-ms') || 0), 15000);
    const forcedStatus = Number(req.get('x-test-status') || 0);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (forcedStatus >= 400 && forcedStatus <= 599)
      return res.status(forcedStatus).json({ error: 'Configured local receiver test response' });
    if (req.get('authorization') !== `Bearer ${process.env.INTERNAL_API_TOKEN || 'replace_with_local_test_token'}`)
      return res.status(401).json({ error: 'Unauthorized' });
    const required = ['transaction_id','customer_email','amount','currency','status'];
    const missing = required.filter(k => req.body?.[k] === undefined);
    if (missing.length) return res.status(422).json({ error: 'Missing fields', fields: missing });
    received.push({ ...req.body, received_at: new Date().toISOString() });
    return res.status(202).json({ accepted: true, count: received.length });
  });
  return app.listen(port, () => console.log(`Local notification API listening on http://localhost:${port}`));
}
