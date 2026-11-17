# Stripe Checkout Webhook Bridge

A small Node.js service that listens for Stripe `checkout.session.completed` webhooks, proves each one really came from Stripe, and forwards a short, normalized payment notification to an internal notification API.

```
Stripe ──POST /webhooks/stripe──▶ this service ──POST (Bearer token)──▶ internal notification API
          Stripe-Signature           verify → filter → map → forward
```

## What it does

1. **Verifies the signature.** The `Stripe-Signature` header is checked against the unmodified request bytes with `stripe.webhooks.constructEvent`. A missing, wrong, tampered or stale signature gets `400` and nothing else happens.
2. **Filters events.** Only `checkout.session.completed` with a successful payment (`paid` or `no_payment_required`) is forwarded. Everything else is acknowledged with `200` and ignored.
3. **Maps the fields.**

   | Checkout Session | Notification | Example |
   |---|---|---|
   | `id` | `transaction_id` | `cs_test_a1B2c3D4e5F6` |
   | `customer_details.email` | `customer_email` (or `null`) | `alex.rivera@example.test` |
   | `amount_total` | `amount` (minor units) | `4999` |
   | `currency` | `currency` | `usd` |
   | `payment_status` | `status` | `paid` |

4. **Forwards the notification** as an authenticated `POST` with a hard timeout.
5. **Logs every outcome** as one JSON line, with no secrets and with customer emails masked.

## Quick start

Requirements: Node.js 20 or newer.

```bash
npm install
```

```bash
cp .env.example .env
```

Edit `.env` (it is git-ignored, never commit it):

| Variable | Required | Meaning |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | yes | Signing secret (`whsec_...`) printed by `stripe listen`, or of your dashboard endpoint |
| `INTERNAL_API_URL` | yes | Where notifications are sent. Default is the bundled local receiver |
| `INTERNAL_API_TOKEN` | yes | Bearer token for the notification API |
| `INTERNAL_API_TIMEOUT_MS` | no | Upper bound for the forward request. Default `5000` |
| `PORT` | no | Webhook service port. Default `4242` |
| `STRIPE_SECRET_KEY` | no | Stripe test key. Not needed for signature verification |
| `START_MOCK_NOTIFICATION_API` | no | Set to `false` to not start the local receiver |
| `MOCK_API_PORT` | no | Local receiver port. Default `5050` |

The service refuses to start if a required variable is missing and tells you which one.

```bash
npm start
```

This starts the webhook service on `http://localhost:4242` and a local stand-in for the internal notification API on `http://localhost:5050`. Check both with `/health`.

## Testing it

### 1. Automated tests (no Stripe account needed)

```bash
npm test
```

Starts the real app on a random port and sends it HTTP requests signed with the Stripe SDK's own test signer. Covers valid delivery, four kinds of bad signature, duplicates, ignored events, timeout, unreachable receiver, `500` and `401` from the receiver, and recovery on redelivery.

```bash
npm run verify
```

Runs the same scenarios and writes what actually happened to [docs/Webhook_Verification_and_Error_Log.csv](docs/Webhook_Verification_and_Error_Log.csv).

### 2. Stripe CLI (real signed events from your Stripe test account)

```bash
stripe login
```

```bash
stripe listen --forward-to localhost:4242/webhooks/stripe
```

Copy the `whsec_...` secret it prints into `STRIPE_WEBHOOK_SECRET` in `.env`, restart `npm start`, then in another terminal:

```bash
stripe trigger checkout.session.completed
```

You should see a `notification_forwarded` line in the service log, and the notification at `http://localhost:5050/internal/notifications`.

### 3. Postman

Import both files from [postman/](postman/). Set `internalApiToken` and `webhookSecret` in the environment to the values in your `.env`, then run the collection. The webhook requests sign themselves in a pre-request script, so you can see a verified delivery (`200`), a wrong signature (`400`) and a missing signature (`400`) without the Stripe CLI. Each request carries a saved example response recorded from a real local run.

## Responses and retries

| Situation | Response | What Stripe does |
|---|---|---|
| Forwarded, duplicate, or deliberately ignored | `200` | Nothing more |
| Signature missing or invalid | `400` | Retries (a genuine event would pass) |
| Verified event without a required field | `422` | Retries; needs a look |
| Notification API unreachable or non-2xx | `502` | Retries with backoff |
| Notification API timed out | `504` | Retries with backoff |

**Retries.** The service does not retry on its own. When forwarding fails it answers non-2xx, and Stripe redelivers the event with exponential backoff (for up to three days in live mode). That keeps each response fast and means no notification is lost while the internal API is down.

**Idempotency.** Stripe may deliver the same event more than once. An event id is remembered only after the notification API accepted it, so repeats are answered `200` without a second notification, while failed attempts are still forwarded on retry. The memory is in-process (24 hours, 10,000 events); the event id is also sent as an `Idempotency-Key` header so the receiver can de-duplicate across restarts or several instances.

## Project layout

```
src/
  server.js               entry point: loads config, starts the service
  app.js                  Express app; raw-body route for the webhook
  webhook.js              verify → filter → map → forward → respond
  checkout-session.js     field mapping and "is it paid?" rule
  notification-client.js  authenticated POST, timeout, error categories
  idempotency-store.js    remembers forwarded event ids
  config.js               reads and validates environment variables
  logger.js               JSON audit log, email masking
  mock-notification-api.js  local receiver supplied with the assignment
  webhook.test.js         tests
scripts/
  harness.js              test scenarios (shared by test and verify)
  verify.js               writes the verification and error log report
fixtures/                 sample event and notification contract
postman/                  collection and local environment
docs/                     PDF summary, error log report, test evidence
```

## Security notes

- Secrets come only from environment variables. `.env` is git-ignored; `.env.example` holds placeholders.
- Logs never contain the webhook secret, the API token, the signature header or request bodies. Customer emails are masked (`a***@example.test`).
- Use Stripe **test mode** keys for development.
- Point `INTERNAL_API_URL` at a real messaging service only when its owner has given you access and credentials.

## Known limits

- Duplicate detection is in memory, so it is per instance and cleared on restart (see Idempotency above).
- Sessions paid later through a delayed payment method arrive as `checkout.session.async_payment_succeeded`, which is outside this assignment's scope and is currently ignored.

## Documents

- [Technical implementation summary (PDF)](docs/Technical_Implementation_Summary.pdf)
- [Webhook verification and error log (CSV)](docs/Webhook_Verification_and_Error_Log.csv)
- [Test evidence](docs/evidence/)
