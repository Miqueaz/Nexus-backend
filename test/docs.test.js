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
    db = client.db('nexo_docs_' + randomUUID().replaceAll('-', ''));
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
async function user() {
  const email = randomUUID() + '@example.test';
  const { body } = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Docs test', email, password: 'Una-clave-larga-123!' })
    .expect(201);
  return { email, token: body.accessToken };
}
async function fixture() {
  const account = await user();
  const { body } = await request(app)
    .post('/api/v1/businesses')
    .auth(account.token, { type: 'bearer' })
    .send({ name: 'Docs business', currency: 'MXN' })
    .expect(201);
  return { ...account, business: body, base: '/api/v1/businesses/' + body._id };
}
function call(f, method, path, body, key = randomUUID()) {
  let r = request(app)
    [method](f.base + path)
    .auth(f.token, { type: 'bearer' })
    .set('Idempotency-Key', key);
  return body ? r.send(body) : r;
}
const doc = () => ({
  title: 'Plan <img src=x onerror=alert(1)>',
  kind: 'document',
  blocks: [{ id: randomUUID(), type: 'todo', text: 'Preparar propuesta', checked: false }],
});
const update = (record) => ({
  title: record.title,
  kind: record.kind,
  color: record.color,
  blocks: record.blocks,
  elements: record.elements,
  revision: record.revision,
});
test('Docs persists structured documents, metadata-only pages, idempotent edits and audit', async () => {
  const f = await fixture(),
    body = doc(),
    key = randomUUID();
  const created = (await call(f, 'post', '/docs', body, key).expect(201)).body;
  const retry = (await call(f, 'post', '/docs', body, key).expect(201)).body;
  assert.equal(created._id, retry._id);
  assert.equal(await db.collection('documents').countDocuments({ businessId: f.business._id }), 1);
  const metadata = (await call(f, 'get', '/docs')).body.data[0];
  assert.equal(metadata.title, body.title);
  assert.equal(metadata.blocks, undefined);
  assert.equal(metadata.elements, undefined);
  const value = update(created);
  value.blocks[0].checked = true;
  const edited = (
    await call(f, 'put', '/docs/' + created._id, value, 'docs-save-retry-key').expect(200)
  ).body;
  const replay = (
    await call(f, 'put', '/docs/' + created._id, value, 'docs-save-retry-key').expect(200)
  ).body;
  assert.equal(replay.revision, edited.revision);
  assert.equal(edited.blocks[0].checked, true);
  await call(f, 'put', '/docs/' + created._id, { ...value, title: 'Stale revision' }).expect(409);
  const audits = await db
    .collection('audit')
    .find({ businessId: f.business._id, collection: 'documents' })
    .sort({ 'after.revision': 1 })
    .toArray();
  assert.equal(audits.length, 2);
  assert.equal(audits[1].after.blocks[0].checked, true);
});
test('Docs blocks cross-business reads, viewer writes and writes to a disabled module', async () => {
  const f = await fixture(),
    other = await fixture(),
    viewer = await user();
  const created = (await call(f, 'post', '/docs', doc()).expect(201)).body;
  await call(other, 'get', '/docs/' + created._id).expect(404);
  await call(other, 'put', '/docs/' + created._id, update(created)).expect(404);
  await call(f, 'post', '/members', { email: viewer.email, role: 'viewer' }).expect(201);
  const v = { ...f, token: viewer.token };
  await call(v, 'get', '/docs/' + created._id).expect(200);
  await call(v, 'put', '/docs/' + created._id, update(created)).expect(403);
  await call(v, 'post', '/docs', doc()).expect(403);
  await call(v, 'patch', '/docs/' + created._id, { archived: true, revision: 1 }).expect(403);
  await call(f, 'patch', '', { enabledModules: [], revision: f.business.revision }).expect(200);
  await call(f, 'get', '/docs/' + created._id).expect(200);
  const disabled = await call(f, 'post', '/docs', doc()).expect(409);
  assert.equal(disabled.body.error.code, 'MODULE_DISABLED');
});
test('Boards keep strokes and shapes; archive, restore, filtering and pagination preserve content', async () => {
  const f = await fixture();
  const element = {
    id: randomUUID(),
    type: 'pen',
    x: 50,
    y: 40,
    points: [
      [0, 0],
      [10, 12],
      [30, 8],
    ],
  };
  const board = (
    await call(f, 'post', '/docs', {
      title: 'Ideas [special]',
      kind: 'board',
      elements: [element],
    }).expect(201)
  ).body;
  await call(f, 'post', '/docs', doc()).expect(201);
  const filtered = (await call(f, 'get', '/docs?kind=board&q=%5Bspecial%5D')).body;
  assert.equal(filtered.data.length, 1);
  assert.equal(filtered.data[0]._id, board._id);
  const page = (await call(f, 'get', '/docs?limit=1')).body;
  assert.ok(page.nextCursor);
  const next = (await call(f, 'get', '/docs?limit=1&cursor=' + page.nextCursor)).body;
  assert.equal(next.data.length, 1);
  assert.notEqual(next.data[0]._id, page.data[0]._id);
  const archived = (
    await call(f, 'patch', '/docs/' + board._id, { archived: true, revision: 1 }).expect(200)
  ).body;
  assert.equal((await call(f, 'get', '/docs?kind=board')).body.data.length, 0);
  assert.equal((await call(f, 'get', '/docs?archived=true')).body.data.length, 1);
  await call(f, 'put', '/docs/' + board._id, update(archived)).expect(409);
  const restored = (
    await call(f, 'patch', '/docs/' + board._id, {
      archived: false,
      revision: archived.revision,
    }).expect(200)
  ).body;
  assert.deepEqual(restored.elements[0].points, element.points);
  await call(f, 'put', '/docs/' + board._id, {
    ...update(restored),
    kind: 'document',
    elements: [],
  }).expect(422);
});
test('Docs schema rejects executable attributes, duplicate IDs, invalid geometry and oversized scenes', () => {
  const element = { id: randomUUID(), type: 'rectangle', x: 0, y: 0, width: 50, height: 50 };
  assert.equal(
    createDocSchema.safeParse({ title: 'Board', kind: 'board', elements: [element] }).success,
    true,
  );
  for (const elements of [
    [{ ...element, x: Infinity }],
    [{ ...element, stroke: 'url(javascript:alert(1))' }],
    [element, element],
    [{ ...element, html: '<script/>' }],
    [{ ...element, type: 'iframe' }],
  ])
    assert.equal(
      createDocSchema.safeParse({ title: 'Board', kind: 'board', elements }).success,
      false,
    );
  assert.equal(createDocSchema.safeParse({ ...doc(), elements: [element] }).success, false);
  assert.equal(
    createDocSchema.safeParse({
      title: 'Large',
      kind: 'document',
      blocks: Array.from({ length: 30 }, () => ({
        id: randomUUID(),
        type: 'paragraph',
        text: 'é'.repeat(12000),
      })),
    }).success,
    false,
  );
});
test('Docs migration is additive and preparation detects an absent collection index', async () => {
  await assertDatabasePrepared(db);
  const isolated = client.db('docs_migration_' + randomUUID().replaceAll('-', ''));
  try {
    await ensureIndexes(isolated);
    await isolated.collection('documents').drop();
    await assert.rejects(
      assertDatabasePrepared(isolated),
      (e) => e.code === 'DATABASE_NOT_PREPARED',
    );
    await ensureIndexes(isolated);
    await assertDatabasePrepared(isolated);
  } finally {
    await isolated.dropDatabase();
  }
});

test('Official Excalidraw scenes preserve native IDs, bound text and pressure without changing finances', async () => {
  const { readFile } = await import('node:fs/promises');
  const scene = JSON.parse(
    await readFile(new URL('./fixtures/excalidraw-scene.json', import.meta.url), 'utf8'),
  );
  const f = await fixture();
  const legacy = (
    await call(f, 'post', '/docs', {
      title: 'Migrated board',
      kind: 'board',
      elements: [{ id: randomUUID(), type: 'rectangle', x: 1, y: 2, width: 100, height: 80 }],
    }).expect(201)
  ).body;
  const migrated = (
    await call(f, 'put', '/docs/' + legacy._id, {
      ...update(legacy),
      elements: [],
      board: scene,
    }).expect(200)
  ).body;
  assert.equal(migrated.board.format, 'excalidraw');
  assert.equal(migrated.elements.length, 0);
  assert.deepEqual(
    migrated.board.elements.map((e) => e.id),
    scene.elements.map((e) => e.id),
  );
  assert.ok(migrated.board.elements.some((e) => e.type === 'freedraw'));
  assert.ok(migrated.board.elements.some((e) => e.type === 'text' && e.containerId));
  const listing = (await call(f, 'get', '/docs').expect(200)).body.data[0];
  assert.equal(listing.board, undefined);
  const detail = (await call(f, 'get', '/docs/' + legacy._id).expect(200)).body;
  assert.deepEqual(detail.board.elements, scene.elements);
  const before = await db
    .collection('audit')
    .findOne({ entityId: legacy._id, 'after.revision': 2 });
  assert.equal(before.before.elements.length, 1);
  assert.equal(await db.collection('movements').countDocuments({ businessId: f.business._id }), 0);
  await call(f, 'put', '/docs/' + legacy._id, {
    ...update(detail),
    board: scene,
    revision: 1,
  }).expect(409);
});

test('Native scene validation rejects executable embeds/links and accepts bounded raster data', async () => {
  const { readFile } = await import('node:fs/promises');
  const scene = JSON.parse(
    await readFile(new URL('./fixtures/excalidraw-scene.json', import.meta.url), 'utf8'),
  );
  const input = { title: 'Native', kind: 'board', board: scene };
  assert.equal(createDocSchema.safeParse(input).success, true);
  for (const patch of [
    { type: 'iframe' },
    { link: 'javascript:alert(1)' },
    { strokeColor: 'url(https://evil.test)' },
    { x: Infinity },
    { customData: { html: '<script/>' } },
  ]) {
    assert.equal(
      createDocSchema.safeParse({
        ...input,
        board: { ...scene, elements: [{ ...scene.elements[0], ...patch }] },
      }).success,
      false,
    );
  }
  const fileId = 'test_image',
    image = {
      ...scene.elements[0],
      type: 'image',
      id: 'native-image',
      fileId,
      status: 'saved',
      scale: [1, 1],
      crop: null,
      boundElements: null,
    };
  const files = {
    [fileId]: {
      id: fileId,
      mimeType: 'image/png',
      dataURL: 'data:image/png;base64,iVBORw0KGgo=',
      created: 1,
    },
  };
  assert.equal(
    createDocSchema.safeParse({ ...input, board: { ...scene, elements: [image], files } }).success,
    true,
  );
  assert.equal(
    createDocSchema.safeParse({
      ...input,
      board: {
        ...scene,
        elements: [image],
        files: {
          [fileId]: {
            ...files[fileId],
            mimeType: 'image/svg+xml',
            dataURL: 'data:image/svg+xml;base64,PHN2Zz4=',
          },
        },
      },
    }).success,
    false,
  );
  assert.equal(
    createDocSchema.safeParse({ title: 'Document', kind: 'document', board: scene }).success,
    false,
  );
});

test('Nexo board backgrounds accept persisted dots/lines/none and reject unknown patterns', async () => {
  const { readFile } = await import('node:fs/promises');
  const scene = JSON.parse(
    await readFile(new URL('./fixtures/excalidraw-scene.json', import.meta.url), 'utf8'),
  );
  for (const pattern of ['dots', 'lines', 'none']) {
    const parsed = createDocSchema.parse({
      title: 'Paper',
      kind: 'board',
      board: { ...scene, appState: { ...scene.appState, nexoBackgroundPattern: pattern } },
    });
    assert.equal(parsed.board.appState.nexoBackgroundPattern, pattern);
  }
  assert.equal(
    createDocSchema.safeParse({
      title: 'Paper',
      kind: 'board',
      board: { ...scene, appState: { ...scene.appState, nexoBackgroundPattern: 'url(evil)' } },
    }).success,
    false,
  );
});

test('Library groups documents into scoped folders and sections, moves with revisions and protects nonempty folders', async () => {
  const f = await fixture(),
    other = await fixture();
  const folder = (
    await call(f, 'post', '/docs/containers', { title: 'Proyectos', kind: 'folder' }).expect(201)
  ).body;
  const section = (
    await call(f, 'post', '/docs/containers', {
      title: 'Diseño',
      kind: 'section',
      parentId: folder._id,
    }).expect(201)
  ).body;
  await call(f, 'post', '/docs/containers', { title: 'Sin carpeta', kind: 'section' }).expect(422);
  await call(f, 'post', '/docs/containers', {
    title: 'Anidada',
    kind: 'folder',
    parentId: folder._id,
  }).expect(422);
  await call(other, 'post', '/docs', { ...doc(), parentId: section._id }).expect(404);
  const note = (await call(f, 'post', '/docs', { ...doc(), parentId: section._id }).expect(201))
    .body;
  const library = (await call(f, 'get', '/docs/library?parentId=' + section._id).expect(200)).body;
  assert.equal(library.data.length, 1);
  assert.equal(library.data[0]._id, note._id);
  assert.equal(library.containers.length, 2);
  assert.equal(library.recent.length, 1);
  assert.equal(library.data[0].blocks, undefined);
  const moved = (
    await call(f, 'patch', '/docs/' + note._id + '/location', {
      parentId: folder._id,
      revision: note.revision,
    }).expect(200)
  ).body;
  assert.equal(moved.parentId, folder._id);
  await call(f, 'patch', '/docs/' + note._id + '/location', {
    parentId: null,
    revision: note.revision,
  }).expect(409);
  const liveFolder = (await call(f, 'get', '/docs/' + folder._id)).body;
  await call(f, 'patch', '/docs/' + folder._id, {
    archived: true,
    revision: liveFolder.revision,
  }).expect(409);
  await call(f, 'patch', '/docs/' + moved._id + '/location', {
    parentId: null,
    revision: moved.revision,
  }).expect(200);
  const root = (await call(f, 'get', '/docs/library?parentId=root')).body;
  assert.equal(root.data[0]._id, note._id);
});

test('File uploads validate bytes and limits; metadata lists never contain file contents and reads respect membership', async () => {
  const f = await fixture(),
    other = await fixture(),
    key = randomUUID();
  const data = Buffer.from('%PDF-1.7\nNexo test\n%%EOF').toString('base64');
  const body = { title: 'Contrato.pdf', name: 'Contrato.pdf', data };
  const row = (await call(f, 'post', '/docs/files', body, key).expect(201)).body;
  assert.equal(row.attachment.data, undefined);
  assert.equal(row.attachment.mime, 'application/pdf');
  assert.equal((await call(f, 'post', '/docs/files', body, key).expect(201)).body._id, row._id);
  const library = (await call(f, 'get', '/docs/library?kind=file')).body;
  assert.equal(library.data[0].attachment.data, undefined);
  assert.equal(library.recent[0].attachment.data, undefined);
  assert.equal((await call(f, 'get', '/docs/' + row._id)).body.attachment.data, undefined);
  assert.equal((await call(f, 'get', '/docs/' + row._id + '/content')).body.data, data);
  await call(other, 'get', '/docs/' + row._id + '/content').expect(404);
  await call(f, 'post', '/docs/files', { ...body, name: 'active.html' }).expect(422);
  await call(f, 'post', '/docs/files', {
    ...body,
    data: Buffer.from('invalid pdf').toString('base64'),
  }).expect(422);
  await call(f, 'post', '/docs/files', { ...body, name: '../bad.pdf' }).expect(422);
  const viewer = await user();
  await call(f, 'post', '/members', { email: viewer.email, role: 'viewer' }).expect(201);
  await call({ ...f, token: viewer.token }, 'post', '/docs/files', body).expect(403);
  await call({ ...f, token: viewer.token }, 'patch', '/docs/' + row._id + '/location', {
    title: 'Changed',
    revision: 1,
  }).expect(403);
});
