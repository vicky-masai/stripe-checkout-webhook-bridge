/**
 * Field mapping: Stripe Checkout Session -> internal notification payload.
 *
 *   Checkout Session field            Notification field
 *   --------------------------------  ------------------
 *   session.id                        transaction_id
 *   session.customer_details.email    customer_email   (null when Stripe has none)
 *   session.amount_total              amount           (integer, minor units e.g. cents)
 *   session.currency                  currency         (lowercase ISO 4217)
 *   session.payment_status            status
 *
 * The target shape is defined in fixtures/notification-contract.json.
 */

export class InvalidSessionError extends Error {
  constructor(missingFields) {
    super(`Checkout Session is missing required fields: ${missingFields.join(', ')}`);
    this.name = 'InvalidSessionError';
    this.missingFields = missingFields;
  }
}

export function mapCheckoutSession(session) {
  const missing = [];
  if (typeof session?.id !== 'string' || session.id === '') missing.push('id');
  if (!Number.isInteger(session?.amount_total)) missing.push('amount_total');
  if (typeof session?.currency !== 'string' || session.currency === '') missing.push('currency');
  if (typeof session?.payment_status !== 'string') missing.push('payment_status');
  if (missing.length > 0) throw new InvalidSessionError(missing);

  return {
    transaction_id: session.id,
    customer_email: session.customer_details?.email ?? null,
    amount: session.amount_total,
    currency: session.currency.toLowerCase(),
    status: session.payment_status,
  };
}

/**
 * checkout.session.completed also fires for delayed payment methods (bank
 * debits, vouchers) while the money is still pending: payment_status is then
 * "unpaid". Only these two values mean the order is really paid for.
 */
export function isPaymentSuccessful(session) {
  return session?.payment_status === 'paid' || session?.payment_status === 'no_payment_required';
}
