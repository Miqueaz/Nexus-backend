import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.js';
import { createRoutes } from './routes.js';
import { authorizeRoute, errorResponse } from './protocol.js';
const unavailable = () => new AppError(503, 'DATABASE_UNAVAILABLE', 'Base de datos no disponible');
/** Adaptador de Request/Response. getRuntime se resuelve dentro del contexto de la solicitud. */
export function createFetchApp({ getRuntime, config, logger, consumeAuthLimit }) {
  const app = new Hono({ strict: false });
  app.use('*', secureHeaders());
  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    c.header('Cache-Control', 'no-store');
    const start = performance.now();
    await next();
    logger.info(
      {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - start),
      },
      'http.request',
    );
  });
  app.use(
    '*',
    cors({
      origin: (origin) => (config.corsOrigins.includes(origin) ? origin : undefined),
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-History-At'],
      exposeHeaders: ['X-Request-Id'],
      credentials: false,
    }),
  );
  app.use(
    '*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: () => {
        throw new AppError(413, 'BODY_TOO_LARGE', 'Solicitud demasiado grande');
      },
    }),
  );
  app.get('/health/live', (c) => c.json({ status: 'ok' }));
  app.get('/health/ready', async (c) => {
    const { db } = await getRuntime();
    try {
      await db.command({ ping: 1 });
    } catch {
      throw unavailable();
    }
    return c.json({ status: 'ok' });
  });
  // Proxy de servicios: las rutas se describen sin inicializar conexiones ni criptografía al importar.
  const services = new Proxy(
    {},
    {
      get: (_target, module) =>
        new Proxy(
          {},
          {
            get:
              (_inner, method) =>
              async (...args) => {
                const runtime = await getRuntime();
                return runtime.services[module][method](...args);
              },
          },
        ),
    },
  );
  for (const route of createRoutes(services)) {
    app.on(route.method.toUpperCase(), route.path, async (c) => {
      if (route.limited) {
        const result = await consumeAuthLimit(c.req.raw);
        c.header('RateLimit-Limit', '15');
        c.header('RateLimit-Remaining', String(Math.max(0, 15 - result.count)));
        if (result.count > 15) {
          c.header('Retry-After', String(result.retryAfter));
          throw new AppError(429, 'RATE_LIMIT', 'Demasiados intentos; espera unos minutos');
        }
      }
      const requestId = c.get('requestId');
      let body;
      if (
        !['GET', 'HEAD'].includes(c.req.method) &&
        /^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '')
      ) {
        try {
          const source = await c.req.text();
          if (source.length) {
            body = JSON.parse(source);
            if (!body || typeof body !== 'object') throw new Error('scalar');
          }
        } catch {
          throw new AppError(400, 'INVALID_JSON', 'JSON inválido');
        }
      }
      const query = {};
      for (const [key, value] of new URL(c.req.url).searchParams) {
        query[key] = key in query ? [...[query[key]].flat(), value] : value;
      }
      const req = {
        requestId,
        method: c.req.method,
        headers: Object.fromEntries(c.req.raw.headers),
        params: c.req.param(),
        query,
        body,
      };
      req.context = await authorizeRoute(route, req, services);
      return c.json(await route.handler(req), route.status);
    });
  }
  app.notFound(() => {
    throw new AppError(404, 'NOT_FOUND', 'Ruta no encontrada');
  });
  app.onError((error, c) => {
    const { status, body } = errorResponse(error, c.get('requestId'), logger);
    if (status === 401) c.header('WWW-Authenticate', 'Bearer');
    return c.json(body, status);
  });
  return app;
}
