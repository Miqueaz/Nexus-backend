import { moduleCatalog } from '../modules/businesses/settings.js';
/** Catálogo HTTP compartido: servicios de negocio independientes del servidor. */
export function createRoutes(s) {
  const routes = [];
  const add = (method, path, handler, options = {}) =>
    routes.push({ method, path, handler, status: 200, ...options });
  const prefix = '/api/v1';
  const base = prefix + '/businesses/:businessId';
  add('post', prefix + '/auth/register', (r) => s.auth.register(r.body, r.requestId), {
    public: true,
    limited: true,
    status: 201,
  });
  add('post', prefix + '/auth/login', (r) => s.auth.login(r.body, r.requestId), {
    public: true,
    limited: true,
  });
  add('post', prefix + '/auth/google/challenge', () => s.auth.googleChallenge(), {
    public: true,
    limited: true,
  });
  add('post', prefix + '/auth/google', (r) => s.auth.googleLogin(r.body, r.requestId), {
    public: true,
    limited: true,
  });
  add(
    'post',
    prefix + '/auth/google/link/challenge',
    (r) => s.auth.googleLinkChallenge(r.context, r.body),
    { limited: true },
  );
  add('post', prefix + '/auth/google/link', (r) => s.auth.googleLink(r.context, r.body), {
    limited: true,
  });
  add('get', prefix + '/auth/options', () => s.platform.options(), { public: true });
  add('get', prefix + '/administration/settings', (r) => s.platform.get(r.context));
  add('patch', prefix + '/administration/settings', (r) => s.platform.update(r.context, r.body), {
    idempotent: true,
  });
  add('get', prefix + '/administration/audit', (r) => s.platform.history(r.context));
  add('get', prefix + '/auth/me', (r) => s.auth.me(r.context));
  add('post', prefix + '/auth/logout', (r) => s.auth.logout(r.context));
  add('get', prefix + '/businesses', async (r) => ({ data: await s.businesses.list(r.context) }));
  add('get', prefix + '/business-modules', () => ({ data: moduleCatalog }));
  add('post', prefix + '/businesses', (r) => s.businesses.create(r.context, r.body), {
    status: 201,
  });
  const org = prefix + '/organizations';
  add('get', org, async (r) => ({ data: await s.organizations.list(r.context) }));
  add('post', org, (r) => s.organizations.create(r.context, r.body), {
    idempotent: true,
    status: 201,
  });
  add('get', org + '/:organizationId', (r) =>
    s.organizations.get(r.context, r.params.organizationId),
  );
  add(
    'patch',
    org + '/:organizationId',
    (r) => s.organizations.update(r.context, r.params.organizationId, r.body),
    { idempotent: true },
  );
  add(
    'post',
    org + '/:organizationId/roles',
    (r) => s.organizations.role(r.context, r.params.organizationId, null, r.body),
    { idempotent: true, status: 201 },
  );
  add(
    'patch',
    org + '/:organizationId/roles/:roleId',
    (r) => s.organizations.role(r.context, r.params.organizationId, r.params.roleId, r.body),
    { idempotent: true },
  );
  add(
    'post',
    org + '/:organizationId/members',
    (r) => s.organizations.addMember(r.context, r.params.organizationId, r.body),
    { idempotent: true, status: 201 },
  );
  add(
    'patch',
    org + '/:organizationId/members/:memberId',
    (r) => s.organizations.member(r.context, r.params.organizationId, r.params.memberId, r.body),
    { idempotent: true },
  );
  add(
    'put',
    org + '/:organizationId/spaces/:businessId',
    (r) => s.organizations.attach(r.context, r.params.organizationId, r.params.businessId, r.body),
    { idempotent: true },
  );
  add(
    'put',
    org + '/:organizationId/spaces/:businessId/grants/:memberId',
    (r) =>
      s.organizations.grant(
        r.context,
        r.params.organizationId,
        r.params.businessId,
        r.params.memberId,
        r.body,
      ),
    { idempotent: true },
  );
  const read = (path, handler) =>
    add('get', base + (path === '/' ? '' : path), handler, { business: true });
  const write = (method, path, handler, options = {}) =>
    add(method, base + (path === '/' ? '' : path), handler, { business: true, ...options });
  const create = { status: 201 };
  const financial = { status: 201, idempotent: true };
  read('/', (r) => s.businesses.get(r.context));
  write('patch', '/', (r) => s.businesses.update(r.context, r.body));
  write('put', '/preferences', (r) => s.businesses.savePreferences(r.context, r.body));
  read('/docs', (r) => s.docs.list(r.context, r.query));
  read('/docs/library', (r) => s.docs.library(r.context, r.query));
  write('post', '/docs/containers', (r) => s.docs.createContainer(r.context, r.body), financial);
  write('post', '/docs/files', (r) => s.docs.upload(r.context, r.body), financial);
  read('/docs/:id/content', (r) => s.docs.content(r.context, r.params.id));
  write('patch', '/docs/:id/location', (r) => s.docs.relocate(r.context, r.params.id, r.body), {
    idempotent: true,
  });
  write('patch', '/docs/:id/save', (r) => s.docs.savePatch(r.context, r.params.id, r.body), {
    idempotent: true,
  });
  read('/docs/:id', (r) => s.docs.get(r.context, r.params.id));
  write('post', '/docs', (r) => s.docs.create(r.context, r.body), financial);
  write('put', '/docs/:id', (r) => s.docs.update(r.context, r.params.id, r.body), {
    idempotent: true,
  });
  write('patch', '/docs/:id', (r) => s.docs.archive(r.context, r.params.id, r.body), {
    idempotent: true,
  });
  read('/contacts/linkable-users', (r) => s.contacts.users(r.context));
  read('/members', (r) => s.businesses.members(r.context));
  write('post', '/members', (r) => s.businesses.addMember(r.context, r.body), create);
  write('patch', '/members/:memberId', (r) =>
    s.businesses.changeMember(r.context, r.params.memberId, r.body),
  );
  write('post', '/wallets', (r) => s.finance.createWallet(r.context, r.body), financial);
  write('patch', '/wallets/:id', (r) => s.finance.updateWallet(r.context, r.params.id, r.body));
  write('post', '/movements', (r) => s.finance.record(r.context, r.body), financial);
  read('/debts/:id/changes', (r) => s.debtCorrections.history(r.context, r.params.id));
  write(
    'post',
    '/debts/:id/corrections',
    (r) => s.debtCorrections.correct(r.context, r.params.id, r.body),
    financial,
  );
  write(
    'post',
    '/debts/:id/cancellations',
    (r) => s.debtCorrections.correct(r.context, r.params.id, r.body, true),
    financial,
  );
  read('/movements/:id/changes', (r) => s.movementCorrections.history(r.context, r.params.id));
  write(
    'post',
    '/movements/:id/corrections',
    (r) => s.movementCorrections.correct(r.context, r.params.id, r.body),
    financial,
  );
  write(
    'post',
    '/movements/:id/cancellations',
    (r) => s.movementCorrections.correct(r.context, r.params.id, r.body, true),
    financial,
  );
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
  write('post', '/services', (r) => s.serviceCatalog.create(r.context, r.body), create);
  write('patch', '/services/:id', (r) => s.serviceCatalog.update(r.context, r.params.id, r.body));
  write('post', '/sales', (r) => s.sales.create(r.context, r.body), financial);
  write(
    'patch',
    '/sales/:id/commissions',
    (r) => s.sales.setCommissions(r.context, r.params.id, r.body),
    { idempotent: true },
  );
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
    s.queries.authorize(r.context, () => s.projections.calculate(r.body), {
      module: 'projections',
    }),
  );
  write('post', '/projections', (r) => s.projections.save(r.context, r.body), create);
  write('post', '/credit-lines', (r) => s.debts.createLine(r.context, r.body), create);
  write('patch', '/credit-lines/:id', (r) => s.debts.updateLine(r.context, r.params.id, r.body));
  write('patch', '/credit-lines/:id/minimum-rule', (r) =>
    s.creditStatements.rule(r.context, r.params.id, r.body),
  );
  write('post', '/credit-lines/:id/statements/preview', (r) =>
    s.creditStatements.preview(r.context, r.params.id, r.body),
  );
  write(
    'post',
    '/credit-lines/:id/statements',
    (r) => s.creditStatements.close(r.context, r.params.id, r.body),
    financial,
  );
  write('patch', '/credit-statements/:id/official', (r) =>
    s.creditStatements.official(r.context, r.params.id, r.body),
  );
  read('/credit-lines/balances', (r) => s.debts.lineBalances(r.context));
  write(
    'post',
    '/credit-lines/:id/payments',
    (r) => s.debts.payLine(r.context, r.params.id, r.body),
    financial,
  );
  write('patch', '/debts/:id/billing-kind', (r) =>
    s.creditStatements.classify(r.context, r.params.id, r.body),
  );
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
  read('/snapshot', (r) => s.queries.snapshot(r.context, r.query));
  read('/summary', (r) => s.queries.summary(r.context, r.query));
  const aliases = {
    'inventory-lists': 'inventoryLists',
    'contact-lists': 'contactLists',
    'stock-movements': 'stockMovements',
    'credit-lines': 'creditLines',
    'credit-statements': 'creditStatements',
    'debt-payments': 'debtPayments',
  };
  read('/:collection', (r) =>
    s.queries.list(r.context, aliases[r.params.collection] ?? r.params.collection, r.query),
  );
  read('/:collection/:id', (r) =>
    s.queries.get(r.context, aliases[r.params.collection] ?? r.params.collection, r.params.id),
  );
  return routes;
}
