import Stripe from 'stripe';
import { forwardNotification, NotificationError } from './notification-client.js';
import { mapCheckoutSession, isPaymentSuccessful, InvalidSessionError } from './checkout-session.js';
import { ProcessedEventStore } from './idempotency-store.js';
import { logger as defaultLogger, maskEmail } from './logger.js';

const HANDLED_EVENT_TYPE = 'checkout.session.completed';

/**
 * Builds the Express handler for POST /webhooks/stripe.
 *
 * Flow of one request:
 *   1. Verify the Stripe-Signature header against the raw request bytes.
 *   2. Ignore every event type except checkout.session.completed.
 *   3. Skip events already forwarded (Stripe may deliver an event twice).
 *   4. Skip sessions whose payment is not successful yet.
 *   5. Map the session to the notification payload and POST it downstream.
 *   6. Answer Stripe: 2xx = "done, do not resend", anything else = "retry".
 *
 * Responses:
 *   200  forwarded, duplicate, or deliberately ignored
 *   400  signature missing or invalid, nothing is processed
 *   422  verified event, but the session lacks a required field
 *   502  notification API unreachable or answered non-2xx
 *   504  notification API timed out
 *
 * Retry strategy: this service does not retry by itself. On 502/504 Stripe
 * redelivers the event with exponential backoff (for up to three days in live
 * mode), which is both simpler and more durable than an in-process retry
 * loop, and keeps every response well inside Stripe's delivery timeout.
 */
export function createStripeWebhookHandler({
  config,
  logger = defaultLogger,
  processedEvents = new ProcessedEventStore(),
}) {
  const stripe = new Stripe(config.stripeSecretKey);

  return async function handleStripeWebhook(req, res) {
    // --- 1. Signature verification -------------------------------------
    const signature = req.get('Stripe-Signature');
    if (!signature) {
      logger.warn('webhook_rejected', { stage: 'signature_verification', error_category: 'missing_signature', http_status: 400 });
      return res.status(400).json({ error: 'Missing Stripe-Signature header' });
    }

    let event;
    try {
      // req.body is a Buffer holding the exact bytes Stripe sent (express.raw
      // in app.js). Parsing and re-serializing the JSON would change those
      // bytes and make every signature check fail.
      event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
    } catch (err) {
      // First line of Stripe's message: says what failed, contains no secrets.
      logger.warn('webhook_rejected', {
        stage: 'signature_verification',
        error_category: 'invalid_signature',
        http_status: 400,
        message: err.message.split('\n')[0].trim(),
      });
      return res.status(400).json({ error: 'Invalid Stripe signature' });
    }

    const context = { event_id: event.id, event_type: event.type };

    // --- 2. Event filtering --------------------------------------------
    if (event.type !== HANDLED_EVENT_TYPE) {
      logger.info('webhook_ignored', { ...context, reason: 'unhandled_event_type', http_status: 200 });
      return res.status(200).json({ received: true, status: 'ignored' });
    }

    // --- 3. Idempotency --------------------------------------------------
    if (processedEvents.has(event.id)) {
      logger.info('webhook_duplicate', { ...context, http_status: 200 });
      return res.status(200).json({ received: true, status: 'duplicate' });
    }

    // --- 4. Only successful payments are announced ---------------------
    const session = event.data.object;
    if (!isPaymentSuccessful(session)) {
      logger.info('webhook_ignored', {
        ...context,
        transaction_id: session.id,
        reason: 'payment_not_successful',
        payment_status: session.payment_status,
        http_status: 200,
      });
      return res.status(200).json({ received: true, status: 'ignored' });
    }

    // --- 5. Map and forward ----------------------------------------------
    let payload;
    try {
      payload = mapCheckoutSession(session);
    } catch (err) {
      if (!(err instanceof InvalidSessionError)) throw err;
      logger.error('webhook_failed', {
        ...context,
        stage: 'field_mapping',
        error_category: 'invalid_payload',
        http_status: 422,
        missing_fields: err.missingFields,
      });
      return res.status(422).json({ error: 'Checkout Session is missing required fields', fields: err.missingFields });
    }

    try {
      const result = await forwardNotification(payload, {
        url: config.notificationUrl,
        token: config.notificationToken,
        timeoutMs: config.notificationTimeoutMs,
        idempotencyKey: event.id,
      });

      // Marked as processed only after the internal API accepted it, so a
      // failed attempt is still forwarded when Stripe retries.
      processedEvents.add(event.id);
      logger.info('notification_forwarded', {
        ...context,
        transaction_id: payload.transaction_id,
        customer_email: maskEmail(payload.customer_email),
        amount: payload.amount,
        currency: payload.currency,
        status: payload.status,
        downstream_status: result.status,
        http_status: 200,
      });
      return res.status(200).json({ received: true, status: 'forwarded' });
    } catch (err) {
      if (!(err instanceof NotificationError)) throw err;
      const httpStatus = err.category === 'timeout' ? 504 : 502;
      logger.error('notification_failed', {
        ...context,
        transaction_id: payload.transaction_id,
        stage: 'notification_forward',
        error_category: err.category,
        downstream_status: err.status,
        http_status: httpStatus,
        retry: 'stripe_redelivery',
        message: err.message,
      });
      return res.status(httpStatus).json({ error: 'Notification delivery failed', category: err.category });
    }
  };
}
