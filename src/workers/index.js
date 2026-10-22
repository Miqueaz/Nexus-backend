import { DurableObject } from 'cloudflare:workers';
import { readConfig } from '../config.js';
import { createWorkerLogger } from '../adapters/workers/logger.js';
import { connectDatabase } from '../adapters/mongo/database.js';
import { createContainer } from '../container.js';
import { createFetchApp } from '../http/fetch-app.js';
import { createAuthLimiter } from './rate-limit.js';
import { AppError } from '../core/errors.js';
import { RequestRuntime } from './request-runtime.js';
import { directFetch } from './direct.js';

/** Compatibilidad con el despliegue anterior. El modo direct no invoca esta clase. */
export class BusinessApi extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.runtimeScope = null;
    this.app = null;
  }
  async runtime(config, logger) {
    try {
      const connection = await connectDatabase(config, {
        initializeIndexes: false,
        migrateIfNeeded: config.mongoAutoMigrate,
        poolSize: 1,
        monitoringMode: 'poll',
        appName: 'nexo-workers',
      });
      try {
        const services = await createContainer({ ...connection, config, logger });
        return { ...connection, services };
      } catch (error) {
        await connection.client.close();
        throw error;
      }
    } catch (error) {
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
      this.runtimeScope = new RequestRuntime({
        open: () => this.runtime(config, logger),
        close: ({ client }) => client.close(),
        onCloseError: (error) =>
          logger.error({ errorType: error.name }, 'worker.database.close_failed'),
      });
      this.app = createFetchApp({
        config,
        logger,
        getRuntime: () => this.runtimeScope.get(),
        consumeAuthLimit: createAuthLimiter(this.ctx.storage),
      });
    }
    return this.runtimeScope.run(() => this.app.fetch(request));
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
    if (env.API_RUNTIME !== 'durable-object') return directFetch(request, env);
    const name = shardName(new URL(request.url).pathname);
    return env.BUSINESS_API.get(env.BUSINESS_API.idFromName(name)).fetch(request);
  },
};
