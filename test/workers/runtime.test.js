import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createTestHarness } from 'wrangler';
import { ensureIndexes, assertDatabasePrepared } from '../../src/adapters/mongo/database.js';
let rs, client, db, dataDir, server, worker;
before(
  async () => {
    dataDir = await mkdtemp(join(process.env.TEST_TMP_ROOT ?? tmpdir(), 'nexo-workers-'));
    rs = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [
        { dbPath: dataDir, args: ['--nounixsocket', '--wiredTigerCacheSizeGB', '0.25'] },
      ],
      binary: { version: '8.0.16' },
    });
    client = await new MongoClient(rs.getUri()).connect();
    db = client.db('nexo_workers_' + randomUUID().replaceAll('-', ''));
    server = createTestHarness({
      workers: [
        {
          configPath: './wrangler.jsonc',
          vars: {
            MONGO_DB: db.databaseName,
            MONGO_AUTO_MIGRATE: 'true',
            LOG_LEVEL: 'silent',
            // Read the tracked production origins; ignored .dev.vars is local-only.
            CORS_ORIGINS: /"CORS_ORIGINS":\s*"([^"]+)"/.exec(
              readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'),
            )[1],
          },
          secrets: { MONGO_URI: rs.getUri(), JWT_SECRET: 'workers-test-secret-'.repeat(6) },
        },
      ],
    });
    await server.listen();
    worker = server.getWorker();
  },
  { timeout: 180000 },
);
after(async () => {
  await server?.close();
  if (db) await db.dropDatabase();
  await client?.close();
  await rs?.stop();
  if (dataDir) await rm(dataDir, { force: true, recursive: true });
});
async function call(method, path, body, token, key, ip = '192.0.2.10') {
  const r = await worker.fetch('https://api.example.com' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  return { status: r.status, headers: r.headers, data };
}
async function fixture() {
  const session = await call('POST', '/api/v1/auth/register', {
    name: 'Workers',
    email: randomUUID() + '@example.com',
    password: 'UnaClaveLarga123!',
  });
  assert.equal(session.status, 201, JSON.stringify(session.data));
  const token = session.data.accessToken;
  const b = await call('POST', '/api/v1/businesses', { name: 'Workers', currency: 'MXN' }, token);
  assert.equal(b.status, 201, JSON.stringify(b.data));
  return { token, base: '/api/v1/businesses/' + b.data._id, businessId: b.data._id };
}
test('Workerd inicia el bundle, aplica CORS y rechaza JSON/cuerpos inválidos sin Mongo', async () => {
  let r = await call('GET', '/health/live');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.ok(r.headers.get('X-Request-Id'));
  const cors = await worker.fetch('https://api.example.com/api/v1/auth/register', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(cors.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  const productionCors = await worker.fetch(
    'https://api.example.com/api/v1/businesses/test/credit-lines/test/payments',
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://nexo.aethel.ing',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
      },
    },
  );
  assert.equal(productionCors.status, 204);
  assert.equal(
    productionCors.headers.get('Access-Control-Allow-Origin'),
    'https://nexo.aethel.ing',
  );
  assert.match(productionCors.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  const deniedCors = await worker.fetch('https://api.example.com/api/v1/auth/login', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://nexo.aethel.ing.evil.test',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.notEqual(
    deniedCors.headers.get('Access-Control-Allow-Origin'),
    'https://nexo.aethel.ing.evil.test',
  );

  const invalid = await worker.fetch('https://api.example.com/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.11' },
    body: '{',
  });
  assert.equal(invalid.status, 400);
  const oversized = await call(
    'POST',
    '/api/v1/auth/register',
    { notes: 'x'.repeat(270000) },
    undefined,
    undefined,
    '192.0.2.11',
  );
  assert.equal(oversized.status, 413);
});
test('Workerd prepara una base nueva desde varios objetos sin borrar datos existentes', async () => {
  assert.equal((await db.listCollections().toArray()).length, 0);
  await db.collection('bootstrapSentinel').insertOne({ _id: 'existing', value: 'conservar' });
  const [ready, unauthorized] = await Promise.all([
    call('GET', '/health/ready'),
    call('GET', '/api/v1/businesses/11111111-1111-4111-8111-111111111111/wallets'),
  ]);
  assert.equal(ready.status, 200, JSON.stringify(ready.data));
  assert.equal(unauthorized.status, 401, JSON.stringify(unauthorized.data));
  await assertDatabasePrepared(db);
  assert.equal(
    (await db.collection('bootstrapSentinel').findOne({ _id: 'existing' })).value,
    'conservar',
  );
  const indexes = await db.collection('sessions').listIndexes().toArray();
  assert.ok(indexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
});
test('Workerd ejecuta scrypt, Bearer JWT, MongoDB, aislamiento y revocación', async () => {
  const f = await fixture();
  const me = await call('GET', '/api/v1/auth/me', undefined, f.token);
  assert.equal(me.status, 200, JSON.stringify(me.data));
  const stranger = await fixture();
  assert.equal((await call('GET', f.base + '/wallets', undefined, stranger.token)).status, 404);
  assert.equal((await call('POST', '/api/v1/auth/logout', undefined, f.token)).status, 200);
  assert.equal((await call('GET', '/api/v1/auth/me', undefined, f.token)).status, 401);
});
test('Worker mantiene ventas, idempotencia, rollback, historial y auditoría atómicos', async () => {
  const f = await fixture();
  const w = await call(
    'POST',
    f.base + '/wallets',
    { name: 'Caja', openingBalanceMinor: 100000 },
    f.token,
    randomUUID(),
  );
  assert.equal(w.status, 201, JSON.stringify(w.data));
  const list = await call('POST', f.base + '/inventory-lists', { name: 'Recursos' }, f.token);
  const item = await call(
    'POST',
    f.base + '/items',
    { name: 'Producto', listIds: [list.data._id], priceMinor: 1000, costMinor: 400 },
    f.token,
  );
  assert.equal(item.status, 201, JSON.stringify(item.data));
  assert.equal(
    (
      await call(
        'POST',
        f.base + '/items/' + item.data._id + '/adjustments',
        { deltaMilli: 1000, reason: 'Inicial', revision: 1 },
        f.token,
        randomUUID(),
      )
    ).status,
    201,
  );
  const at = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const key = randomUUID(),
    payload = {
      walletId: w.data._id,
      lines: [{ itemId: item.data._id, quantityMilli: 1000 }],
      discount: { type: 'percent', value: 1000, reason: 'Promoción' },
    };
  const sale = await call('POST', f.base + '/sales', payload, f.token, key);
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  assert.equal(sale.data.totalMinor, 900);
  const replay = await call('POST', f.base + '/sales', payload, f.token, key);
  assert.equal(replay.data._id, sale.data._id);
  assert.equal((await call('POST', f.base + '/sales', payload, f.token, randomUUID())).status, 422);
  const history = await call(
    'GET',
    f.base + '/history?collection=wallets&at=' + encodeURIComponent(at),
    undefined,
    f.token,
  );
  assert.equal(history.data.data[0].balanceMinor, 100000);
  const current = await call('GET', f.base + '/wallets/' + w.data._id, undefined, f.token);
  assert.equal(current.data.balanceMinor, 100900);
  const audits = await db
    .collection('audit')
    .find({ businessId: f.businessId, action: 'sale.created' })
    .toArray();
  assert.equal(audits.length, 5);
  assert.equal(await db.collection('sales').countDocuments({ businessId: f.businessId }), 1);
});
test('Workerd guarda y edita los campos de tarjeta sin alterar su cupo', async () => {
  const f = await fixture();
  const created = await call(
    'POST',
    f.base + '/credit-lines',
    {
      name: 'Tarjeta',
      limitMinor: 500000,
      statementCutoffOn: '2026-10-20',
      paymentDueOn: '2026-11-10',
      minimumPaymentMinor: 15000,
      interestFreePaymentMinor: 200000,
      annualInterestBps: 6590,
    },
    f.token,
    randomUUID(),
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const updated = await call(
    'PATCH',
    f.base + '/credit-lines/' + created.data._id,
    {
      minimumPaymentMinor: 0,
      revision: created.data.revision,
    },
    f.token,
    randomUUID(),
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.annualInterestBps, 6590);
  assert.equal(updated.data.paymentDueOn, '2026-11-10');
  assert.equal(updated.data.minimumPaymentMinor, 0);
  assert.equal(updated.data.limitMinor, 500000);
});
test('Durable Object limita login/registro antes de procesar credenciales', async () => {
  for (let i = 0; i < 15; i++) {
    const r = await worker.fetch('https://api.example.com/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.99' },
      body: '{',
    });
    assert.equal(r.status, 400);
  }
  const r = await call('POST', '/api/v1/auth/register', {}, undefined, undefined, '192.0.2.99');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('Retry-After')) > 0);
  assert.equal(r.data.error.code, 'RATE_LIMIT');
});

test('Workers exige índices de consistencia antes de operar una base nueva', async () => {
  const empty = client.db(db.databaseName + '_unprepared');
  await assert.rejects(assertDatabasePrepared(empty), { code: 'DATABASE_NOT_PREPARED' });
  await ensureIndexes(empty);
  await assertDatabasePrepared(empty);
  await empty.dropDatabase();
});
test('Dos ventas concurrentes en Workerd no consumen las mismas existencias', async () => {
  const f = await fixture();
  const w = await call(
    'POST',
    f.base + '/wallets',
    { name: 'Caja', openingBalanceMinor: 0 },
    f.token,
    randomUUID(),
  );
  const list = await call('POST', f.base + '/inventory-lists', { name: 'Stock' }, f.token);
  const item = await call(
    'POST',
    f.base + '/items',
    { name: 'Único', listIds: [list.data._id], priceMinor: 1000 },
    f.token,
  );
  await call(
    'POST',
    f.base + '/items/' + item.data._id + '/adjustments',
    { deltaMilli: 1000, reason: 'Inicial', revision: 1 },
    f.token,
    randomUUID(),
  );
  const payload = { walletId: w.data._id, lines: [{ itemId: item.data._id, quantityMilli: 1000 }] };
  const results = await Promise.all([
    call('POST', f.base + '/sales', payload, f.token, randomUUID()),
    call('POST', f.base + '/sales', payload, f.token, randomUUID()),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 422]);
  assert.equal(await db.collection('sales').countDocuments({ businessId: f.businessId }), 1);
});

test('Workerd protege edición y eliminación con saldo/deuda y conserva el borrado lógico', async () => {
  const f = await fixture();
  const w = await call(
    'POST',
    f.base + '/wallets',
    { name: 'Cuenta', openingBalanceMinor: 100 },
    f.token,
    randomUUID(),
  );
  let r = await call(
    'PATCH',
    f.base + '/wallets/' + w.data._id,
    { archived: true, revision: w.data.revision },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, 'WALLET_HAS_BALANCE');
  await call(
    'POST',
    f.base + '/movements',
    { walletId: w.data._id, kind: 'expense', amountMinor: 100, category: 'Cierre' },
    f.token,
    randomUUID(),
  );
  r = await call('GET', f.base + '/wallets/' + w.data._id, undefined, f.token);
  r = await call(
    'PATCH',
    f.base + '/wallets/' + w.data._id,
    { name: 'Renombrada', kind: 'cash', archived: true, revision: r.data.revision },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.archived, true);
  const line = await call(
    'POST',
    f.base + '/credit-lines',
    { name: 'Línea', limitMinor: 1000 },
    f.token,
    randomUUID(),
  );
  const debt = await call(
    'POST',
    f.base + '/debts',
    {
      name: 'Compra',
      kind: 'deferred',
      creditLineId: line.data._id,
      principalMinor: 100,
      feeMinor: 1,
      terms: 1,
      firstDueOn: '2027-01-01',
    },
    f.token,
    randomUUID(),
  );
  assert.equal(debt.status, 201, JSON.stringify(debt.data));
  for (const patch of [{ archived: true }, { name: 'Cambio' }, { limitMinor: 2000 }]) {
    r = await call(
      'PATCH',
      f.base + '/credit-lines/' + line.data._id,
      { ...patch, revision: 2 },
      f.token,
      randomUUID(),
    );
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.error.code, 'CREDIT_LINE_HAS_DEBT');
  }
  const empty = await call(
    'POST',
    f.base + '/credit-lines',
    { name: 'Sin deuda', limitMinor: 1000 },
    f.token,
    randomUUID(),
  );
  r = await call(
    'PATCH',
    f.base + '/credit-lines/' + empty.data._id,
    { limitMinor: 2000, revision: 1 },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call(
    'PATCH',
    f.base + '/credit-lines/' + empty.data._id,
    { archived: true, revision: r.data.revision },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.archived, true);
});

test('Workerd actualiza identidad/módulos solo por propietario y protege los módulos desactivados', async () => {
  const f = await fixture();
  let r = await call('GET', f.base, undefined, f.token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.role, 'owner');
  r = await call(
    'PATCH',
    f.base,
    {
      name: 'Estudio',
      kind: 'workspace',
      color: '#336699',
      enabledModules: ['projects'],
      revision: r.data.revision,
    },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.color, '#336699');
  const disabled = await call(
    'POST',
    f.base + '/wallets',
    { name: 'No crear' },
    f.token,
    randomUUID(),
  );
  assert.equal(disabled.status, 409, JSON.stringify(disabled.data));
  assert.equal(disabled.data.error.code, 'MODULE_DISABLED');
  const project = await call(
    'POST',
    f.base + '/projects',
    { name: 'Permitido' },
    f.token,
    randomUUID(),
  );
  assert.equal(project.status, 201, JSON.stringify(project.data));
  const meta = await call('GET', f.base, undefined, f.token);
  assert.deepEqual(meta.data.enabledModules, ['projects']);
  r = await call(
    'PATCH',
    f.base,
    { enabledModules: ['finance', 'projects'], revision: meta.data.revision },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const wallet = await call(
    'POST',
    f.base + '/wallets',
    { name: 'Reactivada' },
    f.token,
    randomUUID(),
  );
  assert.equal(wallet.status, 201, JSON.stringify(wallet.data));
});

test('Workerd registra compras y abono a una línea sin crear efectivo ni duplicar pagos', async () => {
  const f = await fixture();
  const w = await call(
    'POST',
    f.base + '/wallets',
    { name: 'Caja', openingBalanceMinor: 1000 },
    f.token,
    randomUUID(),
  );
  const line = await call(
    'POST',
    f.base + '/credit-lines',
    { name: 'Crédito', limitMinor: 1000 },
    f.token,
    randomUUID(),
  );
  const debt = await call(
    'POST',
    f.base + '/debts',
    {
      name: 'Compra',
      kind: 'deferred',
      creditLineId: line.data._id,
      principalMinor: 300,
      terms: 1,
      firstDueOn: '2027-01-01',
      category: 'Operación',
    },
    f.token,
    randomUUID(),
  );
  assert.equal(debt.status, 201, JSON.stringify(debt.data));
  let wallet = await call('GET', f.base + '/wallets/' + w.data._id, undefined, f.token);
  assert.equal(wallet.data.balanceMinor, 1000);
  const current = await call('GET', f.base + '/credit-lines/' + line.data._id, undefined, f.token);
  const key = randomUUID(),
    body = {
      walletId: w.data._id,
      amountMinor: 100,
      description: 'Abono',
      revision: current.data.revision,
    };
  const first = await call(
    'POST',
    f.base + '/credit-lines/' + line.data._id + '/payments',
    body,
    f.token,
    key,
  );
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const retry = await call(
    'POST',
    f.base + '/credit-lines/' + line.data._id + '/payments',
    body,
    f.token,
    key,
  );
  assert.equal(retry.status, 201, JSON.stringify(retry.data));
  wallet = await call('GET', f.base + '/wallets/' + w.data._id, undefined, f.token);
  assert.equal(wallet.data.balanceMinor, 900);
  const balances = await call('GET', f.base + '/credit-lines/balances', undefined, f.token);
  assert.equal(balances.data[0].usedMinor, 200);
  assert.equal(await db.collection('debtPayments').countDocuments({ businessId: f.businessId }), 1);
});

test('Workerd sirve snapshot agrupado con Bearer y conserva el aislamiento del negocio', async () => {
  const f = await fixture();
  const r = await call(
    'GET',
    f.base + '/snapshot?collections=wallets,credit-lines,debts',
    undefined,
    f.token,
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.business._id, f.businessId);
  assert.equal(r.data.business.role, 'owner');
  assert.deepEqual(Object.keys(r.data.collections), ['wallets', 'credit-lines', 'debts']);
  assert.equal((await call('GET', f.base + '/snapshot')).status, 401);
  const other = await fixture();
  assert.equal((await call('GET', f.base + '/snapshot', undefined, other.token)).status, 404);
  assert.equal(
    (await call('GET', f.base + '/snapshot?collections=sessions', undefined, f.token)).status,
    422,
  );
});

test('Workerd configura Google, guarda intentos con vencimiento y rechaza credenciales inválidas', async () => {
  const attempt = await call(
    'POST',
    '/api/v1/auth/google/challenge',
    {},
    undefined,
    undefined,
    '192.0.2.91',
  );
  assert.equal(attempt.status, 200, JSON.stringify(attempt.data));
  assert.equal(
    attempt.data.clientId,
    '259045388211-p4fk2jnqhm40t1tqa91da7ic1qbn76ak.apps.googleusercontent.com',
  );
  const stored = await db.collection('authChallenges').findOne({ _id: attempt.data.challengeId });
  assert.ok(stored.nonceHash);
  assert.equal(stored.nonce, undefined);
  assert.ok(stored.expiresAt > new Date());
  const invalid = await call(
    'POST',
    '/api/v1/auth/google',
    { challengeId: attempt.data.challengeId, credential: 'not-a-jwt' },
    undefined,
    undefined,
    '192.0.2.91',
  );
  assert.equal(invalid.status, 401, JSON.stringify(invalid.data));
  assert.equal(invalid.data.error.code, 'INVALID_GOOGLE_TOKEN');
  assert.equal(
    (
      await call(
        'POST',
        '/api/v1/auth/google/link/challenge',
        { password: 'UnaClaveLarga123!' },
        undefined,
        undefined,
        '192.0.2.91',
      )
    ).status,
    401,
  );
  const indexes = await db.collection('users').listIndexes().toArray();
  assert.ok(
    indexes.some(
      (index) =>
        index.key.googleSub === 1 &&
        index.unique &&
        index.partialFilterExpression.googleSub.$type === 'string',
    ),
  );
});

test('Workers calcula y guarda ambos mínimos con deuda sin alterar cartera ni cupo', async () => {
  const f = await fixture();
  const l = await call(
    'POST',
    f.base + '/credit-lines',
    { name: 'Mínimos Worker', limitMinor: 100000 },
    f.token,
  );
  const d = await call(
    'POST',
    f.base + '/debts',
    {
      name: 'Compra',
      kind: 'deferred',
      creditLineId: l.data._id,
      principalMinor: 10000,
      terms: 1,
      firstDueOn: '2027-01-10',
    },
    f.token,
    randomUUID(),
  );
  assert.equal(d.status, 201);
  const line = await call('GET', f.base + '/credit-lines/' + l.data._id, undefined, f.token);
  const body = {
    periodStartOn: '2026-09-01',
    cutoffOn: '2026-09-30',
    dueOn: '2026-10-10',
    revolvingMinor: 10000,
  };
  const preview = await call(
    'POST',
    f.base + '/credit-lines/' + l.data._id + '/statements/preview',
    body,
    f.token,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.data.estimatedMinimumMinor, 1250);
  const closed = await call(
    'POST',
    f.base + '/credit-lines/' + l.data._id + '/statements',
    { ...body, revision: line.data.revision },
    f.token,
    randomUUID(),
  );
  assert.equal(closed.status, 201);
  const official = await call(
    'PATCH',
    f.base + '/credit-statements/' + closed.data._id + '/official',
    { officialMinimumMinor: 0, officialInterestFreeMinor: 10000, revision: closed.data.revision },
    f.token,
  );
  assert.equal(official.status, 200);
  assert.equal(official.data.officialMinimumMinor, 0);
  assert.equal(official.data.calculation.estimatedMinimumMinor, 1250);
  const snapshot = await call(
    'GET',
    f.base + '/snapshot?collections=credit-statements',
    undefined,
    f.token,
  );
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.collections['credit-statements'].data.length, 1);
  const balances = await call('GET', f.base + '/credit-lines/balances', undefined, f.token);
  assert.equal(balances.data[0].usedMinor, 10000);
});
