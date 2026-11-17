/**
 * `npm run verify`
 *
 * Runs every scenario from harness.js against the real webhook app and writes
 * what actually happened to docs/Webhook_Verification_and_Error_Log.csv.
 * The report is generated from real responses and log entries. The rows in
 * docs/evidence/stripe-cli-deliveries.csv (recorded from a real Stripe CLI
 * run, see stripe-cli-listen.txt) are appended unchanged, because that run
 * needs a Stripe account and cannot be repeated by this script.
 * Exits with code 1 if any scenario misbehaves.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { scenarios, runScenario } from './harness.js';

const COLUMNS = ['timestamp', 'event_id', 'event_type', 'stage', 'error_category', 'http_status', 'retry_action', 'resolution', 'notes'];
const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;

const rows = [];
let failures = 0;

for (const scenario of scenarios) {
  const timestamp = new Date().toISOString();
  try {
    const outcome = await runScenario(scenario);
    rows.push({
      timestamp,
      event_id: outcome.event.id,
      event_type: outcome.event.type,
      stage: outcome.stage,
      error_category: outcome.category,
      http_status: outcome.result.status,
      retry_action: scenario.retry,
      resolution: scenario.resolution,
      notes: `Test: ${scenario.name}. Response: ${JSON.stringify(outcome.result.body)}. ${outcome.notes ?? ''}`.trim(),
    });
    console.log(`PASS  ${outcome.result.status}  ${outcome.category.padEnd(18)} ${scenario.name}`);
  } catch (err) {
    failures += 1;
    rows.push({ timestamp, stage: 'verification', error_category: 'test_failure', resolution: 'UNRESOLVED', notes: `Test: ${scenario.name}. ${err.message}` });
    console.log(`FAIL  ${scenario.name}\n      ${err.message}`);
  }
}

const stripeCliRows = await readFile(new URL('../docs/evidence/stripe-cli-deliveries.csv', import.meta.url), 'utf8').catch(() => '');
const csv =
  [COLUMNS.join(','), ...rows.map((row) => COLUMNS.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n' + stripeCliRows;
const target = new URL('../docs/Webhook_Verification_and_Error_Log.csv', import.meta.url);
await writeFile(target, csv);

console.log(`\n${scenarios.length - failures}/${scenarios.length} scenarios passed. Report written to docs/Webhook_Verification_and_Error_Log.csv`);
process.exit(failures === 0 ? 0 : 1);
