/**
 * Local test harness, shared by `npm test` and `npm run verify`.
 *
 * It starts the real webhook app on a random port, signs events with the
 * Stripe SDK (the same HMAC-SHA256 scheme Stripe and the Stripe CLI use) and
 * delivers them over real HTTP. No Stripe account or network access is needed
 * and every secret is generated fresh for the run.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { createApp } from '../src/app.js';
import { startMockNotificationApi } from '../src/mock-notification-api.js';

const stripe = new Stripe('sk_test_local_harness');
const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString('hex')}`;
const API_TOKEN = `harness_${randomBytes(12).toString('hex')}`;

const fixture = (name) => readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8').then(JSON.parse);
const baseEvent = await fixture('checkout.session.completed.json');
const expectedPayload = await fixture('notification-payload.expected.json');

async function urlOf(server) {
  if (!server.listening) await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function closer(server) {
  return async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  };
}

/** The webhook service under test. Log entries are captured instead of printed. */
async function startBridge({ notificationUrl, token = API_TOKEN, timeoutMs = 300 }) {
  const logs = [];
  const record = (level) => (event, fields = {}) => logs.push({ level, event, ...fields });
  const app = createApp({
    config: {
      stripeSecretKey: 'sk_test_local_harness',
      stripeWebhookSecret: WEBHOOK_SECRET,
      notificationUrl,
      notificationToken: token,
      notificationTimeoutMs: timeoutMs,
    },
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
  });
  const server = app.listen(0);
  return { url: await urlOf(server), logs, close: closer(server) };
}

/** The supplied local receiver: checks the Bearer token and the payload contract. */
async function startContractReceiver() {
  process.env.INTERNAL_API_TOKEN = API_TOKEN; // the supplied receiver reads its token from here
  const server = startMockNotificationApi(0);
  const base = await urlOf(server);
  return {
    url: `${base}/internal/notifications`,
    items: async () => (await (await fetch(`${base}/internal/notifications`)).json()).items,
    close: closer(server),
  };
}

/** A misbehaving receiver: answers with a fixed status, or never answers ("hang"). */
async function startFaultyReceiver(behaviour) {
  const state = { behaviour, hits: 0 };
  const server = createServer((req, res) => {
    state.hits += 1;
    req.resume();
    if (state.behaviour === 'hang') return;
    res.writeHead(state.behaviour, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: 'faulty receiver test response' }));
  });
  server.listen(0);
  return { url: `${await urlOf(server)}/internal/notifications`, state, close: closer(server) };
}

/** A URL on which nothing is listening. */
async function unusedUrl() {
  const server = createServer().listen(0);
  const url = await urlOf(server);
  await closer(server)();
  return `${url}/internal/notifications`;
}

function makeEvent(change = () => {}) {
  const event = structuredClone(baseEvent);
  event.id = `evt_test_${randomBytes(8).toString('hex')}`;
  change(event);
  return event;
}

/**
 * Delivers an event the way Stripe does. Options let a scenario break one thing:
 *   secret     sign with a different secret
 *   timestamp  sign with another time (seconds)
 *   signature  send this header verbatim; null sends no header at all
 *   body       send these bytes instead of the signed ones
 */
async function deliver(bridge, event, { secret = WEBHOOK_SECRET, timestamp, signature, body } = {}) {
  const payload = JSON.stringify(event);
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== null) {
    headers['Stripe-Signature'] = signature ?? stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
  }
  const response = await fetch(`${bridge.url}/webhooks/stripe`, { method: 'POST', headers, body: body ?? payload });
  return { status: response.status, body: await response.json() };
}

/**
 * Every scenario returns { event, result, logs, notes }. `expect` holds the HTTP
 * status and log error category the scenario must produce; `retry` and
 * `resolution` describe the documented behaviour for the error log report.
 */
export const scenarios = [
  {
    name: 'valid signed checkout.session.completed is forwarded',
    expect: { status: 200, category: 'none' },
    retry: 'None needed',
    resolution: 'Signature verified, fields mapped, receiver answered 202',
    async run() {
      const receiver = await startContractReceiver();
      const bridge = await startBridge({ notificationUrl: receiver.url });
      try {
        const event = makeEvent();
        const result = await deliver(bridge, event);
        const items = await receiver.items();
        assert.equal(result.body.status, 'forwarded');
        assert.equal(items.length, 1);
        const { received_at, ...stored } = items[0];
        assert.deepEqual(stored, expectedPayload);
        // The audit log must not contain the full customer email.
        assert.ok(!JSON.stringify(bridge.logs).includes(expectedPayload.customer_email));
        return { event, result, logs: bridge.logs, notes: 'Receiver stored exactly fixtures/notification-payload.expected.json; email masked in log' };
      } finally {
        await bridge.close();
        await receiver.close();
      }
    },
  },
  {
    name: 'missing Stripe-Signature header is rejected',
    expect: { status: 400, category: 'missing_signature' },
    retry: 'None. Sender must sign the request',
    resolution: 'Rejected before any processing; nothing forwarded',
    run: () => rejected({ signature: null }),
  },
  {
    name: 'signature made with a wrong secret is rejected',
    expect: { status: 400, category: 'invalid_signature' },
    retry: 'None. Check STRIPE_WEBHOOK_SECRET matches the endpoint',
    resolution: 'Rejected before any processing; nothing forwarded',
    run: () => rejected({ secret: 'whsec_not_the_configured_secret' }),
  },
  {
    name: 'body altered after signing is rejected',
    expect: { status: 400, category: 'invalid_signature' },
    retry: 'None',
    resolution: 'Rejected: signature no longer matches the raw bytes; nothing forwarded',
    run: () =>
      rejected({}, (event) => ({
        body: JSON.stringify(event).replace('"amount_total":4999', '"amount_total":1'),
      })),
  },
  {
    name: 'signature older than the 5 minute tolerance is rejected',
    expect: { status: 400, category: 'invalid_signature' },
    retry: 'None',
    resolution: 'Rejected as a possible replay; nothing forwarded',
    run: () => rejected({ timestamp: Math.floor(Date.now() / 1000) - 600 }),
  },
  {
    name: 'duplicate delivery of the same event is acknowledged once',
    expect: { status: 200, category: 'none' },
    retry: 'None needed',
    resolution: 'Second delivery answered 200 "duplicate"; receiver holds one notification',
    async run() {
      const receiver = await startContractReceiver();
      const bridge = await startBridge({ notificationUrl: receiver.url });
      try {
        const event = makeEvent();
        await deliver(bridge, event);
        const result = await deliver(bridge, event);
        assert.equal(result.body.status, 'duplicate');
        assert.equal((await receiver.items()).length, 1);
        return { event, result, logs: bridge.logs, notes: 'Same event id delivered twice; forwarded once' };
      } finally {
        await bridge.close();
        await receiver.close();
      }
    },
  },
  {
    name: 'other event types are acknowledged and ignored',
    expect: { status: 200, category: 'none' },
    retry: 'None needed',
    resolution: 'Answered 200 "ignored"; nothing forwarded',
    run: () => ignored((event) => { event.type = 'payment_intent.created'; }),
  },
  {
    name: 'completed session that is still unpaid is not announced',
    expect: { status: 200, category: 'none' },
    retry: 'None needed',
    resolution: 'Answered 200 "ignored"; nothing forwarded until payment succeeds',
    run: () => ignored((event) => { event.data.object.payment_status = 'unpaid'; }),
  },
  {
    name: 'session without amount_total is reported as unprocessable',
    expect: { status: 422, category: 'invalid_payload' },
    retry: 'Stripe redelivers; needs investigation',
    resolution: 'Answered 422 with the missing field name; nothing forwarded',
    async run() {
      const receiver = await startFaultyReceiver(202);
      const bridge = await startBridge({ notificationUrl: receiver.url });
      try {
        const event = makeEvent((e) => { e.data.object.amount_total = null; });
        const result = await deliver(bridge, event);
        assert.deepEqual(result.body.fields, ['amount_total']);
        assert.equal(receiver.state.hits, 0);
        return { event, result, logs: bridge.logs, notes: 'Signature valid, amount_total null' };
      } finally {
        await bridge.close();
        await receiver.close();
      }
    },
  },
  {
    name: 'notification API timeout returns 504',
    expect: { status: 504, category: 'timeout' },
    retry: 'Stripe redelivers with backoff',
    resolution: 'Request aborted at the configured timeout; event stays unprocessed',
    async run() {
      const receiver = await startFaultyReceiver('hang');
      const bridge = await startBridge({ notificationUrl: receiver.url, timeoutMs: 300 });
      try {
        const event = makeEvent();
        const started = Date.now();
        const result = await deliver(bridge, event);
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 2000, `took ${elapsed} ms`);
        return { event, result, logs: bridge.logs, notes: `Receiver never answered; timeout set to 300 ms; webhook answered after ${elapsed} ms` };
      } finally {
        await bridge.close();
        await receiver.close();
      }
    },
  },
  {
    name: 'unreachable notification API returns 502',
    expect: { status: 502, category: 'network' },
    retry: 'Stripe redelivers with backoff',
    resolution: 'Connection failure caught; event stays unprocessed',
    async run() {
      const bridge = await startBridge({ notificationUrl: await unusedUrl() });
      try {
        const event = makeEvent();
        const result = await deliver(bridge, event);
        return { event, result, logs: bridge.logs, notes: bridge.logs.at(-1)?.message };
      } finally {
        await bridge.close();
      }
    },
  },
  {
    name: 'notification API answering 500 returns 502',
    expect: { status: 502, category: 'http_error' },
    retry: 'Stripe redelivers with backoff',
    resolution: 'Non-2xx detected; event stays unprocessed',
    async run() {
      const receiver = await startFaultyReceiver(500);
      const bridge = await startBridge({ notificationUrl: receiver.url });
      try {
        const event = makeEvent();
        const result = await deliver(bridge, event);
        assert.equal(bridge.logs.at(-1).downstream_status, 500);
        return { event, result, logs: bridge.logs, notes: 'Receiver answered HTTP 500' };
      } finally {
        await bridge.close();
        await receiver.close();
      }
    },
  },
  {
    name: 'wrong internal API token (receiver answers 401) returns 502',
    expect: { status: 502, category: 'http_error' },
    retry: 'Stripe redelivers; fix INTERNAL_API_TOKEN',
    resolution: 'Non-2xx detected; token value never logged',
    async run() {
      const receiver = await startContractReceiver();
      const bridge = await startBridge({ notificationUrl: receiver.url, token: 'wrong-token-for-test' });
      try {
        const event = makeEvent();
        const result = await deliver(bridge, event);
        assert.equal(bridge.logs.at(-1).downstream_status, 401);
        assert.ok(!JSON.stringify(bridge.logs).includes('wrong-token-for-test'));
        assert.equal((await receiver.items()).length, 0);
        return { event, result, logs: bridge.logs, notes: 'Supplied receiver answered HTTP 401' };
      } finally {
        await bridge.close();
        await receiver.close();
      }
    },
  },
  {
    name: 'event that failed once is forwarded when redelivered',
    expect: { status: 200, category: 'none' },
    retry: 'Redelivery succeeded',
    resolution: 'First attempt 502, receiver recovered, same event then forwarded',
    async run() {
      const receiver = await startFaultyReceiver(503);
      const bridge = await startBridge({ notificationUrl: receiver.url });
      try {
        const event = makeEvent();
        const first = await deliver(bridge, event);
        assert.equal(first.status, 502);
        receiver.state.behaviour = 202; // the internal service is back
        const result = await deliver(bridge, event);
        assert.equal(result.body.status, 'forwarded');
        assert.equal(receiver.state.hits, 2);
        return { event, result, logs: bridge.logs, notes: 'Simulates a Stripe retry after a 503 outage' };
      } finally {
        await bridge.close();
        await receiver.close();
      }
    },
  },
];

/** Shared body of the signature scenarios: the receiver must never be called. */
async function rejected(deliveryOptions, extraOptions = () => ({})) {
  const receiver = await startFaultyReceiver(202);
  const bridge = await startBridge({ notificationUrl: receiver.url });
  try {
    const event = makeEvent();
    const result = await deliver(bridge, event, { ...deliveryOptions, ...extraOptions(event) });
    assert.equal(receiver.state.hits, 0);
    return { event, result, logs: bridge.logs, notes: bridge.logs.at(-1)?.message ?? 'No Stripe-Signature header sent' };
  } finally {
    await bridge.close();
    await receiver.close();
  }
}

/** Shared body of the "acknowledge but do nothing" scenarios. */
async function ignored(change) {
  const receiver = await startFaultyReceiver(202);
  const bridge = await startBridge({ notificationUrl: receiver.url });
  try {
    const event = makeEvent(change);
    const result = await deliver(bridge, event);
    assert.equal(result.body.status, 'ignored');
    assert.equal(receiver.state.hits, 0);
    return { event, result, logs: bridge.logs, notes: `Log reason: ${bridge.logs.at(-1).reason}` };
  } finally {
    await bridge.close();
    await receiver.close();
  }
}

/** Runs one scenario and checks the two things every scenario promises. */
export async function runScenario(scenario) {
  const outcome = await scenario.run();
  const lastLog = outcome.logs.at(-1) ?? {};
  const category = lastLog.error_category ?? 'none';
  assert.equal(outcome.result.status, scenario.expect.status);
  assert.equal(category, scenario.expect.category);
  return { ...outcome, category, stage: lastLog.stage ?? lastLog.event };
}
