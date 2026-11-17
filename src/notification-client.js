/**
 * Authenticated forwarding to the internal notification API.
 *
 * Sends one POST with a Bearer token and a hard timeout. Every failure is
 * turned into a NotificationError with one of three safe categories, so the
 * caller can log and respond without ever touching secrets:
 *
 *   timeout     the endpoint did not answer within the configured time
 *   network     the endpoint could not be reached (refused, DNS, reset ...)
 *   http_error  the endpoint answered with a non-2xx status
 */

export class NotificationError extends Error {
  constructor(category, message, { status = null } = {}) {
    super(message);
    this.name = 'NotificationError';
    this.category = category;
    this.status = status;
  }
}

/**
 * @param {object} payload normalized notification (see checkout-session.js)
 * @param {object} options
 * @param {string} options.url             notification endpoint
 * @param {string} options.token           Bearer token for the endpoint
 * @param {number} options.timeoutMs       upper bound for the whole request
 * @param {string} [options.idempotencyKey] Stripe event id, lets the receiver drop duplicates
 * @returns {Promise<{status: number}>} resolved only for a 2xx answer
 */
export async function forwardNotification(payload, { url, token, timeoutMs, idempotencyKey }) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      // Aborts the request (including a slow response body) after timeoutMs.
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body so the connection is released. The content is not
    // logged or returned: it belongs to the internal service.
    await response.arrayBuffer();
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new NotificationError('timeout', `Notification API did not respond within ${timeoutMs} ms`);
    }
    // fetch wraps the low-level reason (ECONNREFUSED, ENOTFOUND ...) in err.cause.
    const code = err?.cause?.code || err?.code || 'UNKNOWN';
    throw new NotificationError('network', `Notification API could not be reached (${code})`);
  }

  if (!response.ok) {
    throw new NotificationError('http_error', `Notification API responded with HTTP ${response.status}`, {
      status: response.status,
    });
  }
  return { status: response.status };
}
