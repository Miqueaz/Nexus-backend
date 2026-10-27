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

test('Contact commissioner profiles link only workspace users, scope service conditions and snapshot negotiated commissions', async () => {
  const f = await fixture(),
    w = await wallet(f, 0),
    outsider = await user(),
    teammate = await user();
  await call(f, 'post', '/members', { email: teammate.email, role: 'viewer' }).expect(201);
  const users = (await call(f, 'get', '/contacts/linkable-users').expect(200)).body.data;
  assert.ok(users.some((u) => u._id === f.id));
  assert.ok(users.some((u) => u._id === teammate.id));
  assert.ok(!users.some((u) => u._id === outsider.id));
  assert.ok(users.every((u) => Object.keys(u).every((k) => ['_id', 'name', 'email'].includes(k))));
  const list = (
    await call(f, 'post', '/contact-lists', { name: 'Comisionistas', fields: [] }).expect(201)
  ).body;
  const service = (
    await call(f, 'post', '/services', {
      name: 'Polarizado',
      priceMinor: 40000,
      materials: [],
    }).expect(201)
  ).body;
  const second = (
    await call(f, 'post', '/services', {
      name: 'Instalación',
      priceMinor: 60000,
      materials: [],
    }).expect(201)
  ).body;
  const profile = {
    enabled: true,
    default: { type: 'percent', value: 500, base: 'sale', description: 'Comisión general' },
    services: [
      {
        serviceId: service._id,
        type: 'percent',
        value: 1500,
        base: 'sale',
        description: 'Polarizado acordado',
      },
    ],
  };
  const input = { name: 'Ana', listIds: [list._id], userId: f.id, commissionProfile: profile };
  await call(f, 'post', '/contacts', { ...input, userId: outsider.id }).expect(422);
  const c = (await call(f, 'post', '/contacts', input).expect(201)).body;
  assert.equal(c.userId, null);
  await request(app)
    .post('/api/v1/notifications/' + c._id + '/respond')
    .auth(f.token, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({ businessId: f.business._id, requestId: c.userLink.requestId, decision: 'accepted' })
    .expect(200);
  assert.equal(c.commissionProfile.services[0].value, 1500);
  await call(f, 'patch', '/contacts/' + c._id, {
    revision: 1,
    commissionProfile: { ...profile, services: [...profile.services, ...profile.services] },
  }).expect(422);
  const saleInput = {
    walletId: w._id,
    lines: [
      { serviceId: service._id, quantityMilli: 1000 },
      { serviceId: second._id, quantityMilli: 1000 },
    ],
    discount: { type: 'percent', value: 1000, reason: 'Promoción' },
    commissions: [
      {
        contactId: c._id,
        serviceId: service._id,
        type: 'percent',
        value: 1500,
        base: 'sale',
        description: 'Acuerdo aplicado',
      },
    ],
  };
  const sale = (await call(f, 'post', '/sales', saleInput).expect(201)).body;
  assert.equal(sale.totalMinor, 90000);
  assert.equal(sale.commissionTotalMinor, 5400);
  assert.equal(sale.commissions[0].baseMinor, 36000);
  assert.equal(sale.commissions[0].userId, f.id);
  assert.equal(sale.commissions[0].serviceName, 'Polarizado');
  assert.equal(sale.netProfitMinor, 84600);
  await call(f, 'patch', '/contacts/' + c._id, {
    revision: 2,
    userId: teammate.id,
    commissionProfile: { ...profile, default: { ...profile.default, value: 2000 } },
  }).expect(200);
  const stored = (await call(f, 'get', '/sales/' + sale._id).expect(200)).body;
  assert.equal(stored.commissionTotalMinor, 5400);
  assert.equal(stored.commissions[0].userId, f.id);
  const pending = (await call(f, 'get', '/contacts/' + c._id).expect(200)).body;
  await request(app)
    .post('/api/v1/notifications/' + c._id + '/respond')
    .auth(teammate.token, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({
      businessId: f.business._id,
      requestId: pending.userLink.requestId,
      decision: 'accepted',
    })
    .expect(200);
  const edited = (
    await call(f, 'patch', `/sales/${sale._id}/commissions`, {
      revision: 1,
      commissions: [
        {
          contactId: c._id,
          serviceId: service._id,
          type: 'fixed',
          value: 2000,
          base: 'sale',
          description: 'Excepción de esta venta',
        },
      ],
    }).expect(200)
  ).body;
  assert.equal(edited.commissionTotalMinor, 2000);
  assert.equal(edited.commissions[0].userId, teammate.id);
  await call(f, 'post', '/sales', {
    ...saleInput,
    commissions: [{ ...saleInput.commissions[0], serviceId: randomUUID() }],
  }).expect(422);
  const foreign = await fixture(),
    foreignService = (
      await call(foreign, 'post', '/services', {
        name: 'Ajeno',
        priceMinor: 100,
        materials: [],
      }).expect(201)
    ).body;
  await call(f, 'patch', '/contacts/' + c._id, {
    revision: 4,
    commissionProfile: {
      ...profile,
      services: [{ ...profile.services[0], serviceId: foreignService._id }],
    },
  }).expect(404);
  await call(f, 'patch', '/contacts/' + c._id, { revision: 4, userId: null }).expect(200);
  assert.equal((await call(f, 'get', '/contacts/' + c._id).expect(200)).body.userId, null);
});
function call(f, method, path, body, key = randomUUID()) {
  let r = request(app)
    [method](f.base + path)
    .auth(f.token, { type: 'bearer' });
  if (body) r = r.send(body);
  return r.set('Idempotency-Key', key);
}

test('Named customers and commissionists do not need contacts, memberships or account associations', async () => {
  const f = await fixture(),
    w = await wallet(f, 0),
    saleInput = {
      walletId: w._id,
      customerName: 'Cliente de mostrador',
      lines: [
        { name: 'Trabajo libre', quantityMilli: 1000, unitPriceMinor: 40000, unitCostMinor: 10000 },
      ],
      commissions: [
        {
          name: 'Instalador externo',
          type: 'percent',
          value: 1000,
          base: 'sale',
          description: 'Acuerdo directo',
        },
      ],
    };
  const sale = (await call(f, 'post', '/sales', saleInput).expect(201)).body;
  assert.equal(sale.customer.name, 'Cliente de mostrador');
  assert.equal(sale.customer._id, undefined);
  assert.equal(sale.commissions[0].name, 'Instalador externo');
  assert.equal(sale.commissions[0].userId, undefined);
  assert.equal(sale.commissionTotalMinor, 4000);
  assert.equal(await db.collection('contacts').countDocuments({ businessId: f.business._id }), 0);
  const quote = (
    await call(f, 'post', '/quotes', {
      customerName: 'Cliente cotizado',
      title: 'Trabajo',
      lines: saleInput.lines,
      expiresOn: '2099-01-01',
    }).expect(201)
  ).body;
  await call(f, 'post', '/quotes/' + quote._id + '/status', {
    revision: 1,
    status: 'accepted',
  }).expect(200);
  const converted = (
    await call(f, 'post', '/quotes/' + quote._id + '/convert', {
      revision: 2,
      walletId: w._id,
    }).expect(201)
  ).body;
  assert.equal(converted.customer.name, 'Cliente cotizado');
  const unnamed = (
    await call(f, 'post', '/sales', { walletId: w._id, lines: saleInput.lines }).expect(201)
  ).body;
  assert.equal(unnamed.customer, null);
  assert.equal(unnamed.commissions.length, 0);

  const list = (
    await call(f, 'post', '/contact-lists', { name: 'Clientes', fields: [] }).expect(201)
  ).body;
  const contact = (
    await call(f, 'post', '/contacts', { name: 'Cliente guardado', listIds: [list._id] }).expect(
      201,
    )
  ).body;
  const q = (
    await call(f, 'post', '/quotes', {
      customerId: contact._id,
      title: 'Cambio de cliente',
      lines: saleInput.lines,
      expiresOn: '2099-01-01',
    }).expect(201)
  ).body;
  const updated = (
    await call(f, 'put', '/quotes/' + q._id, {
      revision: 1,
      customerName: 'Nombre nuevo',
      title: q.title,
      lines: saleInput.lines,
      expiresOn: '2099-01-01',
    }).expect(200)
  ).body;
  assert.equal(updated.customerId, null);
  await call(f, 'post', '/quotes/' + q._id + '/status', { revision: 2, status: 'accepted' }).expect(
    200,
  );
  const changed = (
    await call(f, 'post', '/quotes/' + q._id + '/convert', { revision: 3, walletId: w._id }).expect(
      201,
    )
  ).body;
  assert.equal(changed.customer.name, 'Nombre nuevo');
});

test('Association notifications require the target consent, support viewer responses and reject stale or foreign requests', async () => {
  const f = await fixture(),
    recipient = await user(),
    stranger = await user();
  await call(f, 'post', '/members', { email: recipient.email, role: 'viewer' }).expect(201);
  const list = (
    await call(f, 'post', '/contact-lists', { name: 'Personas', fields: [] }).expect(201)
  ).body;
  const c = (
    await call(f, 'post', '/contacts', {
      name: 'Persona asociada',
      listIds: [list._id],
      userId: recipient.id,
      commissionProfile: {
        enabled: true,
        default: { type: 'fixed', value: 1000, base: 'sale', description: '' },
        services: [],
      },
    }).expect(201)
  ).body;
  assert.equal(c.userId, null);
  assert.equal(c.userLink.status, 'pending');
  const inbox = async (u) =>
    (await request(app).get('/api/v1/notifications').auth(u.token, { type: 'bearer' }).expect(200))
      .body.data;
  assert.equal((await inbox(f)).length, 0);
  assert.equal((await inbox(stranger)).length, 0);
  assert.equal((await inbox(recipient))[0].contactName, c.name);
  const respond = (u, requestId, decision) =>
    request(app)
      .post('/api/v1/notifications/' + c._id + '/respond')
      .auth(u.token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ businessId: f.business._id, requestId, decision });
  await respond(f, c.userLink.requestId, 'accepted').expect(404);
  await respond(recipient, 'wrong', 'accepted').expect(409);
  await respond(recipient, c.userLink.requestId, 'rejected').expect(200);
  await respond(recipient, c.userLink.requestId, 'rejected').expect(200);
  assert.equal((await inbox(recipient)).length, 0);
  let stored = (await call(f, 'get', '/contacts/' + c._id).expect(200)).body;
  assert.equal(stored.userId, null);
  assert.equal(stored.userLink.status, 'rejected');
  const resent = (
    await call(f, 'patch', '/contacts/' + c._id, {
      revision: stored.revision,
      userId: recipient.id,
    }).expect(200)
  ).body;
  assert.notEqual(resent.userLink.requestId, c.userLink.requestId);
  await respond(recipient, c.userLink.requestId, 'accepted').expect(409);
  await respond(recipient, resent.userLink.requestId, 'accepted').expect(200);
  await respond(recipient, resent.userLink.requestId, 'accepted').expect(200);
  stored = (await call(f, 'get', '/contacts/' + c._id).expect(200)).body;
  assert.equal(stored.userId, recipient.id);
  assert.equal(stored.userLink.status, 'accepted');
  assert.equal(
    (
      await db
        .collection('memberships')
        .findOne({ businessId: f.business._id, userId: recipient.id })
    ).role,
    'viewer',
  );
  assert.equal(
    await db.collection('audit').countDocuments({
      businessId: f.business._id,
      entityId: c._id,
      action: 'contact.association.accepted',
    }),
    1,
  );
  const cancelled = (
    await call(f, 'patch', '/contacts/' + c._id, {
      revision: stored.revision,
      userId: null,
    }).expect(200)
  ).body;
  assert.equal(cancelled.userId, null);
  await respond(recipient, resent.userLink.requestId, 'accepted').expect(409);
  // Old direct links also require consent; they are never treated as accepted implicitly.
  await db
    .collection('contacts')
    .updateOne({ _id: c._id }, { $set: { userId: recipient.id }, $unset: { userLink: '' } });
  const legacy = (await inbox(recipient))[0];
  assert.equal(legacy.requestId, 'legacy:' + c._id);
  await respond(recipient, legacy.requestId, 'rejected').expect(200);
  assert.equal((await call(f, 'get', '/contacts/' + c._id).expect(200)).body.userId, null);
});

test('Movement corrections preserve originals, audit reasons, exact balances and idempotent history', async () => {
  const f = await fixture(),
    w = await wallet(f, 100000),
    other = await wallet(f, 0);
  const original = (
    await call(f, 'post', '/movements', {
      walletId: w._id,
      kind: 'expense',
      amountMinor: 10000,
      category: 'Material',
      description: 'Compra original',
      occurredOn: '2026-01-02',
    }).expect(201)
  ).body;
  const before = original.createdAt,
    key = randomUUID(),
    body = {
      revision: original.revision,
      reason: 'Se capturaron 100 en lugar de 125.50',
      replacement: {
        walletId: other._id,
        kind: 'expense',
        amountMinor: 12550,
        category: 'Material',
        description: 'Compra corregida',
        occurredOn: '2026-01-03',
      },
    };
  // Moving an expense to an empty account fails atomically.
  await call(f, 'post', `/movements/${original._id}/corrections`, body).expect(422);
  assert.equal((await call(f, 'get', '/wallets/' + w._id).expect(200)).body.balanceMinor, 90000);
  body.replacement.walletId = w._id;
  const changed = (
    await call(f, 'post', `/movements/${original._id}/corrections`, body, key).expect(201)
  ).body;
  const again = (
    await call(f, 'post', `/movements/${original._id}/corrections`, body, key).expect(201)
  ).body;
  assert.equal(again.adjustments[0]._id, changed.adjustments[0]._id);
  assert.equal(changed.original.amountMinor, -10000);
  assert.equal(changed.original.description, 'Compra original');
  assert.equal(changed.original.occurredOn, '2026-01-02');
  assert.equal(changed.original.createdAt, before);
  assert.equal(changed.original.correctionStatus, 'edited');
  assert.equal(changed.reversals[0].amountMinor, 10000);
  assert.equal(changed.adjustments[0].amountMinor, -12550);
  assert.equal((await call(f, 'get', '/wallets/' + w._id).expect(200)).body.balanceMinor, 87450);
  const adjusted = changed.adjustments[0];
  await call(f, 'post', `/movements/${original._id}/corrections`, body).expect(409);
  const cancelled = (
    await call(f, 'post', `/movements/${adjusted._id}/cancellations`, {
      revision: adjusted.revision,
      reason: 'Compra no realizada',
    }).expect(201)
  ).body;
  assert.equal(cancelled.original.correctionStatus, 'cancelled');
  assert.equal(cancelled.adjustments.length, 0);
  assert.equal((await call(f, 'get', '/wallets/' + w._id).expect(200)).body.balanceMinor, 100000);
  const history = (await call(f, 'get', `/movements/${original._id}/changes`).expect(200)).body;
  assert.equal(history.rows.length, 2);
  assert.equal(history.rows[1].changeReason, 'Compra no realizada');
  const audit = await db.collection('audit').findOne({
    businessId: f.business._id,
    action: 'finance.movement.corrected',
    entityId: original._id,
  });
  assert.equal(audit.actorId, f.id);
  assert.equal(audit.after.changeReason, body.reason);
  assert.equal(audit.before.amountMinor, audit.after.amountMinor);
  const all = await db
    .collection('movements')
    .find({ businessId: f.business._id, walletId: w._id })
    .toArray();
  assert.equal(
    all.reduce((n, r) => n + r.amountMinor, 0),
    100000,
  );
});

test('Transfers adjust both sides atomically and history works from the receiving entry', async () => {
  const f = await fixture(),
    a = await wallet(f, 10000),
    b = await wallet(f, 0);
  const transfer = (
    await call(f, 'post', '/transfers', {
      fromWalletId: a._id,
      toWalletId: b._id,
      amountMinor: 5000,
      description: 'Entre cuentas',
    }).expect(201)
  ).body;
  const body = {
    revision: 1,
    reason: 'Importe real 70',
    replacement: {
      walletId: a._id,
      toWalletId: b._id,
      kind: 'transfer',
      amountMinor: 7000,
      category: 'transfer',
      description: 'Corrección transferencia',
      occurredOn: '2026-01-01',
    },
  };
  const result = (
    await call(f, 'post', `/movements/${transfer.to._id}/corrections`, body).expect(201)
  ).body;
  assert.equal(result.reversals.length, 2);
  assert.equal(result.adjustments.length, 2);
  assert.equal((await call(f, 'get', '/wallets/' + a._id).expect(200)).body.balanceMinor, 3000);
  assert.equal((await call(f, 'get', '/wallets/' + b._id).expect(200)).body.balanceMinor, 7000);
  const h = (await call(f, 'get', `/movements/${transfer.to._id}/changes`).expect(200)).body;
  assert.equal(h.rootId, transfer.from._id);
  assert.equal(h.rows.length, 2);
  await call(f, 'post', `/movements/${result.adjustments[1]._id}/cancellations`, {
    revision: 1,
    reason: 'Transferencia anulada',
  }).expect(201);
  assert.equal((await call(f, 'get', '/wallets/' + a._id).expect(200)).body.balanceMinor, 10000);
  assert.equal((await call(f, 'get', '/wallets/' + b._id).expect(200)).body.balanceMinor, 0);
});

test('Movement corrections guard ownership, viewer roles, stale versions, linked operations and concurrent submissions', async () => {
  const f = await fixture(),
    w = await wallet(f, 10000),
    other = await fixture();
  const r = (
    await call(f, 'post', '/movements', {
      walletId: w._id,
      kind: 'income',
      amountMinor: 5000,
      category: 'Ingreso',
      description: 'Original',
    }).expect(201)
  ).body;
  const endpoint = `/movements/${r._id}/cancellations`,
    body = { revision: 1, reason: 'Duplicado' };
  await call(other, 'post', endpoint, body).expect(404);
  await call(other, 'get', `/movements/${r._id}/changes`).expect(404);
  const viewer = await user();
  await call(f, 'post', '/members', { email: viewer.email, role: 'viewer' }).expect(201);
  await call({ ...f, token: viewer.token }, 'post', endpoint, body).expect(403);
  await call(f, 'post', endpoint, { ...body, reason: ' ' }).expect(422);
  const opening = await db
    .collection('movements')
    .findOne({ businessId: f.business._id, kind: 'opening' });
  await call(f, 'post', `/movements/${opening._id}/cancellations`, body).expect(422);
  const results = await Promise.all([
    call(f, 'post', endpoint, body),
    call(f, 'post', endpoint, body),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 409]);
  assert.equal((await call(f, 'get', '/wallets/' + w._id).expect(200)).body.balanceMinor, 10000);
});

test('Unpaid credit purchases retain original schedules and a complete adjustment chain without moving cash', async () => {
  const f = await fixture(),
    w = await wallet(f, 10000),
    line = (
      await call(f, 'post', '/credit-lines', { name: 'Tarjeta', limitMinor: 100000 }).expect(201)
    ).body;
  const old = (
    await call(f, 'post', '/debts', {
      name: 'Compra',
      kind: 'deferred',
      creditLineId: line._id,
      principalMinor: 30000,
      feeMinor: 1000,
      terms: 3,
      firstDueOn: '2027-01-01',
      mode: 'monthly',
    }).expect(201)
  ).body;
  const body = {
    revision: 1,
    reason: 'Capital correcto 250',
    replacement: {
      name: 'Compra ajustada',
      creditLineId: line._id,
      principalMinor: 25000,
      feeMinor: 1000,
      terms: 2,
      firstDueOn: '2027-02-01',
      mode: 'monthly',
      category: 'Materiales',
      notes: 'Factura corregida',
    },
  };
  const result = (await call(f, 'post', `/debts/${old._id}/corrections`, body).expect(201)).body;
  assert.equal(result.original.status, 'cancelled');
  assert.equal(result.original.correctionStatus, 'edited');
  assert.deepEqual(result.original.schedule, old.schedule);
  assert.equal(result.adjusted.principalMinor, 25000);
  let balances = (await call(f, 'get', '/credit-lines/balances').expect(200)).body;
  assert.equal(balances[0].usedMinor, 26000);
  const history = (await call(f, 'get', `/debts/${result.adjusted._id}/changes`).expect(200)).body;
  assert.equal(history.rows.length, 2);
  await call(f, 'post', `/debts/${result.adjusted._id}/cancellations`, {
    revision: 1,
    reason: 'Devolución de compra',
  }).expect(201);
  balances = (await call(f, 'get', '/credit-lines/balances').expect(200)).body;
  assert.equal(balances[0].usedMinor, 0);
  assert.equal((await call(f, 'get', '/wallets/' + w._id).expect(200)).body.balanceMinor, 10000);
  await call(f, 'patch', '/credit-lines/' + line._id, {
    revision: balances[0].revision,
    archived: true,
  }).expect(200);
});

test('Credit corrections reject paid purchases and closed periods, and preserve the original on capacity errors', async () => {
  const f = await fixture(),
    w = await wallet(f, 100000),
    line = (
      await call(f, 'post', '/credit-lines', { name: 'Tarjeta', limitMinor: 100000 }).expect(201)
    ).body;
  const make = async () =>
    (
      await call(f, 'post', '/debts', {
        name: 'Compra',
        kind: 'deferred',
        creditLineId: line._id,
        principalMinor: 30000,
        terms: 1,
        firstDueOn: '2027-01-01',
        mode: 'monthly',
      }).expect(201)
    ).body;
  const paid = await make();
  await call(f, 'post', `/debts/${paid._id}/payments`, {
    revision: 1,
    walletId: w._id,
    amountMinor: 1000,
    description: 'Abono',
  }).expect(201);
  await call(f, 'post', `/debts/${paid._id}/cancellations`, {
    revision: 2,
    reason: 'Error',
  }).expect(409);
  const old = await make();
  await call(f, 'post', `/debts/${old._id}/corrections`, {
    revision: 1,
    reason: 'Excede cupo',
    replacement: {
      name: 'Exceso',
      creditLineId: line._id,
      principalMinor: 100000,
      feeMinor: 0,
      terms: 1,
      firstDueOn: '2027-01-01',
      mode: 'monthly',
      category: 'General',
      notes: '',
    },
  }).expect(422);
  assert.equal((await call(f, 'get', '/debts/' + old._id).expect(200)).body.status, 'active');
  const cutoff = new Date().toISOString().slice(0, 10);
  await call(f, 'post', `/credit-lines/${line._id}/statements`, {
    revision: (await call(f, 'get', '/credit-lines/' + line._id).expect(200)).body.revision,
    periodStartOn: cutoff,
    cutoffOn: cutoff,
    dueOn: '2027-01-01',
    revolvingMinor: 59000,
  }).expect(201);
  await call(f, 'post', `/debts/${old._id}/cancellations`, {
    revision: 1,
    reason: 'Período cerrado',
  }).expect(409);
});
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
test('Material consumption is independent of a fixed price, attributed to rolls, atomic and idempotent', async () => {
  const f = await fixture(),
    w = await wallet(f, 0);
  const list = (
    await call(f, 'post', '/inventory-lists', {
      name: 'Vinil por trabajo',
      inventoryDefaults: {
        unit: 'm',
        pricing: 'fixed',
        tracking: 'batches',
        packageSizeMilli: 30000,
      },
    }).expect(201)
  ).body;
  const material = (
    await call(f, 'post', '/items', {
      name: 'Vinil blanco',
      listIds: [list._id],
      priceMinor: 40000,
      costMinor: 10000,
    }).expect(201)
  ).body;
  assert.equal(material.unit, 'm');
  assert.equal(material.stockConfig.pricing, 'fixed');
  const stocked = (
    await call(f, 'post', `/items/${material._id}/adjustments`, {
      deltaMilli: 60000,
      batchCount: 2,
      batchLabel: 'Vinil',
      reason: 'Dos rollos de 30 m',
      revision: 1,
    }).expect(201)
  ).body.item;
  const sell = (cm, batchId) => ({
    walletId: w._id,
    lines: [
      {
        itemId: material._id,
        quantityMilli: 1000,
        consumption: { quantityMilli: cm * 1000, unit: 'cm', ...(batchId ? { batchId } : {}) },
      },
    ],
  });
  const key = randomUUID(),
    first = (await call(f, 'post', '/sales', sell(40, stocked.batches[0].id), key).expect(201))
      .body;
  const duplicate = (
    await call(f, 'post', '/sales', sell(40, stocked.batches[0].id), key).expect(201)
  ).body;
  assert.equal(first._id, duplicate._id);
  assert.equal(first.totalMinor, 40000);
  assert.equal(first.costMinor, 4000);
  assert.equal(first.lines[0].consumedQuantityMilli, 400);
  assert.equal(first.lines[0].allocations[0].batchId, stocked.batches[0].id);
  const second = (await call(f, 'post', '/sales', sell(55), randomUUID()).expect(201)).body;
  assert.equal(second.totalMinor, 40000);
  assert.equal(second.costMinor, 5500);
  assert.equal(second.profitMinor, 34500);
  const current = () => db.collection('items').findOne({ _id: material._id });
  assert.equal((await current()).stockMilli, 59050);
  assert.equal((await current()).batches[0].remainingMilli, 29050);
  await call(f, 'post', '/sales', sell(5000, stocked.batches[0].id)).expect(422);
  await call(f, 'post', '/sales', sell(1, randomUUID())).expect(422);
  const incompatible = sell(1);
  incompatible.lines[0].consumption.unit = 'kg';
  await call(f, 'post', '/sales', incompatible).expect(422);
  const noWallet = sell(10);
  noWallet.walletId = randomUUID();
  await call(f, 'post', '/sales', noWallet).expect(404);
  assert.equal((await current()).stockMilli, 59050);
  assert.equal(await db.collection('sales').countDocuments({ businessId: f.business._id }), 2);
  assert.equal((await db.collection('wallets').findOne({ _id: w._id })).balanceMinor, 80000);
  const movements = await db
    .collection('stockMovements')
    .find({ itemId: material._id, kind: 'sale' })
    .toArray();
  assert.equal(movements.length, 2);
  assert.equal(movements[0].unit, 'm');
  const now = await current();
  await call(f, 'patch', `/items/${material._id}`, { unit: 'cm', revision: now.revision }).expect(
    409,
  );
});
test('Measured prices use converted consumption, automatic allocation spans rolls and quotes do not consume stock', async () => {
  const f = await fixture(),
    w = await wallet(f, 0);
  const list = (
    await call(f, 'post', '/inventory-lists', {
      name: 'Material por centímetro',
      inventoryDefaults: {
        unit: 'm',
        priceUnit: 'cm',
        pricing: 'measure',
        tracking: 'batches',
        packageSizeMilli: 30000,
      },
    }).expect(201)
  ).body;
  const material = (
    await call(f, 'post', '/items', {
      name: 'Cable',
      listIds: [list._id],
      priceMinor: 100,
      costMinor: 2000,
    }).expect(201)
  ).body;
  await call(f, 'post', `/items/${material._id}/adjustments`, {
    deltaMilli: 60000,
    batchCount: 2,
    reason: 'Dos rollos',
    revision: 1,
  }).expect(201);
  const lines = [
    { itemId: material._id, quantityMilli: 1000, consumption: { quantityMilli: 30500, unit: 'm' } },
  ];
  const quote = (
    await call(f, 'post', '/quotes', { title: 'Trabajo', expiresOn: '2099-12-31', lines }).expect(
      201,
    )
  ).body;
  assert.equal(quote.totalMinor, 305000);
  assert.equal((await db.collection('items').findOne({ _id: material._id })).stockMilli, 60000);
  const accepted = (
    await call(f, 'post', `/quotes/${quote._id}/status`, {
      status: 'accepted',
      revision: quote.revision,
    }).expect(200)
  ).body;
  const sale = (
    await call(f, 'post', `/quotes/${quote._id}/convert`, {
      walletId: w._id,
      revision: accepted.revision,
    }).expect(201)
  ).body;
  assert.equal(sale.totalMinor, 305000);
  assert.equal(sale.costMinor, 61000);
  assert.equal(sale.lines[0].quantityMilli, 3050000);
  assert.deepEqual(
    sale.lines[0].allocations.map((a) => a.quantityMilli),
    [30000, 500],
  );
  assert.equal((await db.collection('items').findOne({ _id: material._id })).stockMilli, 29500);
});
test('Service catalog consumes internal-only materials, preserves the service charge and rolls back every failed effect', async () => {
  const f = await fixture(),
    w = await wallet(f, 0),
    vinyl = await item(f, 30000);
  await call(f, 'patch', '/items/' + vinyl._id, {
    sellable: false,
    unit: 'm',
    revision: vinyl.revision,
  }).expect(409);
  // A zero-balance item can be configured before receiving the roll.
  const list = (await call(f, 'post', '/inventory-lists', { name: 'Uso interno' }).expect(201))
    .body;
  const material = (
    await call(f, 'post', '/items', {
      name: 'Vinil interno',
      listIds: [list._id],
      sellable: false,
      unit: 'm',
      costMinor: 10000,
      stockConfig: { pricing: 'unit', tracking: 'batches', packageSizeMilli: 30000 },
    }).expect(201)
  ).body;
  const stocked = (
    await call(f, 'post', '/items/' + material._id + '/adjustments', {
      deltaMilli: 30000,
      reason: 'Rollo inicial',
      revision: 1,
    }).expect(201)
  ).body.item;
  const saved = (
    await call(f, 'post', '/services', {
      name: 'Polarizado de carro',
      priceMinor: 40000,
      materials: [{ itemId: material._id, quantityMilli: 40000, unit: 'cm' }],
    }).expect(201)
  ).body;
  assert.equal((await db.collection('items').findOne({ _id: material._id })).stockMilli, 30000);
  const viewer = await user();
  await call(f, 'post', '/members', { email: viewer.email, role: 'viewer' }).expect(201);
  const readOnly = { ...f, token: viewer.token };
  await call(readOnly, 'get', '/services').expect(200);
  await call(readOnly, 'post', '/services', { name: 'No permitido', priceMinor: 100 }).expect(403);
  await call(readOnly, 'post', '/sales', {
    walletId: w._id,
    lines: [{ serviceId: saved._id, quantityMilli: 1000 }],
  }).expect(403);
  await call(f, 'post', '/sales', {
    walletId: w._id,
    lines: [{ itemId: material._id, quantityMilli: 400 }],
  }).expect(422);
  const input = { walletId: w._id, lines: [{ serviceId: saved._id, quantityMilli: 1000 }] },
    key = randomUUID();
  const first = (await call(f, 'post', '/sales', input, key).expect(201)).body;
  assert.equal(first.totalMinor, 40000);
  assert.equal(first.costMinor, 4000);
  assert.equal(first.lines[0].name, 'Polarizado de carro');
  assert.equal(first.lines[0].materials[0].allocations[0].batchId, stocked.batches[0].id);
  assert.equal((await call(f, 'post', '/sales', input, key).expect(201)).body._id, first._id);
  const actual = {
    walletId: w._id,
    lines: [
      {
        serviceId: saved._id,
        quantityMilli: 1000,
        materials: [
          {
            itemId: material._id,
            quantityMilli: 55000,
            unit: 'cm',
            batchId: stocked.batches[0].id,
          },
        ],
      },
    ],
  };
  const second = (await call(f, 'post', '/sales', actual).expect(201)).body;
  assert.equal(second.totalMinor, 40000);
  assert.equal(second.costMinor, 5500);
  assert.equal(second.profitMinor, 34500);
  const fail = { ...actual, walletId: randomUUID() };
  await call(f, 'post', '/sales', fail).expect(404);
  const noStock = structuredClone(actual);
  noStock.lines[0].materials[0].quantityMilli = 4000000;
  await call(f, 'post', '/sales', noStock).expect(422);
  const cross = await fixture(),
    foreign = await item(cross);
  await call(cross, 'get', '/services/' + saved._id).expect(404);
  const foreignInput = structuredClone(actual);
  foreignInput.lines[0].materials[0].itemId = foreign._id;
  await call(f, 'post', '/sales', foreignInput).expect(404);
  assert.equal((await db.collection('items').findOne({ _id: material._id })).stockMilli, 29050);
  assert.equal((await db.collection('wallets').findOne({ _id: w._id })).balanceMinor, 80000);
  const audit = await db
    .collection('stockMovements')
    .find({ itemId: material._id, kind: 'sale' })
    .toArray();
  assert.equal(audit.length, 2);
  assert.equal(audit[0].serviceId, saved._id);
  assert.match(audit[0].reason, /Polarizado/);
  const archived = (
    await call(f, 'patch', '/services/' + saved._id, {
      archived: true,
      revision: saved.revision,
    }).expect(200)
  ).body;
  await call(f, 'post', '/sales', input).expect(422);
  assert.equal(
    (await call(f, 'get', '/sales/' + first._id).expect(200)).body.lines[0].materials[0].name,
    'Vinil interno',
  );
  await call(f, 'patch', '/services/' + saved._id, {
    archived: false,
    revision: archived.revision,
  }).expect(200);
  const free = (
    await call(f, 'post', '/sales', {
      walletId: w._id,
      lines: [
        {
          name: 'Polarizado ocasional',
          unitPriceMinor: 40000,
          quantityMilli: 1000,
          materials: [{ itemId: material._id, quantityMilli: 40000, unit: 'cm' }],
        },
      ],
    }).expect(201)
  ).body;
  assert.equal(free.totalMinor, 40000);
  assert.equal(free.costMinor, 4000);
  const quote = (
    await call(f, 'post', '/quotes', {
      title: 'Polarizado',
      expiresOn: '2099-12-31',
      lines: [
        {
          serviceId: saved._id,
          quantityMilli: 1000,
          materials: [
            {
              itemId: material._id,
              quantityMilli: 55000,
              unit: 'cm',
              batchId: stocked.batches[0].id,
            },
          ],
        },
      ],
    }).expect(201)
  ).body;
  const accepted = (
    await call(f, 'post', '/quotes/' + quote._id + '/status', {
      status: 'accepted',
      revision: quote.revision,
    }).expect(200)
  ).body;
  const conversion = (
    await call(f, 'post', '/quotes/' + quote._id + '/convert', {
      walletId: w._id,
      revision: accepted.revision,
    }).expect(201)
  ).body;
  assert.equal(conversion.costMinor, 5500);
  assert.equal(conversion.lines[0].materials[0].allocations[0].batchId, stocked.batches[0].id);
});
test('Per-sale commissions use discounted revenue or gross profit, preserve contact snapshots and never withdraw cash', async () => {
  const f = await fixture(),
    w = await wallet(f, 0);
  const list = (await call(f, 'post', '/contact-lists', { name: 'Comisionistas' }).expect(201))
    .body;
  const contact = (
    await call(f, 'post', '/contacts', { name: 'Ana', listIds: [list._id] }).expect(201)
  ).body;
  const commissions = [
    { contactId: contact._id, type: 'percent', value: 1000, base: 'sale', description: 'Referido' },
    { name: 'Pedro', type: 'fixed', value: 2000 },
    { name: 'Técnico', type: 'percent', value: 1000, base: 'profit' },
  ];
  const input = {
    walletId: w._id,
    lines: [
      { name: 'Polarizado', quantityMilli: 1000, unitPriceMinor: 40000, unitCostMinor: 5500 },
    ],
    discount: { type: 'fixed', value: 4000 },
    commissions,
  };
  const key = randomUUID();
  const sale = (await call(f, 'post', '/sales', input, key).expect(201)).body;
  assert.equal(sale.totalMinor, 36000);
  assert.equal(sale.profitMinor, 30500);
  assert.equal(sale.commissionTotalMinor, 8650);
  assert.equal(sale.netProfitMinor, 21850);
  assert.deepEqual(
    sale.commissions.map((c) => c.amountMinor),
    [3600, 2000, 3050],
  );
  assert.equal(sale.commissions[0].name, 'Ana');
  assert.equal((await call(f, 'post', '/sales', input, key).expect(201)).body._id, sale._id);
  assert.equal((await db.collection('wallets').findOne({ _id: w._id })).balanceMinor, 36000);
  assert.equal(await db.collection('movements').countDocuments({ businessId: f.business._id }), 1);
  await call(f, 'patch', '/contacts/' + contact._id, {
    name: 'Ana nueva',
    revision: contact.revision,
  }).expect(200);
  assert.equal(
    (await call(f, 'get', '/sales/' + sale._id).expect(200)).body.commissions[0].name,
    'Ana',
  );
  const bad = { ...input, commissions: [{ name: 'Inválido', type: 'percent', value: 10001 }] };
  await call(f, 'post', '/sales', bad).expect(422);
  const other = await fixture(),
    otherList = (await call(other, 'post', '/contact-lists', { name: 'Privados' }).expect(201))
      .body,
    foreign = (
      await call(other, 'post', '/contacts', { name: 'Ajeno', listIds: [otherList._id] }).expect(
        201,
      )
    ).body;
  await call(f, 'post', '/sales', {
    ...input,
    commissions: [{ contactId: foreign._id, type: 'fixed', value: 100 }],
  }).expect(404);
  assert.equal((await db.collection('wallets').findOne({ _id: w._id })).balanceMinor, 36000);
  const quote = (
    await call(f, 'post', '/quotes', {
      title: 'Con comisión al vender',
      lines: input.lines,
      discount: input.discount,
      expiresOn: '2099-12-31',
    }).expect(201)
  ).body;
  const accepted = (
    await call(f, 'post', '/quotes/' + quote._id + '/status', {
      status: 'accepted',
      revision: quote.revision,
    }).expect(200)
  ).body;
  const converted = (
    await call(f, 'post', '/quotes/' + quote._id + '/convert', {
      walletId: w._id,
      revision: accepted.revision,
      commissions,
    }).expect(201)
  ).body;
  assert.equal(converted.commissionTotalMinor, 8650);
  assert.equal(converted.commissions[0].name, 'Ana nueva');
  const loss = (
    await call(f, 'post', '/sales', {
      walletId: w._id,
      lines: [
        {
          name: 'Servicio con pérdida',
          quantityMilli: 1000,
          unitPriceMinor: 1000,
          unitCostMinor: 2000,
        },
      ],
      commissions: [
        { name: 'Sin ganancia', type: 'percent', value: 5000, base: 'profit' },
        { name: 'Fijo', type: 'fixed', value: 200 },
      ],
    }).expect(201)
  ).body;
  assert.equal(loss.commissions[0].amountMinor, 0);
  assert.equal(loss.netProfitMinor, -1200);
});
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
  assert.equal(original.enabledModules.length, 10);
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
  assert.equal((await call(f, 'get', '').expect(200)).body.enabledModules.length, 10);
  await call(f, 'post', '/projects', { name: 'Compatible' }).expect(201);
  const catalog = (
    await request(app).get('/api/v1/business-modules').auth(f.token, { type: 'bearer' }).expect(200)
  ).body.data;
  assert.equal(catalog.length, 10);
  assert.ok(catalog.some((module) => module.id === 'docs'));
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

test('Snapshot agrupa lecturas con aislamiento, historial y paginación sin truncar registros', async () => {
  const f = await fixture();
  const w = await wallet(f, 10000);
  const at = new Date().toISOString();
  await call(f, 'post', '/movements', {
    walletId: w._id,
    kind: 'income',
    amountMinor: 100,
    category: 'Prueba',
  }).expect(201);
  const current = (await call(f, 'get', '/snapshot').expect(200)).body;
  assert.equal(current.business._id, f.business._id);
  assert.equal(current.business.role, 'owner');
  assert.equal(Object.keys(current.collections).length, 17);
  assert.equal(current.collections.wallets.data[0].balanceMinor, 10100);
  assert.deepEqual(
    current.collections.movements,
    (await call(f, 'get', '/movements?limit=100').expect(200)).body,
  );
  const historical = (
    await call(
      f,
      'get',
      '/snapshot?collections=wallets,credit-lines&at=' + encodeURIComponent(at),
    ).expect(200)
  ).body;
  assert.equal(historical.readOnly, true);
  assert.equal(historical.collections.wallets.data[0].balanceMinor, 10000);
  assert.deepEqual(Object.keys(historical.collections), ['wallets', 'credit-lines']);
  assert.equal((await call(f, 'get', '/wallets/' + w._id).expect(200)).body.balanceMinor, 10100);
  for (const query of ['users', 'audit', 'wallets,wallets', '', 'wallets,unknown'])
    await call(f, 'get', '/snapshot?collections=' + query).expect(422);
  await call(
    f,
    'get',
    '/snapshot?at=' + encodeURIComponent(new Date(Date.now() + 60000).toISOString()),
  ).expect(422);
  const stranger = await user();
  await request(app)
    .get(f.base + '/snapshot')
    .auth(stranger.token, { type: 'bearer' })
    .expect(404);
  await request(app)
    .get(f.base + '/snapshot')
    .expect(401);
  const now = new Date();
  await db.collection('wallets').insertMany(
    Array.from({ length: 102 }, (_, i) => ({
      ...w,
      _id: randomUUID(),
      name: 'Paginada ' + i,
      createdAt: now,
      balanceMinor: 0,
    })),
  );
  const first = (await call(f, 'get', '/snapshot?collections=wallets').expect(200)).body.collections
    .wallets;
  assert.equal(first.data.length, 100);
  assert.ok(first.nextCursor);
  const rest = (await call(f, 'get', '/wallets?limit=100&cursor=' + first.nextCursor).expect(200))
    .body;
  assert.equal(new Set([...first.data, ...rest.data].map((row) => row._id)).size, 103);
  assert.equal(rest.nextCursor, null);
});

test('Reprogramación manual valida totales y conserva abonos, efectivo, revisión y auditoría', async () => {
  const f = await fixture(),
    w = await wallet(f, 200000);
  const d = (
    await call(f, 'post', '/debts', {
      name: 'Plan variable',
      kind: 'deferred',
      principalMinor: 100001,
      feeMinor: 1000,
      terms: 2,
      firstDueOn: '2028-01-31',
    }).expect(201)
  ).body;
  const paid = (
    await call(f, 'post', `/debts/${d._id}/payments`, {
      walletId: w._id,
      amountMinor: 10001,
      revision: 1,
    }).expect(201)
  ).body;
  const base = {
    terms: 3,
    firstDueOn: '2028-03-31',
    mode: 'custom',
    additionalFeeMinor: 500,
    reason: 'Ingresos variables',
    revision: 2,
  };
  for (const installmentsMinor of [
    [20000, 0, 71000],
    [20000, 0, 72000],
    [-1, 0, 91501],
    [20000, 71500],
    [20000.5, 0, 71499.5],
  ]) {
    await call(f, 'post', `/debts/${d._id}/reschedule`, { ...base, installmentsMinor }).expect(422);
  }
  await call(f, 'post', `/debts/${d._id}/reschedule`, base).expect(422);
  await call(f, 'post', `/debts/${d._id}/reschedule`, {
    ...base,
    mode: 'monthly',
    installmentsMinor: [20000, 0, 71500],
  }).expect(422);
  const updated = (
    await call(f, 'post', `/debts/${d._id}/reschedule`, {
      ...base,
      installmentsMinor: [20000, 0, 71500],
    }).expect(201)
  ).body;
  assert.equal(updated.mode, 'custom');
  const audit = await db
    .collection('audit')
    .find({ businessId: f.business._id, action: 'debt.rescheduled' })
    .toArray();
  assert.equal(audit.length, 1);
  assert.deepEqual(
    audit[0].after.schedule.slice(-3).map((r) => r.principalMinor + r.feeMinor),
    [20000, 0, 71500],
  );
  assert.equal(updated.paidPrincipalMinor, paid.debt.paidPrincipalMinor);
  assert.equal(updated.paidFeeMinor, paid.debt.paidFeeMinor);
  assert.deepEqual(
    updated.schedule.slice(-3).map((r) => r.principalMinor + r.feeMinor),
    [20000, 0, 71500],
  );
  assert.equal(updated.schedule[0].principalMinor, paid.debt.paidPrincipalMinor);
  assert.equal(updated.schedule[0].feeMinor, paid.debt.paidFeeMinor);
  const summary = (await call(f, 'get', '/summary').expect(200)).body;
  assert.equal(summary.wallets[0].balanceMinor, 189999);
  await call(f, 'post', `/debts/${d._id}/reschedule`, {
    ...base,
    installmentsMinor: [20000, 0, 71500],
  }).expect(409);
  const settled = (
    await call(f, 'post', `/debts/${d._id}/payments`, {
      walletId: w._id,
      amountMinor: 91500,
      revision: updated.revision,
    }).expect(201)
  ).body;
  assert.equal(settled.debt.status, 'settled');
  await call(f, 'post', `/debts/${d._id}/reschedule`, {
    ...base,
    revision: settled.debt.revision,
    installmentsMinor: [20000, 0, 71500],
  }).expect(409);
});

test('Estados de cuenta permiten dos mínimos con deuda, cierre inmutable, pagos reales e historial sin duplicaciones', async () => {
  const f = await fixture(),
    w = await wallet(f, 300000);
  const l = (
    await call(f, 'post', '/credit-lines', {
      name: 'Tarjeta con estados',
      limitMinor: 500000,
    }).expect(201)
  ).body;
  const debt = (
    await call(f, 'post', '/debts', {
      name: 'Compra normal',
      kind: 'deferred',
      billingKind: 'revolving',
      creditLineId: l._id,
      principalMinor: 200000,
      terms: 1,
      firstDueOn: '2027-01-10',
    }).expect(201)
  ).body;
  const current = (await call(f, 'get', `/credit-lines/${l._id}`).expect(200)).body;
  await call(f, 'patch', `/credit-lines/${l._id}`, {
    name: 'No permitido',
    revision: current.revision,
  }).expect(409);
  const changed = (
    await call(f, 'patch', `/credit-lines/${l._id}/minimum-rule`, {
      rule: { issuer: 'Emisor propio' },
      revision: current.revision,
    }).expect(200)
  ).body;
  const input = {
    periodStartOn: '2026-09-01',
    cutoffOn: '2026-09-30',
    dueOn: '2026-10-10',
    revolvingMinor: 100000,
  };
  const calc = (
    await call(f, 'post', `/credit-lines/${l._id}/statements/preview`, input).expect(200)
  ).body;
  assert.equal(calc.estimatedMinimumMinor, 6250);
  const key = randomUUID(),
    close = () =>
      call(
        f,
        'post',
        `/credit-lines/${l._id}/statements`,
        { ...input, revision: changed.revision },
        key,
      );
  const s = (await close().expect(201)).body;
  assert.equal((await close().expect(201)).body._id, s._id);
  assert.equal(
    await db.collection('creditStatements').countDocuments({ businessId: f.business._id }),
    1,
  );
  await call(f, 'post', `/credit-lines/${l._id}/statements`, {
    ...input,
    revision: changed.revision + 1,
  }).expect(409);
  await call(f, 'patch', `/credit-statements/${s._id}/official`, {
    officialMinimumMinor: 3000,
    officialInterestFreeMinor: 100000,
    revision: s.revision,
    calculation: { estimatedMinimumMinor: 0 },
  }).expect(422);
  const official = (
    await call(f, 'patch', `/credit-statements/${s._id}/official`, {
      officialMinimumMinor: 3000,
      officialInterestFreeMinor: 100000,
      revision: s.revision,
    }).expect(200)
  ).body;
  assert.equal(official.calculation.estimatedMinimumMinor, 6250);
  assert.equal(official.officialMinimumMinor, 3000);
  const beforePayment = new Date().toISOString();
  const paid = (
    await call(f, 'post', `/debts/${debt._id}/payments`, {
      walletId: w._id,
      amountMinor: 5000,
      revision: debt.revision,
    }).expect(201)
  ).body;
  const withPay = (await call(f, 'get', `/credit-statements/${s._id}`).expect(200)).body;
  assert.equal(withPay.paidMinor, 5000);
  assert.equal(withPay.payments[0].debtPaymentId, paid.payment._id);
  const lineNow = (await call(f, 'get', `/credit-lines/${l._id}`).expect(200)).body;
  await call(f, 'post', `/credit-lines/${l._id}/statements`, {
    periodStartOn: '2026-10-01',
    cutoffOn: '2026-10-20',
    dueOn: '2026-11-10',
    revolvingMinor: 95000,
    revision: lineNow.revision,
  }).expect(201);
  const all = (await call(f, 'get', '/credit-statements').expect(200)).body.data;
  assert.equal(
    all.reduce((n, p) => n + p.paidMinor, 0),
    5000,
  );
  assert.equal(all.find((p) => p.cutoffOn === '2026-10-20').paidMinor, 5000);
  assert.equal(all.find((p) => p._id === s._id).paidMinor, 0);
  const historical = (
    await call(
      f,
      'get',
      `/history?collection=creditStatements&at=${encodeURIComponent(beforePayment)}`,
    ).expect(200)
  ).body.data;
  assert.equal(historical[0].paidMinor, 0);
  assert.equal(historical[0].officialMinimumMinor, 3000);
  const summary = (await call(f, 'get', '/summary').expect(200)).body;
  assert.equal(summary.wallets[0].balanceMinor, 295000);
  const other = await fixture();
  await call(other, 'get', `/credit-statements/${s._id}`).expect(404);
  await call(f, 'patch', `/credit-statements/${s._id}/official`, {
    officialMinimumMinor: 0,
    officialInterestFreeMinor: 0,
    revision: official.revision,
  }).expect(409);
});

test('Personalización por usuario y negocio: viewer, conflictos, auditoría y filtros validados', async () => {
  const f = await fixture(),
    viewer = await user(),
    outsider = await user();
  const w = await wallet(f, 10000);
  const member = (
    await call(f, 'post', '/members', { email: viewer.email, role: 'viewer' }).expect(201)
  ).body;
  const v = { ...f, token: viewer.token };
  const widget = {
    id: randomUUID(),
    title: 'Compras de la tarjeta',
    columns: 12,
    height: 400,
    color: '#8262a5',
    type: 'chart',
    preset: 'creditPurchases',
    accounts: [],
    periodMode: 'custom',
    from: '2026-10-01',
    to: '2026-10-21',
    category: '',
    limit: 8,
    size: 'wide',
  };
  const preferences = { version: 1, walletOrder: [w._id], creditOrder: [], widgets: [widget] };
  const first = (await call(v, 'put', '/preferences', { revision: 0, preferences }).expect(200))
    .body;
  assert.equal(first.preferencesRevision, 1);
  assert.deepEqual(first.uiPreferences, preferences);
  assert.equal(
    (await call(v, 'put', '/preferences', { revision: 0, preferences }).expect(200)).body
      .preferencesRevision,
    1,
  );
  assert.equal((await call(f, 'get', '').expect(200)).body.uiPreferences, null);
  const snapshot = (await call(v, 'get', '/snapshot?collections=wallets').expect(200)).body;
  assert.deepEqual(snapshot.business.uiPreferences, preferences);
  assert.equal(snapshot.collections.wallets.data[0].balanceMinor, 10000);
  assert.equal(
    (await call(f, 'get', '/members').expect(200)).body.find((x) => x._id === member._id)
      .uiPreferences,
    undefined,
  );
  await call(v, 'put', '/preferences', {
    revision: 0,
    preferences: { ...preferences, widgets: [] },
  }).expect(409);
  await call({ ...f, token: outsider.token }, 'put', '/preferences', {
    revision: 0,
    preferences,
  }).expect(404);
  await call(v, 'post', '/movements', {
    walletId: w._id,
    kind: 'expense',
    amountMinor: 1,
    category: 'x',
  }).expect(403);
  for (const bad of [
    { ...preferences, walletOrder: [w._id, w._id] },
    { ...preferences, widgets: [widget, widget] },
    { ...preferences, widgets: [{ ...widget, to: '2026-09-01' }] },
    { ...preferences, widgets: [{ ...widget, preset: 'sql' }] },
    ...[
      { columns: 13 },
      { columns: 3.5 },
      { height: 219 },
      { height: 1201 },
      { color: '#fff' },
      { color: 'red;display:none' },
    ].map((change) => ({ ...preferences, widgets: [{ ...widget, ...change }] })),
    { ...preferences, userId: outsider.id },
    {
      ...preferences,
      widgets: Array.from({ length: 25 }, () => ({ ...widget, id: randomUUID() })),
    },
  ])
    await call(v, 'put', '/preferences', { revision: 1, preferences: bad }).expect(422);
  const audit = await db
    .collection('audit')
    .findOne({ businessId: f.business._id, action: 'preferences.updated' });
  assert.equal(audit.actorId, viewer.id);
  const second = await fixture();
  assert.equal((await call(second, 'get', '').expect(200)).body.uiPreferences, null);
  const latestMember = await db.collection('memberships').findOne({ _id: member._id });
  await call(f, 'patch', `/members/${member._id}`, {
    revision: latestMember.revision,
    role: 'removed',
  }).expect(200);
  await call(v, 'put', '/preferences', { revision: 1, preferences }).expect(404);
});
