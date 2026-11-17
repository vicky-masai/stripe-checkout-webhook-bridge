/**
 * Remembers which Stripe events were already forwarded.
 *
 * Stripe delivers webhooks "at least once", so the same event id can arrive
 * more than once (for example when our 2xx answer got lost on the way back).
 * This store lets the handler acknowledge such repeats without notifying the
 * internal service twice.
 *
 * It lives in memory: simple and enough for a single instance, but it is
 * emptied on restart and not shared between instances. For that reason the
 * event id is also sent downstream as an Idempotency-Key header. Swap this
 * class for a Redis or database backed one when running several instances.
 */
export class ProcessedEventStore {
  constructor({ ttlMs = 24 * 60 * 60 * 1000, maxEntries = 10_000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map(); // event id -> expiry time (ms)
  }

  has(eventId) {
    const expiresAt = this.entries.get(eventId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.entries.delete(eventId);
      return false;
    }
    return true;
  }

  add(eventId) {
    // Map keeps insertion order, so the first key is the oldest one.
    if (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(eventId, Date.now() + this.ttlMs);
  }
}
