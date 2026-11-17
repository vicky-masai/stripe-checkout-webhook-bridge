import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { startMockNotificationApi } from './mock-notification-api.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  logger.error('startup_failed', { message: err.message });
  process.exit(1);
}

const app = createApp({ config, logger });
const server = app.listen(config.port, () =>
  console.log(`Webhook service listening on http://localhost:${config.port}`)
);

// The local receiver stands in for the internal messaging service during
// development. Set START_MOCK_NOTIFICATION_API=false when INTERNAL_API_URL
// points at a real, authorised endpoint.
const mockApi =
  process.env.START_MOCK_NOTIFICATION_API === 'false'
    ? null
    : startMockNotificationApi(Number(process.env.MOCK_API_PORT || 5050));

function shutdown() {
  server.close(() => {
    if (mockApi) mockApi.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
