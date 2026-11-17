/**
 * Structured audit logging.
 *
 * Each log entry is one JSON object per line, which keeps the output easy to
 * read in a terminal and easy to ship to a log aggregator later.
 *
 * Rules followed everywhere in this service:
 *   - never log secrets (webhook secret, API token, Stripe-Signature header)
 *   - never log raw request bodies
 *   - customer email addresses are masked with maskEmail() before logging
 */

function write(level, event, fields) {
  const entry = { timestamp: new Date().toISOString(), level, event, ...fields };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  info: (event, fields = {}) => write('info', event, fields),
  warn: (event, fields = {}) => write('warn', event, fields),
  error: (event, fields = {}) => write('error', event, fields),
};

/** "alex.rivera@example.test" -> "a***@example.test" */
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
