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
  add('get', prefix + '/auth/me', (r) => s.auth.me(r.context));
  add('post', prefix + '/auth/logout', (r) => s.auth.logout(r.context));
  add('get', prefix + '/businesses', async (r) => ({ data: await s.businesses.list(r.context) }));
  add('post', prefix + '/businesses', (r) => s.businesses.create(r.context, r.body), {
    status: 201,
  });
  const read = (path, handler) =>
    add('get', base + (path === '/' ? '' : path), handler, { business: true });
  const write = (method, path, handler, options = {}) =>
    add(method, base + (path === '/' ? '' : path), handler, { business: true, ...options });
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
  write('patch', '/credit-lines/:id', (r) => s.debts.updateLine(r.context, r.params.id, r.body));
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
  return routes;
}
