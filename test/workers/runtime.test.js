import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
    await ensureIndexes(db);
    server = createTestHarness({
      workers: [
        {
          configPath: './wrangler.jsonc',
          vars: { MONGO_DB: db.databaseName, LOG_LEVEL: 'silent' },
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
