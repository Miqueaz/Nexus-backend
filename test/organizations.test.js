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
    db = client.db('nexo_org_' + randomUUID().replaceAll('-', ''));
    await ensureIndexes(db);
    const config = {
      nodeEnv: 'test',
      jwtSecret: 'docs-test-secret-'.repeat(8),
      jwtIssuer: 'test',
      jwtAudience: 'test',
      tokenMinutes: 30,
      corsOrigins: [],
      trustProxyHops: 0,
    };
    const logger = createLogger('silent');
    app = createApp({
      services: await createContainer({ client, db, config, logger }),
      db,
      config,
      logger,
    });
  },
  { timeout: 180000 },
);
after(async () => {
  if (db) await db.dropDatabase();
  await client?.close();
  await replica?.stop();
});
async function account() {
  const email = randomUUID() + '@example.test';
  const r = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Org tester', email, password: 'Una-clave-larga-123!' })
    .expect(201);
  return { email, token: r.body.accessToken };
}
function api(a, method, path, body, key = randomUUID()) {
  const r = request(app)
    [method]('/api/v1' + path)
    .auth(a.token, { type: 'bearer' })
    .set('Idempotency-Key', key);
  return body ? r.send(body) : r;
}
const permissions = (overrides = {}) => ({
  docs: 'none',
  finance: 'none',
  inventory: 'none',
  sales: 'none',
  quotes: 'none',
  projections: 'none',
  contacts: 'none',
  calendar: 'none',
  projects: 'none',
  history: 'none',
  ...overrides,
});
async function space(a, name) {
  return (await api(a, 'post', '/businesses', { name, currency: 'MXN' }).expect(201)).body;
}
test('Organizations isolate workspaces, custom module roles and selected projects across every read path', async () => {
  const owner = await account(),
    member = await account(),
    outsider = await account();
  const a = await space(owner, 'Tienda'),
    b = await space(owner, 'Estudio'),
    privateSpace = await space(owner, 'Privado'),
    foreign = await space(outsider, 'Ajeno');
  const org = (await api(owner, 'post', '/organizations', { name: 'Equipo Nexo' }).expect(201))
      .body,
    base = '/organizations/' + org._id;
  await api(owner, 'put', base + '/spaces/' + a._id, { revision: a.revision }).expect(200);
  await api(owner, 'put', base + '/spaces/' + b._id, { revision: b.revision }).expect(200);
  await api(owner, 'put', base + '/spaces/' + foreign._id, { revision: foreign.revision }).expect(
    404,
  );
  const m = (await api(owner, 'post', base + '/members', { email: member.email }).expect(201)).body;
  assert.equal((await api(member, 'get', '/businesses').expect(200)).body.data.length, 0);
  await api(member, 'post', base + '/roles', {
    name: 'Escalada',
    permissions: permissions({ finance: 'write' }),
  }).expect(404);
  await api(outsider, 'get', base).expect(404);
  const role = (
    await api(owner, 'post', base + '/roles', {
      name: 'Proyectos y notas',
      permissions: permissions({
        docs: 'read',
        projects: 'write',
        calendar: 'read',
        history: 'read',
      }),
    }).expect(201)
  ).body;
  const financeRole = (
    await api(owner, 'post', base + '/roles', {
      name: 'Contabilidad',
      permissions: permissions({ finance: 'read' }),
    }).expect(201)
  ).body;
  const p = (
    await api(owner, 'post', '/businesses/' + a._id + '/projects', {
      name: 'Visible',
      dueOn: '2026-10-25',
    }).expect(201)
  ).body;
  const hidden = (
    await api(owner, 'post', '/businesses/' + a._id + '/projects', {
      name: 'Secreto',
      dueOn: '2026-10-25',
    }).expect(201)
  ).body;
  const other = (
    await api(owner, 'post', '/businesses/' + b._id + '/projects', { name: 'Otro espacio' }).expect(
      201,
    )
  ).body;
  await api(owner, 'post', '/businesses/' + a._id + '/wallets', {
    name: 'Caja',
    kind: 'cash',
  }).expect(201);
  await api(owner, 'post', '/businesses/' + b._id + '/wallets', { name: 'Banco' }).expect(201);
  await api(owner, 'post', '/businesses/' + a._id + '/docs', {
    title: 'Nota',
    kind: 'document',
    blocks: [],
  }).expect(201);
  const grants = base + '/spaces/' + a._id + '/grants/' + m._id;
  await api(owner, 'put', grants, {
    revision: 0,
    roleId: role._id,
    projectScope: { mode: 'selected', ids: [other._id] },
  }).expect(422);
  const grant = (
    await api(owner, 'put', grants, {
      revision: 0,
      roleId: role._id,
      projectScope: { mode: 'selected', ids: [p._id] },
    }).expect(200)
  ).body;
  await api(owner, 'put', base + '/spaces/' + b._id + '/grants/' + m._id, {
    revision: 0,
    roleId: financeRole._id,
  }).expect(200);
  const list = (await api(member, 'get', '/businesses').expect(200)).body.data;
  assert.deepEqual(list.map((s) => s._id).sort(), [a._id, b._id].sort());
  assert.equal(list.find((s) => s._id === a._id).access.roleName, role.name);
  await api(member, 'get', '/businesses/' + privateSpace._id).expect(404);
  const ab = '/businesses/' + a._id,
    bb = '/businesses/' + b._id;
  await api(member, 'get', ab + '/wallets').expect(403);
  await api(member, 'get', ab + '/summary').expect(403);
  await api(member, 'get', ab + '/audit').expect(403);
  await api(member, 'get', ab + '/members').expect(403);
  await api(member, 'get', bb + '/docs').expect(403);
  assert.equal((await api(member, 'get', bb + '/wallets').expect(200)).body.data.length, 1);
  assert.equal((await api(member, 'get', ab + '/docs').expect(200)).body.data.length, 1);
  await api(member, 'post', ab + '/docs', { title: 'Prohibido', kind: 'document' }).expect(403);
  await api(member, 'post', bb + '/wallets', { name: 'Prohibida' }).expect(403);
  assert.deepEqual(
    (await api(member, 'get', ab + '/projects').expect(200)).body.data.map((r) => r._id),
    [p._id],
  );
  await api(member, 'get', ab + '/projects/' + hidden._id).expect(404);
  await api(member, 'put', ab + '/projects/' + hidden._id, { name: 'Ataque', revision: 1 }).expect(
    404,
  );
  await api(member, 'post', ab + '/projects', { name: 'Fuera de alcance' }).expect(403);
  await api(member, 'put', ab + '/projects/' + p._id, {
    name: 'Visible editado',
    revision: 1,
    dueOn: '2026-10-25',
  }).expect(200);
  const snapshot = (await api(member, 'get', ab + '/snapshot').expect(200)).body;
  assert.equal(snapshot.collections.wallets.data.length, 0);
  assert.deepEqual(
    snapshot.collections.projects.data.map((r) => r._id),
    [p._id],
  );
  const at = encodeURIComponent(new Date().toISOString());
  const history = (await api(member, 'get', ab + '/snapshot?at=' + at).expect(200)).body;
  assert.equal(history.collections.wallets.data.length, 0);
  assert.deepEqual(
    history.collections.projects.data.map((r) => r._id),
    [p._id],
  );
  await api(member, 'get', ab + '/history?collection=wallets&at=' + at).expect(403);
  assert.deepEqual(
    (
      await api(member, 'get', ab + '/history?collection=projects&at=' + at).expect(200)
    ).body.data.map((r) => r._id),
    [p._id],
  );
  const calendar = (
    await api(member, 'get', ab + '/calendar?from=2026-10-01&to=2026-10-31').expect(200)
  ).body;
  assert(!JSON.stringify(calendar).includes('Secreto'));
  const detail = (await api(member, 'get', base).expect(200)).body;
  assert.equal(detail.canManage, false);
  assert.deepEqual(detail.grants, []);
  assert.deepEqual(detail.projects, []);
  const changed = {
    name: role.name,
    color: role.color,
    description: role.description,
    permissions: permissions({ docs: 'read' }),
    revision: role.revision,
  };
  await api(owner, 'patch', base + '/roles/' + role._id, { ...changed, archived: true }).expect(
    409,
  );
  await api(owner, 'patch', base + '/roles/' + role._id, changed).expect(200);
  await api(member, 'get', ab + '/projects').expect(403);
  await api(member, 'get', ab + '/snapshot?at=' + at).expect(403);
  await api(owner, 'put', grants, { revision: grant.revision + 1, roleId: null }).expect(409);
  await api(owner, 'patch', base + '/members/' + m._id, {
    revision: m.revision,
    state: 'removed',
  }).expect(200);
  await api(member, 'get', ab).expect(404);
  await api(member, 'get', bb).expect(404);
  assert.equal((await api(member, 'get', '/businesses').expect(200)).body.data.length, 0);
  assert(
    await db
      .collection('audit')
      .findOne({ action: 'organization.access.updated', businessId: a._id }),
  );
});
test('Organization changes require owner, protect owner and enforce idempotency and role dependencies', async () => {
  const owner = await account(),
    second = await account();
  const key = randomUUID();
  const data = { name: 'Organización segura' };
  const org = (await api(owner, 'post', '/organizations', data, key).expect(201)).body;
  assert.equal(
    (await api(owner, 'post', '/organizations', data, key).expect(201)).body._id,
    org._id,
  );
  await api(owner, 'post', '/organizations', { name: 'Otra' }, key).expect(409);
  const base = '/organizations/' + org._id;
  await api(owner, 'post', base + '/members', { email: second.email }).expect(201);
  await api(owner, 'post', base + '/members', { email: 'unregistered@example.test' }).expect(404);
  await api(owner, 'post', base + '/roles', {
    name: 'Inválido',
    permissions: permissions({ sales: 'write' }),
  }).expect(422);
  const detail = (await api(owner, 'get', base).expect(200)).body;
  const m = detail.members.find((m) => m.userId === org.ownerId);
  await api(owner, 'patch', base + '/members/' + m._id, {
    revision: m.revision,
    state: 'removed',
  }).expect(422);
  const b = await space(owner, 'Protegido');
  await api(owner, 'put', base + '/spaces/' + b._id, { revision: b.revision }).expect(200);
  await api(owner, 'put', base + '/spaces/' + b._id + '/grants/' + m._id, {
    revision: 1,
    roleId: null,
  }).expect(422);
  await api(second, 'patch', base, { name: 'Ataque', revision: 1 }).expect(404);
});

test('Removed workspace grants can be reassigned with their latest revision; concurrent removal cannot revive access', async () => {
  const owner = await account(),
    person = await account();
  const org = (
      await api(owner, 'post', '/organizations', { name: 'Control de accesos' }).expect(201)
    ).body,
    base = '/organizations/' + org._id;
  const b = await space(owner, 'Compartido');
  await api(owner, 'put', base + '/spaces/' + b._id, { revision: b.revision }).expect(200);
  let m = (await api(owner, 'post', base + '/members', { email: person.email }).expect(201)).body;
  const role = (
    await api(owner, 'post', base + '/roles', {
      name: 'Lector',
      permissions: permissions({ docs: 'read' }),
    }).expect(201)
  ).body;
  const path = base + '/spaces/' + b._id + '/grants/' + m._id;
  let g = (await api(owner, 'put', path, { revision: 0, roleId: role._id }).expect(200)).body;
  g = (await api(owner, 'put', path, { revision: g.revision, roleId: null }).expect(200)).body;
  const detail = (await api(owner, 'get', base).expect(200)).body;
  assert.equal(detail.grants.find((r) => r._id === g._id).revision, g.revision);
  g = (await api(owner, 'put', path, { revision: g.revision, roleId: role._id }).expect(200)).body;
  await api(person, 'get', '/businesses/' + b._id + '/docs').expect(200);
  const responses = await Promise.all([
    api(owner, 'put', path, { revision: g.revision, roleId: role._id }),
    api(owner, 'patch', base + '/members/' + m._id, { revision: m.revision, state: 'removed' }),
  ]);
  assert(responses.every((r) => [200, 404, 409].includes(r.status)));
  await api(person, 'get', '/businesses/' + b._id + '/docs').expect(404);
  m = (await api(owner, 'post', base + '/members', { email: person.email }).expect(201)).body;
  await api(person, 'get', '/businesses/' + b._id + '/docs').expect(404);
});
