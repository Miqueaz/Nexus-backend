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
import { createMongoAuthLimiter } from '../../src/adapters/mongo/auth-rate-limit.js';
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
          // Sin bindings ni namespaces DO: todas las pruebas deben pasar por el Worker directo.
          configPath: './test/workers/fixtures/direct.wrangler.jsonc',
          vars: {
            ...JSON.parse(
              readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8').replace(
                /,\s*([}\]])/g,
                '$1',
              ),
            ).vars,
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
async function fixture(ip = '192.0.2.10') {
  const session = await call(
    'POST',
    '/api/v1/auth/register',
    {
      name: 'Workers',
      email: randomUUID() + '@example.com',
      password: 'UnaClaveLarga123!',
    },
    undefined,
    undefined,
    ip,
  );
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
});
test('Worker directo prepara una base nueva desde solicitudes concurrentes sin borrar datos existentes', async () => {
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
test('Worker directo valida JSON y tamaño de cuerpos después de aplicar el límite de acceso', async () => {
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
test('Workerd ejecuta scrypt, Bearer JWT, MongoDB, aislamiento y revocación', async () => {
  const f = await fixture();
  const me = await call('GET', '/api/v1/auth/me', undefined, f.token);
  assert.equal(me.status, 200, JSON.stringify(me.data));
  const login = await call(
    'POST',
    '/api/v1/auth/login',
    {
      email: me.data.email,
      password: 'UnaClaveLarga123!',
    },
    undefined,
    undefined,
    '192.0.2.75',
  );
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(
    (await call('GET', '/api/v1/auth/me', undefined, login.data.accessToken)).data._id,
    me.data._id,
  );
  const wrong = await call(
    'POST',
    '/api/v1/auth/login',
    {
      email: me.data.email,
      password: 'OtraClaveLarga123!',
    },
    undefined,
    undefined,
    '192.0.2.75',
  );
  assert.equal(wrong.status, 401);
  const missing = await call(
    'POST',
    '/api/v1/auth/login',
    {
      email: 'missing@example.invalid',
      password: 'OtraClaveLarga123!',
    },
    undefined,
    undefined,
    '192.0.2.75',
  );
  assert.equal(missing.status, 401);

  const stranger = await fixture();
  assert.equal((await call('GET', f.base + '/wallets', undefined, stranger.token)).status, 404);
  assert.equal((await call('POST', '/api/v1/auth/logout', undefined, f.token)).status, 200);
  assert.equal((await call('GET', '/api/v1/auth/me', undefined, f.token)).status, 401);
});
test('Workerd libera conexiones Mongo en reposo y reconecta en la siguiente solicitud', async () => {
  const connections = async () => {
    const rows = await client
      .db('admin')
      .aggregate([
        { $currentOp: { allUsers: true, idleConnections: true } },
        { $match: { 'clientMetadata.application.name': 'nexo-workers' } },
        { $count: 'count' },
      ])
      .toArray();
    return rows[0]?.count ?? 0;
  };
  assert.equal(await connections(), 0);
  for (let i = 0; i < 2; i++) {
    let finished = false,
      sawConnection = false;
    const request = call('GET', '/health/ready').finally(() => {
      finished = true;
    });
    while (!finished) {
      sawConnection ||= (await connections()) > 0;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const ready = await request;
    assert.equal(ready.status, 200, JSON.stringify(ready.data));
    assert.ok(sawConnection, 'se observó la conexión TCP del Worker en Mongo');
    // El servidor puede procesar el FIN después de que close() resuelva en workerd.
    let current;
    for (let retry = 0; retry < 50; retry++) {
      current = await connections();
      if (!current) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(current, 0, 'no quedan conexiones del Worker en reposo');
  }
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
test('MongoDB limita login/registro antes de procesar credenciales', async () => {
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

test('Mongo limita intentos concurrentes entre invocaciones y conserva el contador', async () => {
  const ip = '192.0.2.88';
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      call('POST', '/api/v1/auth/login', {}, undefined, undefined, ip),
    ),
  );
  assert.equal(results.filter((r) => r.status === 422).length, 15);
  assert.equal(results.filter((r) => r.status === 429).length, 5);
  const records = await db.collection('authRateLimits').find({ count: 20 }).toArray();
  assert.equal(records.length, 1);
  assert.ok(records[0].expiresAt instanceof Date);
  assert.ok(!JSON.stringify(records[0]).includes(ip));
  assert.equal(
    (await call('POST', '/api/v1/auth/register', {}, undefined, undefined, ip)).status,
    429,
  );
  assert.equal(
    (await call('POST', '/api/v1/auth/login', {}, undefined, undefined, '192.0.2.89')).status,
    422,
  );
  const indexes = await db.collection('authRateLimits').listIndexes().toArray();
  assert.ok(indexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
});
test('El contador usa ventanas nuevas aunque Mongo todavía conserve la fila vencida', async () => {
  const start = Math.floor(Date.now() / 900000) * 900000;
  let time = start + 899999;
  const consume = createMongoAuthLimiter(db, { now: () => time });
  const request = new Request('https://api.example.com', {
    headers: { 'CF-Connecting-IP': '192.0.2.87' },
  });
  assert.deepEqual(await consume(request), { count: 1, retryAfter: 1 });
  assert.equal((await consume(request)).count, 2);
  time++;
  assert.deepEqual(await consume(request), { count: 1, retryAfter: 900 });
});
test('Workers exige índices de consistencia antes de operar una base nueva', async () => {
  const empty = client.db(db.databaseName + '_unprepared');
  await assert.rejects(assertDatabasePrepared(empty), { code: 'DATABASE_NOT_PREPARED' });
  await ensureIndexes(empty);
  await assertDatabasePrepared(empty);
  await empty.dropDatabase();
});
test('Readiness forces a complete index check even after ordinary requests warm the preparation cache', async () => {
  assert.equal((await call('GET', '/api/v1/auth/options')).status, 200);
  const users = db.collection('users');
  const indexes = await users.listIndexes().toArray();
  const uniqueEmail = indexes.find((index) => index.unique && index.key.email === 1);
  assert.ok(uniqueEmail);
  await users.dropIndex(uniqueEmail.name);
  // The test Worker enables auto-migration: readiness must detect and repair the missing index.
  const ready = await call('GET', '/health/ready');
  assert.equal(ready.status, 200, JSON.stringify(ready.data));
  assert.ok(
    (await users.listIndexes().toArray()).some((index) => index.unique && index.key.email === 1),
  );
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
  r = await call(
    'PATCH',
    f.base + '/credit-lines/' + line.data._id,
    { name: 'Cambio', limitMinor: 2000, paymentDueOn: '2027-01-10', revision: 2 },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.name, 'Cambio');
  const editedRevision = r.data.revision;
  r = await call(
    'PATCH',
    f.base + '/credit-lines/' + line.data._id,
    { limitMinor: 100, revision: editedRevision },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 422, JSON.stringify(r.data));
  r = await call(
    'PATCH',
    f.base + '/credit-lines/' + line.data._id,
    { archived: true, revision: editedRevision },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, 'CREDIT_LINE_HAS_DEBT');
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

test('Workerd guarda preferencias personales, sirve snapshot y rechaza configuración inválida', async () => {
  const f = await fixture();
  const preferences = {
    version: 1,
    walletOrder: [],
    creditOrder: [],
    widgets: [
      {
        id: randomUUID(),
        title: 'Mi crédito',
        columns: 12,
        height: 400,
        color: '#8262a5',
        type: 'metric',
        preset: 'debt',
        accounts: [],
        category: '',
        periodMode: 'global',
        size: 'normal',
        limit: 8,
      },
    ],
  };
  const r = await call('PUT', f.base + '/preferences', { revision: 0, preferences }, f.token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.preferencesRevision, 1);
  const snapshot = await call('GET', f.base + '/snapshot?collections=wallets', undefined, f.token);
  assert.deepEqual(snapshot.data.business.uiPreferences, preferences);
  const other = await fixture();
  assert.equal((await call('GET', other.base, undefined, other.token)).data.uiPreferences, null);
  assert.equal(
    (await call('PUT', f.base + '/preferences', { revision: 0, preferences }, other.token)).status,
    404,
  );
  assert.equal(
    (
      await call(
        'PUT',
        f.base + '/preferences',
        {
          revision: 1,
          preferences: {
            ...preferences,
            widgets: [{ ...preferences.widgets[0], preset: 'unknown' }],
          },
        },
        f.token,
      )
    ).status,
    422,
  );
});

test('Workerd guarda documentos y trazos con Bearer, revisiones y metadatos livianos', async () => {
  const f = await fixture();
  const body = {
    title: 'Pizarrón Workers',
    kind: 'board',
    elements: [
      {
        id: randomUUID(),
        type: 'pen',
        x: 10,
        y: 20,
        points: [
          [0, 0],
          [15, 20],
          [40, 5],
        ],
      },
    ],
  };
  const key = randomUUID();
  let r = await call('POST', f.base + '/docs', body, f.token, key);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const created = r.data;
  assert.equal((await call('POST', f.base + '/docs', body, f.token, key)).data._id, created._id);
  r = await call('GET', f.base + '/docs', undefined, f.token);
  assert.equal(r.status, 200);
  assert.equal(r.data.data.length, 1);
  assert.equal(r.data.data[0].elements, undefined);
  r = await call('GET', f.base + '/docs/' + created._id, undefined, f.token);
  assert.equal(r.data.elements[0].points.length, 3);
  r = await call(
    'PATCH',
    f.base + '/docs/' + created._id,
    { archived: true, revision: 1 },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 200);
  r = await call('GET', f.base + '/docs', undefined, f.token);
  assert.equal(r.data.data.length, 0);
  assert.equal((await call('GET', f.base + '/docs/' + created._id)).status, 401);
});

test('Workerd persists official Excalidraw scenes above 256KB only on Docs routes', async () => {
  const f = await fixture();
  const scene = JSON.parse(
    readFileSync(new URL('../fixtures/excalidraw-scene.json', import.meta.url), 'utf8'),
  );
  const text = scene.elements.find((e) => e.type === 'text');
  const large = {
    ...scene,
    elements: Array.from({ length: 10 }, () => ({
      ...text,
      id: randomUUID(),
      containerId: null,
      text: 'x'.repeat(20000),
      originalText: 'x'.repeat(20000),
    })),
  };
  const body = { title: 'Official scene', kind: 'board', board: large };
  assert.ok(JSON.stringify(body).length > 256 * 1024);
  const r = await call('POST', f.base + '/docs', body, f.token, randomUUID());
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.board.elements.length, 10);
  const listing = await call('GET', f.base + '/docs', undefined, f.token);
  assert.equal(listing.data.data[0].board, undefined);
  const unauthorized = await call('GET', f.base + '/docs/' + r.data._id);
  assert.equal(unauthorized.status, 401);
  const tooLarge = await call('POST', f.base + '/movements', body, f.token, randomUUID());
  assert.equal(tooLarge.status, 413);
});

test('Workerd applies compact Docs saves with revisions and small idempotent acknowledgements', async () => {
  const f = await fixture('192.0.2.111');
  let r = await call(
    'POST',
    f.base + '/docs',
    { title: 'Compact board', kind: 'board' },
    f.token,
    randomUUID(),
  );
  assert.equal(r.status, 201);
  const id = r.data._id,
    key = randomUUID(),
    payload = { revision: 1, changes: { title: 'Batched board' } };
  const first = await call('PATCH', f.base + '/docs/' + id + '/save', payload, f.token, key);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.revision, 2);
  assert.equal(first.data.board, undefined);
  assert.ok(JSON.stringify(first.data).length < 200);
  const retry = await call('PATCH', f.base + '/docs/' + id + '/save', payload, f.token, key);
  assert.deepEqual(retry.data, first.data);
  assert.equal(
    (await call('PATCH', f.base + '/docs/' + id + '/save', payload, f.token, randomUUID())).status,
    409,
  );
  assert.equal(
    (await call('GET', f.base + '/docs/' + id, undefined, f.token)).data.title,
    'Batched board',
  );
});

test('Workerd enforces organization roles, module isolation and revocation without Durable Objects', async () => {
  const owner = await fixture('192.0.2.35');
  const email = randomUUID() + '@example.com';
  const registered = await call(
    'POST',
    '/api/v1/auth/register',
    { name: 'Miembro', email, password: 'UnaClaveLarga123!' },
    undefined,
    undefined,
    '192.0.2.36',
  );
  assert.equal(registered.status, 201);
  const token = registered.data.accessToken;
  const org = await call(
    'POST',
    '/api/v1/organizations',
    { name: 'Equipo Workers' },
    owner.token,
    randomUUID(),
  );
  assert.equal(org.status, 201, JSON.stringify(org.data));
  const base = '/api/v1/organizations/' + org.data._id;
  const b = await call('GET', owner.base, undefined, owner.token);
  assert.equal(
    (
      await call(
        'PUT',
        base + '/spaces/' + owner.businessId,
        { revision: b.data.revision },
        owner.token,
        randomUUID(),
      )
    ).status,
    200,
  );
  const member = await call('POST', base + '/members', { email }, owner.token, randomUUID());
  assert.equal(member.status, 201);
  const role = await call(
    'POST',
    base + '/roles',
    { name: 'Notas lector', permissions: { docs: 'read' } },
    owner.token,
    randomUUID(),
  );
  assert.equal(role.status, 201, JSON.stringify(role.data));
  assert.equal(
    (
      await call(
        'PUT',
        base + '/spaces/' + owner.businessId + '/grants/' + member.data._id,
        { revision: 0, roleId: role.data._id },
        owner.token,
        randomUUID(),
      )
    ).status,
    200,
  );
  assert.equal((await call('GET', owner.base + '/docs', undefined, token)).status, 200);
  assert.equal((await call('GET', owner.base + '/wallets', undefined, token)).status, 403);
  assert.equal(
    (
      await call(
        'POST',
        owner.base + '/docs',
        { title: 'No autorizado', kind: 'document' },
        token,
        randomUUID(),
      )
    ).status,
    403,
  );
  const snap = await call('GET', owner.base + '/snapshot', undefined, token);
  assert.equal(snap.status, 200);
  assert.deepEqual(snap.data.collections.wallets.data, []);
  assert.equal(
    (
      await call(
        'PATCH',
        base + '/members/' + member.data._id,
        { revision: member.data.revision, state: 'removed' },
        owner.token,
        randomUUID(),
      )
    ).status,
    200,
  );
  assert.equal((await call('GET', owner.base + '/docs', undefined, token)).status, 404);
});

test('Workerd protects administration and applies registration and module settings globally without Durable Objects', async () => {
  const owner = await fixture('192.0.2.45');
  assert.equal(
    (await call('GET', '/api/v1/administration/settings', undefined, owner.token)).status,
    403,
  );
  const me = await call('GET', '/api/v1/auth/me', undefined, owner.token);
  // Trusted fixture setup simulates an identity already verified by the Google adapter.
  await db
    .collection('users')
    .updateOne(
      { _id: me.data._id },
      { $set: { googleSub: randomUUID(), googleEmail: 'mik.isaac.gl@gmail.com' } },
    );
  assert.equal(
    (await call('GET', '/api/v1/auth/me', undefined, owner.token)).data.platformRole,
    'admin',
  );
  const initial = await call('GET', '/api/v1/administration/settings', undefined, owner.token);
  assert.equal(initial.status, 200);
  const { revision, registration, login, features, enabledModules } = initial.data;
  const changed = {
    revision,
    registration: { ...registration, portal: false },
    login,
    features,
    enabledModules: enabledModules.filter((id) => !['finance', 'sales'].includes(id)),
  };
  const saved = await call(
    'PATCH',
    '/api/v1/administration/settings',
    changed,
    owner.token,
    randomUUID(),
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(
    (
      await call(
        'POST',
        '/api/v1/auth/register',
        { name: 'Blocked', email: randomUUID() + '@example.test', password: 'UnaClaveLarga123!' },
        undefined,
        undefined,
        '192.0.2.46',
      )
    ).status,
    403,
  );
  assert.equal((await call('GET', owner.base + '/wallets', undefined, owner.token)).status, 403);
  const snapshot = await call('GET', owner.base + '/snapshot', undefined, owner.token);
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.data.collections.wallets.data, []);
  const options = await call('GET', '/api/v1/auth/options');
  assert.equal(options.data.registration.portal, false);
  assert.equal(options.data.login.password, true);
  assert.equal(
    (
      await call(
        'PATCH',
        '/api/v1/administration/settings',
        { revision: saved.data.revision, registration, login, features, enabledModules },
        owner.token,
        randomUUID(),
      )
    ).status,
    200,
  );
});

test('Workerd stores scheduled payments without spending and confirms them once with a chosen wallet', async () => {
  const f = await fixture(),
    startOn = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const wallet = await call(
    'POST',
    f.base + '/wallets',
    { name: 'Compromisos', openingBalanceMinor: 1000 },
    f.token,
    randomUUID(),
  );
  assert.equal(wallet.status, 201);
  const plan = await call(
    'POST',
    f.base + '/commitments',
    {
      name: 'Gym',
      amountMinor: 100,
      startOn,
      frequency: 'monthly',
      preferredWalletId: wallet.data._id,
    },
    f.token,
    randomUUID(),
  );
  assert.equal(plan.status, 201, JSON.stringify(plan.data));
  let w = await call('GET', f.base + '/wallets/' + wallet.data._id, undefined, f.token);
  assert.equal(w.data.balanceMinor, 1000);
  const key = randomUUID(),
    body = { dueOn: startOn, decision: 'paid', walletId: wallet.data._id, revision: 1 };
  const paid = await call(
    'POST',
    f.base + '/commitments/' + plan.data._id + '/resolve',
    body,
    f.token,
    key,
  );
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  const replay = await call(
    'POST',
    f.base + '/commitments/' + plan.data._id + '/resolve',
    body,
    f.token,
    key,
  );
  assert.equal(replay.data.movement._id, paid.data.movement._id);
  w = await call('GET', f.base + '/wallets/' + wallet.data._id, undefined, f.token);
  assert.equal(w.data.balanceMinor, 900);
  const snapshot = await call(
    'GET',
    f.base + '/snapshot?collections=commitments,commitment-resolutions',
    undefined,
    f.token,
  );
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.collections['commitment-resolutions'].data.length, 1);
});
