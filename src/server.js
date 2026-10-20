import { readConfig } from './config.js';
import { createLogger } from './adapters/logger.js';
import { connectDatabase } from './adapters/mongo/database.js';
import { createContainer } from './container.js';
import { createApp } from './http/app.js';
const config = readConfig();
const logger = createLogger(config.logLevel);
let client;
let server;
try {
  const connection = await connectDatabase(config);
  client = connection.client;
  const services = await createContainer({ ...connection, config, logger });
  const app = createApp({ services, config, logger, db: connection.db });
  server = app.listen(config.port, '0.0.0.0', () =>
    logger.info({ port: config.port }, 'server.started'),
  );
  server.on('error', (error) => {
    logger.fatal({ errorType: error.name }, 'server.failed');
    process.exitCode = 1;
    client.close();
  });
} catch (error) {
  logger.fatal(
    {
      errorType: error.name,
      validation:
        error.name === 'ZodError'
          ? error.issues?.map(({ path, message }) => ({ path, message }))
          : undefined,
    },
    'startup.failed',
  );
  await client?.close();
  process.exitCode = 1;
}
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'server.stopping');
  const timer = setTimeout(() => process.exit(1), 10000);
  timer.unref();
  if (server) await new Promise((resolve) => server.close(resolve));
  await client?.close();
  clearTimeout(timer);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
