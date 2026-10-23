import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { ensureIndexes, assertDatabasePrepared } from '../src/adapters/mongo/database.js';
import { createLogger } from '../src/adapters/logger.js';
import { createDocSchema } from '../src/modules/docs/schemas.js';
let replica, client, db, app;
before(
  async () => {
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ args: ['--nounixsocket', '--wiredTigerCacheSizeGB', '0.25'] }],
      binary: { version: '8.0.16' },
    });
    client = await new MongoClient(replica.getUri()).connect();
    db = client.db('nexo_platform_' + randomUUID().replaceAll('-', ''));
    await ensureIndexes(db);
    const config = {
      nodeEnv: 'test',
      googleClientId: '123-test.apps.googleusercontent.com',
      platformAdminEmails: ['admin@example.test'],
      jwtSecret: 'docs-test-secret-'.repeat(8),
      jwtIssuer: 'test',
      jwtAudience: 'test',
      tokenMinutes: 30,
      corsOrigins: [],
      trustProxyHops: 0,
    };
    const logger = createLogger('silent');
    app = createApp({
      services: await createContainer({
        client,
        db,
        config,
        logger,
        googleIdentity: { verify: async (token) => JSON.parse(token) },
      }),
      db,
      config,
      logger,
    });
    admin = await account('admin@example.test');
    user = await account();
  },
  { timeout: 180000 },
);
after(async () => {
  if (db) await db.dropDatabase();
  await client?.close();
  await replica?.stop();
});
function api(a, method, path, body, key = randomUUID()) {
  const r = request(app)
    [method]('/api/v1' + path)
    .set('Idempotency-Key', key);
  if (a) r.auth(a.token, { type: 'bearer' });
  return body ? r.send(body) : r;
}
async function account(email = randomUUID() + '@example.test') {
  const r = await api(null, 'post', '/auth/register', {
    name: 'Platform tester',
    email,
    password: 'Una-clave-larga-123!',
  }).expect(201);
  return { token: r.body.accessToken, user: r.body.user, email };
}
async function link(a, email = a.email) {
  const challenge = (
    await api(a, 'post', '/auth/google/link/challenge', {
      password: 'Una-clave-larga-123!',
    }).expect(200)
  ).body;
  const body = {
    credential: JSON.stringify({
      subject: randomUUID(),
      email,
      name: 'Google verified',
      nonce: challenge.nonce,
    }),
    challengeId: challenge.challengeId,
  };
  return (await api(a, 'post', '/auth/google/link', body).expect(200)).body;
}
async function google(a, subject, email) {
  const challenge = (await api(a, 'post', '/auth/google/challenge', {}).expect(200)).body;
  return api(a, 'post', '/auth/google', {
    credential: JSON.stringify({ subject, email, name: 'Google user', nonce: challenge.nonce }),
    challengeId: challenge.challengeId,
  });
}
const policy = (p) => ({
  revision: p.revision,
  registration: p.registration,
  login: p.login,
  features: p.features,
  enabledModules: p.enabledModules,
});
let admin, user, initial;
test('Only a verified Google owner of the bootstrap email becomes admin; unverified email and workspace ownership do not grant it', async () => {
  assert.equal(admin.user.platformRole, 'user');
  await api(admin, 'get', '/administration/settings').expect(403);
  const b = (
    await api(user, 'post', '/businesses', {
      name: 'Owner is not global admin',
      currency: 'MXN',
    }).expect(201)
  ).body;
  await api(user, 'get', '/administration/settings').expect(403);
  await api(user, 'patch', '/administration/settings', {}).expect(403);
  await api(null, 'post', '/auth/register', {
    name: 'Spoof',
    email: randomUUID() + '@example.test',
    password: 'Una-clave-larga-123!',
    platformRole: 'admin',
  }).expect(422);
  const linked = await link(admin);
  assert.equal(linked.platformRole, 'admin');
  assert.equal((await api(admin, 'get', '/auth/me').expect(200)).body.platformRole, 'admin');
  initial = (await api(admin, 'get', '/administration/settings').expect(200)).body;
  assert.equal(initial.revision, 0);
  await api(null, 'get', '/administration/settings').expect(401);
  const options = (await api(null, 'get', '/auth/options').expect(200)).body;
  assert(!JSON.stringify(options).includes('admin@example.test'));
  assert.equal(options.login.password, true);
  await api(admin, 'get', '/businesses/' + b._id).expect(404); // admin controls configuration, never other users' records
});
test('Registration and login switches distinguish existing accounts from new Google users and preserve revisions/idempotency', async () => {
  const existing = await account();
  await link(existing);
  const stored = await db.collection('users').findOne({ _id: existing.user._id });
  let p = policy(initial),
    key = randomUUID();
  p.registration = { portal: false, google: false };
  let saved = (await api(admin, 'patch', '/administration/settings', p, key).expect(200)).body;
  assert.equal(
    (await api(admin, 'patch', '/administration/settings', p, key).expect(200)).body.revision,
    saved.revision,
  );
  await api(
    admin,
    'patch',
    '/administration/settings',
    { ...p, features: { ...p.features, docsUploads: false } },
    key,
  ).expect(409);
  await api(null, 'post', '/auth/register', {
    name: 'Disabled',
    email: randomUUID() + '@example.test',
    password: 'Una-clave-larga-123!',
  }).expect(403);
  const before = await db.collection('users').countDocuments();
  assert.equal((await google(null, randomUUID(), 'new-google@example.test')).status, 403);
  assert.equal(await db.collection('users').countDocuments(), before);
  assert.equal((await google(null, stored.googleSub, stored.googleEmail)).status, 200);
  p = policy(saved);
  p.registration.google = true;
  p.login.password = false;
  saved = (await api(admin, 'patch', '/administration/settings', p).expect(200)).body;
  await api(null, 'post', '/auth/login', {
    email: admin.email,
    password: 'Una-clave-larga-123!',
  }).expect(403);
  assert.equal((await google(null, randomUUID(), 'new-verified@example.test')).status, 200);
  await api(admin, 'patch', '/administration/settings', {
    ...policy(saved),
    login: { password: false, google: false },
    registration: { portal: false, google: false },
  }).expect(422);
  await api(admin, 'patch', '/administration/settings', policy(initial)).expect(409);
  // Reset with the latest revision, without removing any account.
  await api(admin, 'patch', '/administration/settings', {
    ...policy(initial),
    revision: saved.revision,
  }).expect(200);
  const audit = (await api(admin, 'get', '/administration/audit').expect(200)).body.data;
  assert(audit.length >= 3);
  assert(audit.every((e) => e.actorId === admin.user._id));
});
test('Global modules and feature flags block direct requests, snapshots and calendar for owners; data remains stored', async () => {
  const b = (
      await api(user, 'post', '/businesses', { name: 'Global switches', currency: 'MXN' }).expect(
        201,
      )
    ).body,
    base = '/businesses/' + b._id;
  await api(user, 'post', base + '/wallets', { name: 'Caja', openingBalanceMinor: 10000 }).expect(
    201,
  );
  const project = (
    await api(user, 'post', base + '/projects', { name: 'Visible', dueOn: '2026-10-25' }).expect(
      201,
    )
  ).body;
  await api(user, 'post', base + '/docs', { title: 'Existing note', kind: 'document' }).expect(201);
  let p = policy((await api(admin, 'get', '/administration/settings').expect(200)).body);
  p.enabledModules = p.enabledModules.filter((m) => !['finance', 'sales', 'docs'].includes(m));
  p.features = { workspaceCreation: false, organizationCreation: false, docsUploads: false };
  let saved = (await api(admin, 'patch', '/administration/settings', p).expect(200)).body;
  await api(user, 'get', base + '/wallets').expect(403);
  await api(user, 'post', base + '/wallets', { name: 'Bypass' }).expect(403);
  await api(user, 'get', base + '/summary').expect(403);
  await api(user, 'get', base + '/docs').expect(403);
  const snap = (await api(user, 'get', base + '/snapshot').expect(200)).body;
  assert.equal(snap.collections.wallets.data.length, 0);
  assert.deepEqual(
    snap.collections.projects.data.map((p) => p._id),
    [project._id],
  );
  await api(user, 'post', base + '/projects', { name: 'Still allowed' }).expect(201);
  await api(user, 'get', base + '/members').expect(200);
  const calendar = await api(user, 'get', base + '/calendar?from=2026-10-01&to=2026-10-31').expect(
    200,
  );
  assert(!JSON.stringify(calendar.body).includes('Caja'));
  const audit = await api(user, 'get', base + '/audit').expect(200);
  assert(
    !audit.body.data.some((r) => ['wallets', 'movements', 'documents'].includes(r.collection)),
  );
  await api(
    user,
    'get',
    base + '/history?collection=wallets&at=' + encodeURIComponent(new Date().toISOString()),
  ).expect(403);
  await api(user, 'post', '/businesses', { name: 'Not allowed', currency: 'MXN' }).expect(403);
  await api(user, 'post', '/organizations', { name: 'Not allowed' }).expect(403);
  assert.equal(await db.collection('wallets').countDocuments({ businessId: b._id }), 1);
  p = policy(saved);
  p.enabledModules = initial.enabledModules;
  saved = (await api(admin, 'patch', '/administration/settings', p).expect(200)).body;
  await api(user, 'post', base + '/docs/files', {
    title: 'File',
    name: 'test.pdf',
    data: 'JVBERi0xLjQ=',
  }).expect(403);
  await api(user, 'get', base + '/docs').expect(200);
  await api(admin, 'patch', '/administration/settings', {
    ...policy(initial),
    revision: saved.revision,
  }).expect(200);
  assert.equal((await api(user, 'get', base + '/wallets').expect(200)).body.data.length, 1);
});

test('Disabling Google blocks outstanding challenges and Google-only administrators cannot remove their own recovery path', async () => {
  let current = (await api(admin, 'get', '/administration/settings').expect(200)).body;
  const challenge = (await api(null, 'post', '/auth/google/challenge', {}).expect(200)).body;
  let p = policy(current);
  p.login.google = false;
  p.registration.google = false;
  const off = (await api(admin, 'patch', '/administration/settings', p).expect(200)).body;
  await api(null, 'post', '/auth/google/challenge', {}).expect(403);
  await api(null, 'post', '/auth/google', {
    challengeId: challenge.challengeId,
    credential: JSON.stringify({
      subject: randomUUID(),
      email: 'blocked@example.test',
      nonce: challenge.nonce,
    }),
  }).expect(403);
  current = (
    await api(admin, 'patch', '/administration/settings', {
      ...policy(initial),
      revision: off.revision,
    }).expect(200)
  ).body;
  const record = await db.collection('users').findOne({ _id: admin.user._id });
  await db.collection('users').updateOne({ _id: admin.user._id }, { $unset: { passwordHash: '' } });
  await api(admin, 'patch', '/administration/settings', {
    ...policy(current),
    login: { password: true, google: false },
    registration: { portal: true, google: false },
  }).expect(422);
  await db
    .collection('users')
    .updateOne({ _id: admin.user._id }, { $set: { passwordHash: record.passwordHash } });
});
