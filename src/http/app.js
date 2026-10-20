import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { id } from '../core/validation.js';
import { AppError, ensure } from '../core/errors.js';
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
  const api = express.Router();
  app.use('/api/v1', api);
  const auth = express.Router();
  api.use('/auth', auth);
  auth.post('/register', limiter, async (req, res) =>
    res.status(201).json(await s.auth.register(req.body, req.requestId)),
  );
  auth.post('/login', limiter, async (req, res) =>
    res.json(await s.auth.login(req.body, req.requestId)),
  );
  api.use(async (req, _res, next) => {
    req.context = {
      ...(await s.auth.authenticate(req.headers.authorization)),
      requestId: req.requestId,
    };
    next();
  });
  api.get('/auth/me', async (req, res) => res.json(await s.auth.me(req.context)));
  api.post('/auth/logout', async (req, res) => res.json(await s.auth.logout(req.context)));
  api.get('/businesses', async (req, res) =>
    res.json({ data: await s.businesses.list(req.context) }),
  );
  api.post('/businesses', async (req, res) =>
    res.status(201).json(await s.businesses.create(req.context, req.body)),
  );
  const business = express.Router({ mergeParams: true });
  api.use('/businesses/:businessId', business);
  business.use((req, _res, next) => {
    id.parse(req.params.businessId);
    req.context = {
      ...req.context,
      businessId: req.params.businessId,
      key: req.headers['idempotency-key'],
    };
    ensure(
      !req.headers['x-history-at'] || ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
      409,
      'READ_ONLY_HISTORY',
      'El historial es de solo lectura',
    );
    next();
  });
  const read = (path, fn) => business.get(path, async (req, res) => res.json(await fn(req)));
  const write = (method, path, fn, { status = 200, idempotent = false } = {}) =>
    business[method](path, async (req, res) => {
      if (idempotent)
        ensure(
          req.context.key,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Incluye una Idempotency-Key única por operación',
        );
      res.status(status).json(await fn(req));
    });
  const create = { status: 201 };
  const financial = { status: 201, idempotent: true };
  write('patch', '/', (r) => s.businesses.update(r.context, r.body));
  read('/members', (r) => s.businesses.members(r.context));
  write('post', '/members', (r) => s.businesses.addMember(r.context, r.body), create);
  write('patch', '/members/:memberId', (r) =>
    s.businesses.changeMember(r.context, r.params.memberId, r.body),
  );
  write('post', '/wallets', (r) => s.finance.createWallet(r.context, r.body), financial);
  write('patch', '/wallets/:id', (r) => s.finance.updateWallet(r.context, r.params.id, r.body));
  write('post', '/movements', (r) => s.finance.record(r.context, r.body), financial);
  write('post', '/transfers', (r) => s.finance.transfer(r.context, r.body), financial);
  for (const [path, service] of [
    ['inventory-lists', s.inventoryLists],
    ['contact-lists', s.contactLists],
  ]) {
    write('post', `/${path}`, (r) => service.create(r.context, r.body), create);
    write('patch', `/${path}/:id`, (r) => service.update(r.context, r.params.id, r.body));
  }
  write('post', '/items', (r) => s.inventory.create(r.context, r.body), create);
  write('patch', '/items/:id', (r) => s.inventory.update(r.context, r.params.id, r.body));
  write(
    'post',
    '/items/:id/adjustments',
    (r) => s.inventory.adjust(r.context, r.params.id, r.body),
    financial,
  );
  write('post', '/contacts', (r) => s.contacts.create(r.context, r.body), create);
  write('patch', '/contacts/:id', (r) => s.contacts.update(r.context, r.params.id, r.body));
  write('post', '/sales', (r) => s.sales.create(r.context, r.body), financial);
  write('post', '/quotes', (r) => s.quotes.create(r.context, r.body), create);
  write('put', '/quotes/:id', (r) => s.quotes.update(r.context, r.params.id, r.body));
  write('post', '/quotes/:id/status', (r) => s.quotes.status(r.context, r.params.id, r.body));
  write(
    'post',
    '/quotes/:id/convert',
    (r) => s.quotes.convert(r.context, r.params.id, r.body),
    financial,
  );
  read('/quotes/:id/client-view', (r) => s.quotes.clientView(r.context, r.params.id));
  for (const path of ['projects', 'events']) {
    write('post', `/${path}`, (r) => s.planning.create(r.context, path, r.body), create);
    write('put', `/${path}/:id`, (r) => s.planning.update(r.context, path, r.params.id, r.body));
  }
  // Calcular también requiere pertenecer al negocio aunque no escriba datos.
  write('post', '/projections/calculate', (r) =>
    s.queries.authorize(r.context, () => s.projections.calculate(r.body)),
  );
  write('post', '/projections', (r) => s.projections.save(r.context, r.body), create);
  write('post', '/credit-lines', (r) => s.debts.createLine(r.context, r.body), create);
  read('/credit-lines/balances', (r) => s.debts.lineBalances(r.context));
  write('post', '/debts', (r) => s.debts.create(r.context, r.body), financial);
  write(
    'post',
    '/debts/:id/payments',
    (r) => s.debts.pay(r.context, r.params.id, r.body),
    financial,
  );
  write(
    'post',
    '/debts/:id/reschedule',
    (r) => s.debts.reschedule(r.context, r.params.id, r.body),
    financial,
  );
  read('/calendar', (r) => s.planning.calendar(r.context, r.query));
  read('/history', (r) => s.queries.history(r.context, r.query));
  read('/audit', (r) => s.queries.audit(r.context, r.query));
  read('/summary', (r) => s.queries.summary(r.context, r.query));
  const aliases = {
    'inventory-lists': 'inventoryLists',
    'contact-lists': 'contactLists',
    'stock-movements': 'stockMovements',
    'credit-lines': 'creditLines',
    'debt-payments': 'debtPayments',
  };
  read('/:collection', (r) =>
    s.queries.list(r.context, aliases[r.params.collection] ?? r.params.collection, r.query),
  );
  read('/:collection/:id', (r) =>
    s.queries.get(r.context, aliases[r.params.collection] ?? r.params.collection, r.params.id),
  );
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Ruta no encontrada')));
  app.use((err, req, res, _next) => {
    let status = err.status ?? 500;
    let code = err.code ?? 'INTERNAL_ERROR';
    let message = err.message;
    let details;
    if (err instanceof ZodError) {
      status = 422;
      code = 'VALIDATION_ERROR';
      message = 'Datos inválidos';
      details = err.issues.map(({ path, message }) => ({ path, message }));
    } else if (err.code === 11000) {
      status = 409;
      code = 'DUPLICATE';
      message = 'Ya existe un registro con esa clave';
    } else if (err.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'JSON inválido';
    } else if (err.type === 'entity.too.large') {
      status = 413;
      code = 'BODY_TOO_LARGE';
      message = 'Solicitud demasiado grande';
    } else if (!(err instanceof AppError)) {
      status = 500;
      code = 'INTERNAL_ERROR';
      message = 'Error interno';
      logger.error({ requestId: req.requestId, errorType: err.name }, 'request.failed');
    }
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(status).json({
      error: { code, message, ...(details ? { details } : {}), requestId: req.requestId },
    });
  });
  return app;
}
