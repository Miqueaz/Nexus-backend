import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { ensureIndexes } from '../src/adapters/mongo/database.js';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/adapters/logger.js';
let rs, client, db, app, dataDir;
const config = {
  nodeEnv: 'test',
  jwtSecret: 'test-secret-'.repeat(8),
  jwtIssuer: 'nexo-test',
  jwtAudience: 'nexo-test-app',
  tokenMinutes: 30,
  corsOrigins: ['http://localhost:5173'],
  trustProxyHops: 0,
};
before(
  async () => {
    if (!process.env.TEST_MONGO_URI) {
      dataDir = await mkdtemp(join(process.env.TEST_TMP_ROOT ?? tmpdir(), 'nexo-test-'));
      rs = await MongoMemoryReplSet.create({
        replSet: { count: 1 },
        instanceOpts: [
          { dbPath: dataDir, args: ['--nounixsocket', '--wiredTigerCacheSizeGB', '0.25'] },
        ],
        binary: { version: process.env.MONGOMS_VERSION ?? '8.0.16' },
      });
    }
    client = new MongoClient(process.env.TEST_MONGO_URI ?? rs.getUri());
    await client.connect();
    db = client.db(`nexo_test_${randomUUID().replaceAll('-', '')}`);
    await ensureIndexes(db);
    const logger = createLogger('silent');
    const services = await createContainer({ client, db, config, logger });
    app = createApp({ services, db, config, logger });
  },
  { timeout: 180000 },
);
after(async () => {
  if (db) await db.dropDatabase();
  await client?.close();
  await rs?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});
async function user() {
  const email = `${randomUUID()}@example.com`;
  const r = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, name: 'Prueba', password: 'UnaClaveLarga123!' })
    .expect(201);
  return { email, token: r.body.accessToken, id: r.body.user._id };
}
async function fixture() {
  const u = await user();
  const r = await request(app)
    .post('/api/v1/businesses')
    .auth(u.token, { type: 'bearer' })
    .send({ name: 'Negocio', currency: 'MXN' })
    .expect(201);
  return { ...u, business: r.body, base: `/api/v1/businesses/${r.body._id}` };
}
function call(f, method, path, body, key = randomUUID()) {
  let r = request(app)
    [method](f.base + path)
    .auth(f.token, { type: 'bearer' });
  if (body) r = r.send(body);
  return r.set('Idempotency-Key', key);
}
async function wallet(f, openingBalanceMinor = 100000) {
  return (await call(f, 'post', '/wallets', { name: 'Caja', openingBalanceMinor }).expect(201))
    .body;
}
async function item(f, stock = 10000) {
  const list = (
    await call(f, 'post', '/inventory-lists', {
      name: 'Recursos',
      fields: [{ key: 'color', label: 'Color', type: 'text' }],
    }).expect(201)
  ).body;
  const item = (
    await call(f, 'post', '/items', {
      name: 'Artículo',
      listIds: [list._id],
      values: { color: 'azul' },
      priceMinor: 1000,
      costMinor: 400,
    }).expect(201)
  ).body;
  return (
    await call(f, 'post', `/items/${item._id}/adjustments`, {
      deltaMilli: stock,
      reason: 'Entrada inicial',
      revision: 1,
    }).expect(201)
  ).body.item;
}
test('Bearer obligatorio, rechazo de token alterado y cierre de sesión revocable', async () => {
  await request(app).get('/api/v1/businesses').expect(401);
  const f = await fixture();
  await request(app)
    .get('/api/v1/auth/me')
    .auth(`${f.token.slice(0, -8)}xxxxxxxx`, { type: 'bearer' })
    .expect(401);
  await request(app).post('/api/v1/auth/logout').auth(f.token, { type: 'bearer' }).expect(200);
  await request(app).get('/api/v1/auth/me').auth(f.token, { type: 'bearer' }).expect(401);
});
test('Aislamiento por negocio, roles y revocación de miembros', async () => {
  const a = await fixture(),
    b = await user();
  const w = await wallet(a);
  await call({ ...a, token: b.token }, 'get', `/wallets/${w._id}`).expect(404);
  const member = (await call(a, 'post', '/members', { email: b.email, role: 'viewer' }).expect(201))
    .body;
  await call({ ...a, token: b.token }, 'get', `/wallets/${w._id}`).expect(200);
  await call({ ...a, token: b.token }, 'post', '/movements', {
    walletId: w._id,
    kind: 'expense',
    amountMinor: 1,
    category: 'x',
  }).expect(403);
  await call(a, 'patch', `/members/${member._id}`, { revision: 1, role: 'removed' }).expect(200);
  await call({ ...a, token: b.token }, 'get', '/wallets').expect(404);
});
test('Venta atómica, descuento, auditoría e idempotencia', async () => {
  const f = await fixture(),
    w = await wallet(f),
    i = await item(f);
  const key = randomUUID();
  const payload = {
    walletId: w._id,
    lines: [{ itemId: i._id, quantityMilli: 1500 }],
    discount: { type: 'percent', value: 1000, reason: 'Promoción' },
    description: 'Venta de prueba',
  };
  const sale = (await call(f, 'post', '/sales', payload, key).expect(201)).body;
  assert.equal(sale.totalMinor, 1350);
  assert.equal(sale.profitMinor, 750);
  const repeat = (await call(f, 'post', '/sales', payload, key).expect(201)).body;
  assert.equal(repeat._id, sale._id);
  await call(f, 'post', '/sales', { ...payload, description: 'Otro' }, key).expect(409);
  assert.equal((await call(f, 'get', `/wallets/${w._id}`).expect(200)).body.balanceMinor, 101350);
  assert.equal((await call(f, 'get', `/items/${i._id}`).expect(200)).body.stockMilli, 8500);
  const logs = (await call(f, 'get', '/audit').expect(200)).body.data.filter(
    (a) => a.action === 'sale.created',
  );
  assert.equal(logs.length, 5);
  assert.ok(logs.every((a) => a.actorId === f.id && a.requestId));
});
test('Un error en la cartera revierte venta, existencias y auditoría', async () => {
  const f = await fixture(),
    i = await item(f);
  const count = await db.collection('audit').countDocuments({ businessId: f.business._id });
  await call(f, 'post', '/sales', {
    walletId: randomUUID(),
    lines: [{ itemId: i._id, quantityMilli: 1000 }],
  }).expect(404);
  assert.equal(await db.collection('sales').countDocuments({ businessId: f.business._id }), 0);
  assert.equal(await db.collection('audit').countDocuments({ businessId: f.business._id }), count);
  assert.equal((await call(f, 'get', `/items/${i._id}`).expect(200)).body.stockMilli, 10000);
});
test('Ventas simultáneas no permiten sobreventa', async () => {
  const f = await fixture(),
    w = await wallet(f),
    i = await item(f, 1000);
  const payload = { walletId: w._id, lines: [{ itemId: i._id, quantityMilli: 1000 }] };
  const responses = await Promise.all([
    call(f, 'post', '/sales', payload),
    call(f, 'post', '/sales', payload),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 422]);
  assert.equal(await db.collection('sales').countDocuments({ businessId: f.business._id }), 1);
});
test('Listas dinámicas validan valores, revisión y esquema utilizado', async () => {
  const f = await fixture();
  const l = (
    await call(f, 'post', '/contact-lists', {
      name: 'Proveedores',
      fields: [{ key: 'rfc', label: 'RFC', type: 'text', required: true }],
    }).expect(201)
  ).body;
  await call(f, 'post', '/contacts', { name: 'Persona', listIds: [l._id], values: {} }).expect(422);
  const c = (
    await call(f, 'post', '/contacts', {
      name: 'Persona',
      listIds: [l._id],
      values: { rfc: 'ABC' },
    }).expect(201)
  ).body;
  await call(f, 'patch', `/contacts/${c._id}`, { name: 'Nombre nuevo', revision: 1 }).expect(200);
  await call(f, 'patch', `/contacts/${c._id}`, { name: 'Versión vieja', revision: 1 }).expect(409);
  await call(f, 'patch', `/contact-lists/${l._id}`, { fields: [], revision: 1 }).expect(409);
});
test('Historial muestra snapshots anteriores sin alterar el presente', async () => {
  const f = await fixture(),
    w = await wallet(f);
  const at = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await call(f, 'post', '/movements', {
    walletId: w._id,
    kind: 'expense',
    amountMinor: 5000,
    category: 'Renta',
  }).expect(201);
  const history = await call(
    f,
    'get',
    `/history?collection=wallets&at=${encodeURIComponent(at)}`,
  ).expect(200);
  assert.equal(history.body.data[0].balanceMinor, 100000);
  assert.equal(history.body.readOnly, true);
  assert.equal((await call(f, 'get', `/wallets/${w._id}`).expect(200)).body.balanceMinor, 95000);
  await call(f, 'post', '/movements', {
    walletId: w._id,
    kind: 'income',
    amountMinor: 1,
    category: 'x',
  })
    .set('X-History-At', at)
    .expect(409);
});
test('Cotización aceptada se convierte una sola vez y vista cliente oculta costos', async () => {
  const f = await fixture(),
    w = await wallet(f),
    i = await item(f);
  const q = (
    await call(f, 'post', '/quotes', {
      title: 'Servicio',
      lines: [{ itemId: i._id, quantityMilli: 1000 }],
      expiresOn: '2099-12-31',
      discount: { type: 'fixed', value: 100, reason: 'Convenio' },
    }).expect(201)
  ).body;
  const view = (await call(f, 'get', `/quotes/${q._id}/client-view`).expect(200)).body;
  assert.equal(view.costMinor, undefined);
  assert.equal(view.lines[0].unitCostMinor, undefined);
  await call(f, 'post', `/quotes/${q._id}/status`, { status: 'accepted', revision: 1 }).expect(200);
  await call(f, 'post', `/quotes/${q._id}/convert`, { walletId: w._id, revision: 2 }).expect(201);
  await call(f, 'post', `/quotes/${q._id}/convert`, { walletId: w._id, revision: 2 }).expect(409);
});
test('Crédito no es ingreso operativo; pago y diferimiento preservan capital pagado', async () => {
  const f = await fixture(),
    w = await wallet(f, 0);
  const l = (
    await call(f, 'post', '/credit-lines', { name: 'Línea', limitMinor: 200000 }).expect(201)
  ).body;
  const d = (
    await call(f, 'post', '/debts', {
      name: 'Crédito',
      kind: 'credit',
      walletId: w._id,
      creditLineId: l._id,
      principalMinor: 100000,
      feeMinor: 10000,
      terms: 2,
      firstDueOn: '2028-01-31',
    }).expect(201)
  ).body;
  let summary = (await call(f, 'get', '/summary').expect(200)).body;
  assert.equal(summary.operatingNetMinor, 0);
  assert.equal(summary.wallets[0].balanceMinor, 100000);
  const paid = (
    await call(f, 'post', `/debts/${d._id}/payments`, {
      walletId: w._id,
      amountMinor: 20000,
      revision: 1,
    }).expect(201)
  ).body;
  assert.equal(paid.payment.feeMinor, 5000);
  assert.equal(paid.payment.principalMinor, 15000);
  const updated = (
    await call(f, 'post', `/debts/${d._id}/reschedule`, {
      terms: 3,
      firstDueOn: '2028-03-01',
      mode: 'balloon',
      reason: 'Capital al final',
      revision: 2,
    }).expect(201)
  ).body;
  assert.equal(updated.paidPrincipalMinor, 15000);
  assert.equal(updated.schedule.at(-1).principalMinor, 85000);
  const lines = (await call(f, 'get', '/credit-lines/balances').expect(200)).body;
  assert.equal(lines[0].availableMinor, 110000);
  summary = (await call(f, 'get', '/summary').expect(200)).body;
  assert.equal(summary.operatingNetMinor, -5000);
});
test('Cupo de crédito se protege frente a disposiciones simultáneas', async () => {
  const f = await fixture(),
    w = await wallet(f);
  const l = (
    await call(f, 'post', '/credit-lines', { name: 'Límite', limitMinor: 100000 }).expect(201)
  ).body;
  const p = {
    name: 'Crédito',
    kind: 'credit',
    walletId: w._id,
    creditLineId: l._id,
    principalMinor: 80000,
    terms: 1,
    firstDueOn: '2028-01-01',
  };
  const r = await Promise.all([call(f, 'post', '/debts', p), call(f, 'post', '/debts', p)]);
  assert.deepEqual(r.map((r) => r.status).sort(), [201, 422]);
});
test('Entradas con campos de saldo o stock y claves faltantes se rechazan', async () => {
  const f = await fixture(),
    w = await wallet(f);
  await call(f, 'patch', `/wallets/${w._id}`, {
    balanceMinor: 999999,
    revision: w.revision,
  }).expect(422);
  await request(app)
    .post(f.base + '/movements')
    .auth(f.token, { type: 'bearer' })
    .send({ walletId: w._id, kind: 'income', amountMinor: 1, category: 'x' })
    .expect(400);
  await call(f, 'get', '/wallets?limit=5000').expect(422);
});

test('Reintentos simultáneos con la misma clave devuelven una sola venta', async () => {
  const f = await fixture(),
    w = await wallet(f),
    i = await item(f);
  const key = randomUUID();
  const body = { walletId: w._id, lines: [{ itemId: i._id, quantityMilli: 1000 }] };
  const results = await Promise.all([
    call(f, 'post', '/sales', body, key),
    call(f, 'post', '/sales', body, key),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [201, 201],
  );
  assert.equal(results[0].body._id, results[1].body._id);
  assert.equal(await db.collection('sales').countDocuments({ businessId: f.business._id }), 1);
});
test('Servicios no consumen stock; recursos internos no se venden y PATCH conserva campos', async () => {
  const f = await fixture(),
    w = await wallet(f);
  const list = (await call(f, 'post', '/inventory-lists', { name: 'Servicios' }).expect(201)).body;
  const service = (
    await call(f, 'post', '/items', {
      name: 'Diseño',
      listIds: [list._id],
      priceMinor: 20000,
      costMinor: 5000,
      trackStock: false,
    }).expect(201)
  ).body;
  const edited = (
    await call(f, 'patch', `/items/${service._id}`, { name: 'Diseño web', revision: 1 }).expect(200)
  ).body;
  assert.equal(edited.trackStock, false);
  assert.equal(edited.priceMinor, 20000);
  assert.equal(edited.costMinor, 5000);
  await call(f, 'post', '/sales', {
    walletId: w._id,
    lines: [{ itemId: service._id, quantityMilli: 2000 }],
  }).expect(201);
  assert.equal((await call(f, 'get', `/items/${service._id}`).expect(200)).body.stockMilli, 0);
  const internal = (
    await call(f, 'post', '/items', {
      name: 'Computadora',
      listIds: [list._id],
      sellable: false,
    }).expect(201)
  ).body;
  await call(f, 'post', '/sales', {
    walletId: w._id,
    lines: [{ itemId: internal._id, quantityMilli: 1000 }],
  }).expect(422);
});
test('Gasto diferido genera egreso solo al pagar; saldo insuficiente revierte el pago', async () => {
  const f = await fixture(),
    w = await wallet(f, 1000);
  const debt = (
    await call(f, 'post', '/debts', {
      name: 'Compra',
      kind: 'deferred',
      principalMinor: 10000,
      terms: 2,
      firstDueOn: '2028-01-01',
    }).expect(201)
  ).body;
  assert.equal((await call(f, 'get', `/wallets/${w._id}`).expect(200)).body.balanceMinor, 1000);
  await call(f, 'post', `/debts/${debt._id}/payments`, {
    walletId: w._id,
    amountMinor: 5000,
    revision: 1,
  }).expect(422);
  assert.equal((await call(f, 'get', `/debts/${debt._id}`).expect(200)).body.paidPrincipalMinor, 0);
  assert.equal(
    await db.collection('debtPayments').countDocuments({ businessId: f.business._id }),
    0,
  );
  await call(f, 'post', `/debts/${debt._id}/payments`, {
    walletId: w._id,
    amountMinor: 1000,
    revision: 1,
  }).expect(201);
  assert.equal((await call(f, 'get', '/summary').expect(200)).body.operatingNetMinor, -1000);
});
test('Proyectos, eventos y cálculo de proyecciones validan pertenencia al negocio', async () => {
  const f = await fixture(),
    other = await user();
  const p = (
    await call(f, 'post', '/projects', { name: 'Lanzamiento', dueOn: '2028-01-20' }).expect(201)
  ).body;
  await call(f, 'put', `/projects/${p._id}`, {
    name: 'Lanzamiento',
    status: 'active',
    dueOn: '2028-01-20',
    revision: 1,
  }).expect(200);
  const e = (
    await call(f, 'post', '/events', {
      title: 'Reunión',
      date: '2028-01-10',
      endDate: '2028-01-12',
    }).expect(201)
  ).body;
  await call(f, 'put', `/events/${e._id}`, {
    title: 'Reunión',
    date: '2028-01-11',
    endDate: '2028-01-12',
    revision: 1,
  }).expect(200);
  await call(f, 'put', `/events/${e._id}`, {
    title: 'Inválido',
    date: '2028-01-15',
    endDate: '2028-01-12',
    revision: 2,
  }).expect(422);
  const calendar = (await call(f, 'get', '/calendar?from=2028-01-01&to=2028-01-31').expect(200))
    .body;
  assert.deepEqual(calendar.map((e) => e.source).sort(), ['event', 'project']);
  const assumptions = {
    name: 'Prueba',
    months: 2,
    initialInvestmentMinor: 1000,
    unitPriceMinor: 1000,
    unitCostMinor: 500,
    quantityMilli: 10000,
  };
  await call({ ...f, token: other.token }, 'post', '/projections/calculate', assumptions).expect(
    404,
  );
  const calculation = (await call(f, 'post', '/projections/calculate', assumptions).expect(200))
    .body;
  assert.equal(calculation.months.length, 2);
  await call(f, 'post', '/projections', assumptions).expect(201);
});
test('Líneas guardan estados de cuenta, edición parcial y auditoría sin mover dinero', async () => {
  const f = await fixture();
  const w = await wallet(f);
  const payload = {
    name: 'Tarjeta',
    limitMinor: 200000,
    notes: 'Estado de cuenta',
    statementCutoffOn: '2026-10-20',
    paymentDueOn: '2026-11-10',
    minimumPaymentMinor: 12500,
    interestFreePaymentMinor: 150000,
    annualInterestBps: 10590,
  };
  const line = (await call(f, 'post', '/credit-lines', payload).expect(201)).body;
  const at = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = (
    await call(f, 'patch', `/credit-lines/${line._id}`, {
      minimumPaymentMinor: 0,
      revision: line.revision,
    }).expect(200)
  ).body;
  assert.equal(updated.notes, payload.notes);
  assert.equal(updated.statementCutoffOn, payload.statementCutoffOn);
  assert.equal(updated.interestFreePaymentMinor, 150000);
  assert.equal(updated.annualInterestBps, 10590);
  assert.equal(updated.minimumPaymentMinor, 0);
  await call(f, 'patch', `/credit-lines/${line._id}`, { name: 'Conflicto', revision: 1 }).expect(
    409,
  );
  const cleared = (
    await call(f, 'patch', `/credit-lines/${line._id}`, {
      statementCutoffOn: null,
      paymentDueOn: null,
      minimumPaymentMinor: null,
      annualInterestBps: null,
      revision: updated.revision,
    }).expect(200)
  ).body;
  assert.equal(cleared.minimumPaymentMinor, null);
  assert.equal(cleared.annualInterestBps, null);
  assert.equal(cleared.interestFreePaymentMinor, 150000);
  const history = (
    await call(f, 'get', '/history?collection=creditLines&at=' + encodeURIComponent(at)).expect(200)
  ).body;
  assert.equal(history.data[0].minimumPaymentMinor, 12500);
  const balances = (await call(f, 'get', '/credit-lines/balances').expect(200)).body;
  assert.equal(balances[0].availableMinor, 200000);
  assert.equal(balances[0].usedMinor, 0);
  assert.equal((await call(f, 'get', `/wallets/${w._id}`).expect(200)).body.balanceMinor, 100000);
  assert.equal(await db.collection('movements').countDocuments({ businessId: f.business._id }), 1);
  assert.equal(await db.collection('debts').countDocuments({ businessId: f.business._id }), 0);
  assert.equal(
    await db
      .collection('audit')
      .countDocuments({ businessId: f.business._id, action: 'creditLine.updated' }),
    2,
  );
});
test('Líneas antiguas conservan datos; fechas, importes, revisión y permisos se validan', async () => {
  const f = await fixture();
  const line = (
    await call(f, 'post', '/credit-lines', {
      name: 'Proveedor',
      limitMinor: 10000,
      notes: 'Conservar',
    }).expect(201)
  ).body;
  assert.equal(line.statementCutoffOn, null);
  const updated = (
    await call(f, 'patch', `/credit-lines/${line._id}`, {
      name: 'Actualizado',
      revision: 1,
    }).expect(200)
  ).body;
  assert.equal(updated.notes, 'Conservar');
  assert.equal(updated.limitMinor, 10000);
  for (const patch of [
    { minimumPaymentMinor: -1 },
    { minimumPaymentMinor: 1.5 },
    { annualInterestBps: -1 },
    { annualInterestBps: 1.5 },
    { statementCutoffOn: '2026-02-30' },
    { limitMinor: 0 },
    { statementCutoffOn: '2026-11-10', paymentDueOn: '2026-11-01' },
  ])
    await call(f, 'patch', `/credit-lines/${line._id}`, {
      ...patch,
      revision: updated.revision,
    }).expect(422);
  const dated = (
    await call(f, 'patch', `/credit-lines/${line._id}`, {
      statementCutoffOn: '2026-11-10',
      paymentDueOn: '2026-12-01',
      revision: updated.revision,
    }).expect(200)
  ).body;
  await call(f, 'patch', `/credit-lines/${line._id}`, {
    paymentDueOn: '2026-11-01',
    revision: dated.revision,
  }).expect(422);
  const viewer = await user();
  await call(f, 'post', '/members', { email: viewer.email, role: 'viewer' }).expect(201);
  await call({ ...f, token: viewer.token }, 'patch', `/credit-lines/${line._id}`, {
    notes: 'No autorizado',
    revision: dated.revision,
  }).expect(403);
  const other = await user();
  await call({ ...f, token: other.token }, 'patch', `/credit-lines/${line._id}`, {
    notes: 'Ajeno',
    revision: dated.revision,
  }).expect(404);
});
test('Login valida credenciales y persiste seguridad sin secretos', async () => {
  const u = await user();
  await request(app)
    .post('/api/v1/auth/login')
    .send({ email: u.email, password: 'ClaveEquivocada123!' })
    .expect(401);
  await request(app)
    .post('/api/v1/auth/login')
    .send({ email: u.email, password: 'UnaClaveLarga123!' })
    .expect(200);
  const events = await db.collection('securityEvents').find({ userId: u.id }).toArray();
  assert.ok(events.length >= 3);
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('UnaClaveLarga'));
  assert.ok(!serialized.includes('accessToken'));
});

test('Cuentas solo se editan o eliminan con saldo cero, conservando movimientos e historial', async () => {
  const f = await fixture();
  const w = await wallet(f, 100);
  for (const patch of [{ name: 'Otro nombre' }, { kind: 'cash' }, { archived: true }]) {
    const result = await call(f, 'patch', `/wallets/${w._id}`, {
      ...patch,
      revision: w.revision,
    }).expect(409);
    assert.equal(result.body.error.code, 'WALLET_HAS_BALANCE');
  }
  await call(f, 'post', '/movements', {
    walletId: w._id,
    kind: 'expense',
    amountMinor: 100,
    category: 'Retiro',
  }).expect(201);
  let current = (await call(f, 'get', `/wallets/${w._id}`).expect(200)).body;
  current = (
    await call(f, 'patch', `/wallets/${w._id}`, {
      name: 'Caja cerrada',
      kind: 'cash',
      revision: current.revision,
    }).expect(200)
  ).body;
  const at = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const key = randomUUID(),
    body = { archived: true, revision: current.revision };
  const deleted = (await call(f, 'patch', `/wallets/${w._id}`, body, key).expect(200)).body;
  const repeated = (await call(f, 'patch', `/wallets/${w._id}`, body, key).expect(200)).body;
  assert.equal(deleted.archived, true);
  assert.equal(repeated.revision, deleted.revision);
  assert.equal((await call(f, 'get', '/wallets?archived=false').expect(200)).body.data.length, 0);
  const history = (
    await call(f, 'get', '/history?collection=wallets&at=' + encodeURIComponent(at)).expect(200)
  ).body;
  assert.equal(history.data[0].archived, false);
  assert.equal(history.data[0].name, 'Caja cerrada');
  assert.equal(await db.collection('movements').countDocuments({ businessId: f.business._id }), 2);
  assert.equal(
    await db
      .collection('audit')
      .countDocuments({ businessId: f.business._id, action: 'wallet.updated' }),
    2,
  );
  const income = await call(f, 'post', '/movements', {
    walletId: w._id,
    kind: 'income',
    amountMinor: 1,
    category: 'Prueba',
  }).expect(422);
  assert.equal(income.body.error.code, 'WALLET_ARCHIVED');
  const negative = (
    await call(f, 'post', '/wallets', { name: 'Negativa', allowNegative: true }).expect(201)
  ).body;
  await call(f, 'post', '/movements', {
    walletId: negative._id,
    kind: 'expense',
    amountMinor: 1,
    category: 'Gasto',
  }).expect(201);
  await call(f, 'patch', `/wallets/${negative._id}`, { archived: true, revision: 2 }).expect(409);
});

test('Cuenta vacía con crédito recibido pendiente permanece bloqueada hasta liquidar cargos y capital', async () => {
  const f = await fixture(),
    w = await wallet(f, 0),
    payer = await wallet(f, 200);
  const debt = (
    await call(f, 'post', '/debts', {
      name: 'Crédito',
      kind: 'credit',
      walletId: w._id,
      principalMinor: 100,
      feeMinor: 10,
      terms: 1,
      firstDueOn: '2027-01-01',
    }).expect(201)
  ).body;
  await call(f, 'post', '/transfers', {
    fromWalletId: w._id,
    toWalletId: payer._id,
    amountMinor: 100,
  }).expect(201);
  for (const patch of [{ name: 'Cambio' }, { archived: true }]) {
    const r = await call(f, 'patch', `/wallets/${w._id}`, { ...patch, revision: 3 }).expect(409);
    assert.equal(r.body.error.code, 'WALLET_HAS_DEBT');
  }
  await call(f, 'post', `/debts/${debt._id}/payments`, {
    walletId: payer._id,
    amountMinor: 110,
    revision: debt.revision,
  }).expect(201);
  await call(f, 'patch', `/wallets/${w._id}`, { archived: true, revision: 3 }).expect(200);
});

test('Línea bloquea edición y eliminación con deuda; al liquidar permite cambiar cupo y eliminar', async () => {
  const f = await fixture(),
    payer = await wallet(f, 1000);
  let line = (
    await call(f, 'post', '/credit-lines', { name: 'Tarjeta', limitMinor: 1000 }).expect(201)
  ).body;
  let debt = (
    await call(f, 'post', '/debts', {
      name: 'Compra',
      kind: 'deferred',
      creditLineId: line._id,
      principalMinor: 100,
      feeMinor: 10,
      terms: 1,
      firstDueOn: '2027-01-01',
    }).expect(201)
  ).body;
  for (const patch of [
    { name: 'Cambio' },
    { minimumPaymentMinor: 0 },
    { limitMinor: 2000 },
    { archived: true },
  ]) {
    const r = await call(f, 'patch', `/credit-lines/${line._id}`, { ...patch, revision: 2 }).expect(
      409,
    );
    assert.equal(r.body.error.code, 'CREDIT_LINE_HAS_DEBT');
  }
  debt = (
    await call(f, 'post', `/debts/${debt._id}/payments`, {
      walletId: payer._id,
      amountMinor: 109,
      revision: debt.revision,
    }).expect(201)
  ).body.debt;
  await call(f, 'patch', `/credit-lines/${line._id}`, { archived: true, revision: 3 }).expect(409);
  await call(f, 'post', `/debts/${debt._id}/payments`, {
    walletId: payer._id,
    amountMinor: 1,
    revision: debt.revision,
  }).expect(201);
  line = (await call(f, 'get', `/credit-lines/${line._id}`).expect(200)).body;
  line = (
    await call(f, 'patch', `/credit-lines/${line._id}`, {
      limitMinor: 2000,
      name: 'Renovada',
      revision: line.revision,
    }).expect(200)
  ).body;
  await call(f, 'patch', `/credit-lines/${line._id}`, { archived: true, revision: 1 }).expect(409);
  const at = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const viewer = await user();
  await call(f, 'post', '/members', { email: viewer.email, role: 'viewer' }).expect(201);
  await call({ ...f, token: viewer.token }, 'patch', `/credit-lines/${line._id}`, {
    archived: true,
    revision: line.revision,
  }).expect(403);
  await call(f, 'patch', `/credit-lines/${line._id}`, {
    archived: true,
    revision: line.revision,
  }).expect(200);
  const blocked = await call(f, 'post', '/debts', {
    name: 'Otra',
    kind: 'deferred',
    creditLineId: line._id,
    principalMinor: 100,
    terms: 1,
    firstDueOn: '2027-01-01',
  }).expect(422);
  assert.equal(blocked.body.error.code, 'CREDIT_LINE_ARCHIVED');
  assert.equal(await db.collection('debts').countDocuments({ businessId: f.business._id }), 1);
  assert.equal(
    await db.collection('debtPayments').countDocuments({ businessId: f.business._id }),
    2,
  );
  const history = (
    await call(f, 'get', '/history?collection=creditLines&at=' + encodeURIComponent(at)).expect(200)
  ).body;
  assert.equal(history.data[0].limitMinor, 2000);
  assert.equal(history.data[0].archived, false);
});

test('Eliminar concurrentemente con ingreso o compra no deja saldos o deudas en registros eliminados', async () => {
  const f = await fixture(),
    w = await wallet(f, 0);
  const results = await Promise.all([
    call(f, 'patch', `/wallets/${w._id}`, { archived: true, revision: 1 }),
    call(f, 'post', '/movements', {
      walletId: w._id,
      kind: 'income',
      amountMinor: 100,
      category: 'Ingreso',
    }),
  ]);
  assert.equal(results.filter((r) => r.status < 300).length, 1);
  const current = (await call(f, 'get', `/wallets/${w._id}`).expect(200)).body;
  assert.ok(current.archived ? current.balanceMinor === 0 : current.balanceMinor === 100);
  const line = (
    await call(f, 'post', '/credit-lines', { name: 'Concurrente', limitMinor: 1000 }).expect(201)
  ).body;
  const raced = await Promise.all([
    call(f, 'patch', `/credit-lines/${line._id}`, { archived: true, revision: 1 }),
    call(f, 'post', '/debts', {
      name: 'Compra',
      kind: 'deferred',
      creditLineId: line._id,
      principalMinor: 100,
      terms: 1,
      firstDueOn: '2027-01-01',
    }),
  ]);
  assert.equal(raced.filter((r) => r.status < 300).length, 1);
  const balance = (await call(f, 'get', '/credit-lines/balances').expect(200)).body.find(
    (l) => l._id === line._id,
  );
  assert.ok(balance.archived ? balance.usedMinor === 0 : balance.usedMinor === 100);
});

test('Espacios guardan identidad y módulos; solo el propietario puede administrarlos', async () => {
  const f = await fixture();
  const original = (await call(f, 'get', '').expect(200)).body;
  assert.equal(original.role, 'owner');
  assert.equal(original.color, '#164e3d');
  assert.equal(original.enabledModules.length, 9);
  const editor = await user(),
    viewer = await user(),
    other = await fixture();
  await call(f, 'post', '/members', { email: editor.email, role: 'editor' }).expect(201);
  await call(f, 'post', '/members', { email: viewer.email, role: 'viewer' }).expect(201);
  for (const u of [editor, viewer])
    await call({ ...f, token: u.token }, 'patch', '', {
      name: 'Ajeno',
      color: '#aabbcc',
      enabledModules: [],
      revision: 1,
    }).expect(403);
  await call({ ...f, token: other.token }, 'patch', '', { name: 'Ajeno', revision: 1 }).expect(404);
  const updated = (
    await call(f, 'patch', '', {
      name: 'Estudio',
      kind: 'workspace',
      description: 'Diseño y proyectos',
      color: '#AABBCC',
      enabledModules: ['projects', 'contacts'],
      revision: 1,
    }).expect(200)
  ).body;
  assert.equal(updated.color, '#aabbcc');
  assert.equal(updated.kind, 'workspace');
  assert.deepEqual(updated.enabledModules, ['projects', 'contacts']);
  const partial = (
    await call(f, 'patch', '', { name: 'Estudio nuevo', revision: updated.revision }).expect(200)
  ).body;
  assert.equal(partial.description, 'Diseño y proyectos');
  assert.deepEqual(partial.enabledModules, updated.enabledModules);
  await call(f, 'patch', '', { name: 'Obsoleto', revision: 1 }).expect(409);
  const listed = (
    await request(app).get('/api/v1/businesses').auth(f.token, { type: 'bearer' }).expect(200)
  ).body.data;
  assert.equal(listed.find((b) => b._id === f.business._id).name, 'Estudio nuevo');
  assert.equal((await call(other, 'get', '').expect(200)).body.color, '#164e3d');
  const audit = await db
    .collection('audit')
    .find({ businessId: f.business._id, action: 'business.updated' })
    .toArray();
  assert.equal(audit.length, 2);
  assert.equal(audit[0].before.name, 'Negocio');
  assert.equal(audit[0].after.color, '#aabbcc');
});

test('Módulos desactivados bloquean escrituras y cálculo, conservan registros y se pueden reactivar', async () => {
  const f = await fixture(),
    w = await wallet(f, 1000);
  const projectBody = { name: 'Proyecto anterior', tasks: [] };
  await call(f, 'post', '/projects', projectBody).expect(201);
  const config = (await call(f, 'get', '').expect(200)).body;
  const disabled = (
    await call(f, 'patch', '', { enabledModules: [], revision: config.revision }).expect(200)
  ).body;
  const attempts = [
    ['post', '/wallets', { name: 'Bloqueada' }],
    ['patch', `/wallets/${w._id}`, { name: 'Cambio', revision: w.revision }],
    ['post', '/inventory-lists', { name: 'Inventario' }],
    ['post', '/contact-lists', { name: 'Contactos' }],
    ['post', '/projects', { name: 'Otro' }],
    ['post', '/events', { title: 'Evento', date: '2027-01-01' }],
    ['post', '/credit-lines', { name: 'Línea', limitMinor: 100 }],
    [
      'post',
      '/movements',
      { walletId: w._id, kind: 'income', amountMinor: 100, category: 'Ingreso' },
    ],
    ['post', '/projections/calculate', {}],
  ];
  for (const [method, path, body] of attempts) {
    const result = await call(f, method, path, body).expect(409);
    assert.equal(result.body.error.code, 'MODULE_DISABLED', path);
  }
  assert.equal((await call(f, 'get', '/projects').expect(200)).body.data.length, 1);
  assert.equal((await call(f, 'get', `/wallets/${w._id}`).expect(200)).body.balanceMinor, 1000);
  await call(
    f,
    'get',
    '/history?collection=wallets&at=' + encodeURIComponent(new Date().toISOString()),
  ).expect(200);
  await call(f, 'patch', '', { enabledModules: ['projects'], revision: disabled.revision }).expect(
    200,
  );
  await call(f, 'post', '/projects', { name: 'Reactivado' }).expect(201);
  assert.equal((await call(f, 'get', '/projects').expect(200)).body.data.length, 2);
});

test('Identidad y dependencias se validan, y negocios antiguos conservan todos los módulos', async () => {
  const f = await fixture();
  for (const patch of [
    { color: 'red' },
    { color: '#fff' },
    { color: '#ffffff;display:none' },
    { enabledModules: ['unknown'] },
    { enabledModules: ['finance', 'finance'] },
    { enabledModules: ['sales'] },
    { enabledModules: ['sales', 'finance'] },
    { kind: 'other' },
    { currency: 'USD' },
    {},
  ])
    await call(f, 'patch', '', { ...patch, revision: 1 }).expect(422);
  const newBusiness = await request(app)
    .post('/api/v1/businesses')
    .auth(f.token, { type: 'bearer' })
    .send({
      name: 'Espacio nuevo',
      kind: 'workspace',
      currency: 'MXN',
      color: '#336699',
      enabledModules: [],
    })
    .expect(201);
  assert.equal(newBusiness.body.kind, 'workspace');
  assert.deepEqual(newBusiness.body.enabledModules, []);
  await db
    .collection('businesses')
    .updateOne(
      { _id: f.business._id },
      { $unset: { color: '', enabledModules: '', kind: '', description: '' } },
    );
  assert.equal((await call(f, 'get', '').expect(200)).body.enabledModules.length, 9);
  await call(f, 'post', '/projects', { name: 'Compatible' }).expect(201);
  const catalog = (
    await request(app).get('/api/v1/business-modules').auth(f.token, { type: 'bearer' }).expect(200)
  ).body.data;
  assert.equal(catalog.length, 9);
  assert.deepEqual(catalog.find((m) => m.id === 'sales').requires, ['finance', 'inventory']);
  await request(app).get('/api/v1/business-modules').expect(401);
});

test('Crear espacio con la misma clave, incluso concurrentemente, conserva un solo negocio y propietario', async () => {
  const u = await user(),
    key = randomUUID(),
    body = { name: 'Sin duplicados', currency: 'MXN', color: '#123456', enabledModules: [] };
  const create = (data = body) =>
    request(app)
      .post('/api/v1/businesses')
      .auth(u.token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send(data);
  const results = await Promise.all([create().expect(201), create().expect(201)]);
  assert.equal(results[0].body._id, results[1].body._id);
  await create({ ...body, name: 'Otro' }).expect(409);
  const list = (
    await request(app).get('/api/v1/businesses').auth(u.token, { type: 'bearer' }).expect(200)
  ).body.data;
  assert.equal(list.length, 1);
  assert.equal(
    await db
      .collection('memberships')
      .countDocuments({ businessId: list[0]._id, userId: u.id, role: 'owner' }),
    1,
  );
  assert.equal(
    await db.collection('audit').countDocuments({
      businessId: list[0]._id,
      action: 'business.created',
      collection: 'businesses',
    }),
    1,
  );
});

test('Abono a línea se reparte por vencimiento, libera cupo y revierte completo ante saldo insuficiente', async () => {
  const f = await fixture(),
    w = await wallet(f, 1000),
    empty = await wallet(f, 0);
  let line = (
    await call(f, 'post', '/credit-lines', { name: 'Tarjeta', limitMinor: 1000 }).expect(201)
  ).body;
  const createDebt = async (name, principalMinor, feeMinor, firstDueOn) =>
    (
      await call(f, 'post', '/debts', {
        name,
        kind: 'deferred',
        creditLineId: line._id,
        principalMinor,
        feeMinor,
        firstDueOn,
        terms: 1,
        category: 'Servicios',
      }).expect(201)
    ).body;
  const later = await createDebt('Compra posterior', 100, 10, '2027-03-01'),
    earlier = await createDebt('Compra primero', 200, 5, '2027-01-01');
  line = (await call(f, 'get', `/credit-lines/${line._id}`).expect(200)).body;
  const key = randomUUID(),
    body = {
      walletId: w._id,
      amountMinor: 250,
      description: 'Abono desde Movimientos',
      revision: line.revision,
    };
  const paid = (await call(f, 'post', `/credit-lines/${line._id}/payments`, body, key).expect(201))
    .body;
  assert.equal(paid.payments.length, 2);
  assert.equal(paid.payments[0].debt._id, earlier._id);
  assert.equal(paid.payments[0].debt.status, 'settled');
  assert.equal(paid.payments[1].debt._id, later._id);
  assert.equal(paid.payments[1].payment.feeMinor, 10);
  assert.equal(paid.payments[1].payment.principalMinor, 35);
  await call(f, 'post', `/credit-lines/${line._id}/payments`, body, key).expect(201);
  assert.equal((await call(f, 'get', `/wallets/${w._id}`).expect(200)).body.balanceMinor, 750);
  assert.equal((await call(f, 'get', '/debt-payments').expect(200)).body.data.length, 2);
  assert.equal(
    (await call(f, 'get', `/debts/${later._id}`).expect(200)).body.category,
    'Servicios',
  );
  let balance = (await call(f, 'get', '/credit-lines/balances').expect(200)).body[0];
  assert.equal(balance.usedMinor, 65);
  assert.equal(balance.availableMinor, 935);
  const count = await db.collection('audit').countDocuments({ businessId: f.business._id });
  await call(f, 'post', `/credit-lines/${line._id}/payments`, {
    walletId: empty._id,
    amountMinor: 65,
    revision: paid.line.revision,
  }).expect(422);
  assert.equal(await db.collection('audit').countDocuments({ businessId: f.business._id }), count);
  assert.equal((await call(f, 'get', '/debt-payments').expect(200)).body.data.length, 2);
  balance = (await call(f, 'get', '/credit-lines/balances').expect(200)).body[0];
  assert.equal(balance.usedMinor, 65);
  await call(f, 'post', `/credit-lines/${line._id}/payments`, {
    walletId: w._id,
    amountMinor: 66,
    revision: balance.revision,
  }).expect(422);
  const viewer = await user();
  await call(f, 'post', '/members', { email: viewer.email, role: 'viewer' }).expect(201);
  await call({ ...f, token: viewer.token }, 'post', `/credit-lines/${line._id}/payments`, {
    walletId: w._id,
    amountMinor: 1,
    revision: balance.revision,
  }).expect(403);
  const other = await fixture();
  await call(other, 'post', `/credit-lines/${line._id}/payments`, {
    walletId: w._id,
    amountMinor: 1,
    revision: balance.revision,
  }).expect(404);
  const finalBody = { walletId: w._id, amountMinor: 65, revision: balance.revision };
  const concurrent = await Promise.all([
    call(f, 'post', `/credit-lines/${line._id}/payments`, finalBody),
    call(f, 'post', `/credit-lines/${line._id}/payments`, finalBody),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await call(f, 'get', `/wallets/${w._id}`).expect(200)).body.balanceMinor, 685);
  balance = (await call(f, 'get', '/credit-lines/balances').expect(200)).body[0];
  assert.equal(balance.usedMinor, 0);
  await call(f, 'post', `/credit-lines/${line._id}/payments`, {
    walletId: w._id,
    amountMinor: 1,
    revision: balance.revision,
  }).expect(409);
  await call(f, 'patch', `/credit-lines/${line._id}`, {
    archived: true,
    revision: balance.revision,
  }).expect(200);
  const archived = await call(f, 'post', `/credit-lines/${line._id}/payments`, {
    walletId: w._id,
    amountMinor: 1,
    revision: balance.revision + 1,
  }).expect(422);
  assert.equal(archived.body.error.code, 'CREDIT_LINE_ARCHIVED');
});
