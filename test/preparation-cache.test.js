import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparationCache } from '../src/adapters/mongo/preparation-cache.js';
import { assertDatabasePrepared } from '../src/adapters/mongo/database.js';

test('Warm requests skip all 13 index metadata reads while cold requests verify every constraint', async () => {
  const definitions = {
    commitmentResolutions: [{ key: { businessId: 1, commitmentId: 1, dueOn: 1 }, unique: true }],
    services: [{ key: { businessId: 1, createdAt: -1, _id: -1 } }],
    platformSettings: [{ key: { updatedAt: -1 } }],
    authRateLimits: [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
    documents: [{ key: { businessId: 1, updatedAt: -1, _id: -1 } }],
    organizationMembers: [{ key: { businessId: 1, userId: 1 }, unique: true }],
    creditStatements: [{ key: { businessId: 1, creditLineId: 1, cutoffOn: 1 }, unique: true }],
    users: [
      { key: { email: 1 }, unique: true },
      {
        key: { googleSub: 1 },
        unique: true,
        partialFilterExpression: { googleSub: { $type: 'string' } },
      },
    ],
    memberships: [{ key: { businessId: 1, userId: 1 }, unique: true }],
    idempotency: [{ key: { businessId: 1, key: 1 }, unique: true }],
    items: [
      {
        key: { businessId: 1, sku: 1 },
        unique: true,
        partialFilterExpression: { sku: { $type: 'string' } },
      },
    ],
    sales: [
      {
        key: { businessId: 1, quoteId: 1 },
        unique: true,
        partialFilterExpression: { quoteId: { $type: 'string' } },
      },
    ],
  };
  let reads = 0,
    time = 0;
  const db = {
    collection(name) {
      return {
        listIndexes() {
          reads++;
          return { toArray: async () => definitions[name] || [] };
        },
      };
    },
  };
  const cache = createPreparationCache({ now: () => time });
  const prepare = () => assertDatabasePrepared(db);
  assert.equal(await cache.check('database-a', prepare), false);
  assert.equal(reads, 13);
  for (let i = 0; i < 10; i++) assert.equal(await cache.check('database-a', prepare), true);
  assert.equal(reads, 13, 'ten warm requests add zero listIndexes commands');
  time = 300000;
  assert.equal(await cache.check('database-a', prepare), false);
  assert.equal(reads, 26);
  definitions.items = [];
  await assert.rejects(cache.check('database-a', prepare, { force: true }), {
    code: 'DATABASE_NOT_PREPARED',
  });
  await assert.rejects(cache.check('database-a', prepare), { code: 'DATABASE_NOT_PREPARED' });
});

test('Different databases are isolated; failed checks retry and entries are bounded', async () => {
  let calls = 0;
  const cache = createPreparationCache({ maxEntries: 2 });
  const prepare = async () => {
    calls++;
  };
  await cache.check('cluster-a/database', prepare);
  await cache.check('cluster-b/database', prepare);
  assert.equal(calls, 2);
  await cache.check('cluster-a/other-database', prepare);
  await cache.check('cluster-a/database', prepare);
  assert.equal(calls, 4);
  await assert.rejects(
    cache.check('unprepared', async () => {
      throw Error('missing index');
    }),
  );
  assert.equal(await cache.check('unprepared', prepare), false);
  assert.equal(await cache.check('unprepared', prepare), true);
});

test('Concurrent cold requests never share request-bound I/O; TTL starts after successful verification', async () => {
  let time = 0,
    calls = 0;
  const cache = createPreparationCache({ now: () => time, ttlMs: 100 });
  const releases = [];
  const prepare = () => {
    calls++;
    return new Promise((resolve) => releases.push(resolve));
  };
  const first = cache.check('database', prepare),
    second = cache.check('database', prepare);
  assert.equal(calls, 2);
  time = 500;
  releases.forEach((release) => release());
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  time = 599;
  assert.equal(await cache.check('database', prepare), true);
  time = 600;
  assert.equal(
    await cache.check('database', async () => {
      calls++;
    }),
    false,
  );
  assert.equal(calls, 3);
});
