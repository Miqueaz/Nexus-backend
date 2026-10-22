import { readConfig } from '../config.js';
import { createWorkerLogger } from '../adapters/workers/logger.js';
import { connectDatabase } from '../adapters/mongo/database.js';
import { createContainer } from '../container.js';
import { createFetchApp } from '../http/fetch-app.js';
import { createMongoAuthLimiter } from '../adapters/mongo/auth-rate-limit.js';
import { AppError } from '../core/errors.js';

/** Cada invocación posee su cliente; ningún socket se comparte entre contextos Workers. */
export async function directFetch(request, env) {
  let config;
  try {
    config = readConfig(env);
  } catch {
    return Response.json(
      {
        error: {
          code: 'CONFIGURATION_ERROR',
          message: 'Configura las variables y secretos del Worker',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const logger = createWorkerLogger(config.logLevel);
  let connection;
  let runtimePromise;
  const getRuntime = () => {
    if (!runtimePromise)
      runtimePromise = (async () => {
        try {
          connection = await connectDatabase(config, {
            initializeIndexes: false,
            migrateIfNeeded: config.mongoAutoMigrate,
            poolSize: 1,
            monitoringMode: 'poll',
            appName: 'nexo-workers',
          });
          const services = await createContainer({ ...connection, config, logger });
          return { ...connection, services };
        } catch (error) {
          logger.error({ errorType: error.name }, 'worker.database.unavailable');
          if (error instanceof AppError) throw error;
          throw new AppError(503, 'DATABASE_UNAVAILABLE', 'Base de datos no disponible');
        }
      })();
    return runtimePromise;
  };
  const app = createFetchApp({
    config,
    logger,
    getRuntime,
    consumeAuthLimit: async (request) => {
      const { db } = await getRuntime();
      return createMongoAuthLimiter(db)(request);
    },
  });
  try {
    return await app.fetch(request);
  } finally {
    if (connection) {
      try {
        await connection.client.close();
      } catch (error) {
        logger.error({ errorType: error.name }, 'worker.database.close_failed');
      }
    }
  }
}
