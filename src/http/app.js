import { createRoutes } from './routes.js';
import { authorizeRoute, errorResponse } from './protocol.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.js';
export function createApp({ services: s, config, logger, db }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(helmet());
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    const started = performance.now();
    res.on('finish', () =>
      logger.info(
        {
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        },
        'http.request',
      ),
    );
    next();
  });
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
      credentials: false,
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(express.json({ limit: '256kb', strict: true }));
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => config.nodeEnv === 'test',
    message: { error: { code: 'RATE_LIMIT', message: 'Demasiados intentos; espera unos minutos' } },
  });
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    await db.command({ ping: 1 });
    res.json({ status: 'ok' });
  });
  for (const route of createRoutes(s)) {
    const handlers = route.limited ? [limiter] : [];
    app[route.method](route.path, ...handlers, async (req, res) => {
      req.context = await authorizeRoute(route, req, s);
      res.status(route.status).json(await route.handler(req));
    });
  }
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Ruta no encontrada')));
  app.use((err, req, res, _next) => {
    const { status, body } = errorResponse(err, req.requestId, logger);
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(status).json(body);
  });
  return app;
}
