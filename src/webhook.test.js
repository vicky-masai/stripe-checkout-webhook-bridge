import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, runScenario } from '../scripts/harness.js';
import { mapCheckoutSession, InvalidSessionError } from './checkout-session.js';
import { loadConfig } from './config.js';
import { maskEmail } from './logger.js';

// End-to-end: each scenario starts the real app, sends a signed HTTP request
// and checks the response status and the audit log entry.
for (const scenario of scenarios) {
  test(scenario.name, () => runScenario(scenario));
}

test('mapping tolerates a session without customer details', () => {
  const payload = mapCheckoutSession({ id: 'cs_test_1', amount_total: 0, currency: 'INR', payment_status: 'no_payment_required' });
  assert.deepEqual(payload, {
    transaction_id: 'cs_test_1',
    customer_email: null,
    amount: 0,
    currency: 'inr',
    status: 'no_payment_required',
  });
});

test('mapping names every missing field', () => {
  assert.throws(() => mapCheckoutSession({}), (err) => {
    assert.ok(err instanceof InvalidSessionError);
    assert.deepEqual(err.missingFields, ['id', 'amount_total', 'currency', 'payment_status']);
    return true;
  });
});

test('configuration fails fast and names the missing variables, not their values', () => {
  assert.throws(() => loadConfig({ INTERNAL_API_URL: 'http://localhost:5050/x' }), /STRIPE_WEBHOOK_SECRET, INTERNAL_API_TOKEN/);
  assert.throws(
    () => loadConfig({ STRIPE_WEBHOOK_SECRET: 'whsec_x', INTERNAL_API_URL: 'not a url', INTERNAL_API_TOKEN: 't' }),
    /INTERNAL_API_URL must be a valid absolute URL/
  );
});

test('configuration falls back to a 5000 ms timeout when the value is unusable', () => {
  const env = { STRIPE_WEBHOOK_SECRET: 'whsec_x', INTERNAL_API_URL: 'http://localhost:5050/x', INTERNAL_API_TOKEN: 't' };
  assert.equal(loadConfig({ ...env, INTERNAL_API_TIMEOUT_MS: 'abc' }).notificationTimeoutMs, 5000);
  assert.equal(loadConfig({ ...env, INTERNAL_API_TIMEOUT_MS: '1500' }).notificationTimeoutMs, 1500);
});

test('email addresses are masked for logging', () => {
  assert.equal(maskEmail('alex.rivera@example.test'), 'a***@example.test');
  assert.equal(maskEmail(null), null);
});
