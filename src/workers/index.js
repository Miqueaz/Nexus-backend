import { DurableObject } from 'cloudflare:workers';
import { readConfig } from '../config.js';
import { createWorkerLogger } from '../adapters/workers/logger.js';
import { connectDatabase } from '../adapters/mongo/database.js';
import { createContainer } from '../container.js';
import { createFetchApp } from '../http/fetch-app.js';
import { createAuthLimiter } from './rate-limit.js';
import { AppError } from '../core/errors.js';

/** El runtime vive en el DO; MongoClient nunca se comparte entre contextos Worker. */
export class BusinessApi extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.runtimePromise = null;
    this.app = null;
  }
  async runtime(config, logger) {
    if (!this.runtimePromise) {
      this.runtimePromise = (async () => {
        const connection = await connectDatabase(config, {
          initializeIndexes: false,
          poolSize: 1,
          monitoringMode: 'poll',
        });
        try {
          const services = await createContainer({ ...connection, config, logger });
          return { ...connection, services };
        } catch (error) {
          await connection.client.close();
          throw error;
        }
      })();
    }
    try {
      return await this.runtimePromise;
    } catch (error) {
      this.runtimePromise = null;
      logger.error({ errorType: error.name }, 'worker.database.unavailable');
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'Base de datos no disponible');
    }
  }
  async fetch(request) {
    if (!this.app) {
      let config;
      try {
        config = readConfig(this.env);
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
      this.app = createFetchApp({
        config,
        logger,
        getRuntime: () => this.runtime(config, logger),
        consumeAuthLimit: createAuthLimiter(this.ctx.storage),
      });
    }
    return this.app.fetch(request);
  }
}

export function shardName(pathname) {
  const match =
    /^\/api\/v1\/businesses\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:\/|$)/i.exec(pathname);
  if (!match) return 'identity-v1';
  // Cantidad fija de DO: URLs inventadas no crean infinitas conexiones.
  return `business-v1-${parseInt(match[1][0], 16)}`;
}

export default {
  async fetch(request, env) {
    const name = shardName(new URL(request.url).pathname);
    return env.BUSINESS_API.get(env.BUSINESS_API.idFromName(name)).fetch(request);
  },
};
