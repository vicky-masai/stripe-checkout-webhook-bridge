/**
 * Environment-based configuration.
 *
 * Every secret and every endpoint comes from environment variables (see
 * .env.example). Nothing sensitive is hard-coded, and the service refuses to
 * start when a required value is missing, so a misconfiguration is caught at
 * boot instead of on the first live payment.
 */

const DEFAULT_TIMEOUT_MS = 5000;
const REQUIRED = ['STRIPE_WEBHOOK_SECRET', 'INTERNAL_API_URL', 'INTERNAL_API_TOKEN'];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    // Only variable names are reported, never values.
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in.'
    );
  }

  let notificationUrl;
  try {
    notificationUrl = new URL(env.INTERNAL_API_URL).toString();
  } catch {
    throw new Error('INTERNAL_API_URL must be a valid absolute URL.');
  }

  const timeoutMs = Number(env.INTERNAL_API_TIMEOUT_MS);

  return {
    port: Number(env.PORT || 4242),
    // The Stripe API key is not needed to verify signatures, so it is optional
    // here. It is only passed to the SDK constructor.
    stripeSecretKey: env.STRIPE_SECRET_KEY || 'sk_test_configure_locally',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    notificationUrl,
    notificationToken: env.INTERNAL_API_TOKEN,
    notificationTimeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}
