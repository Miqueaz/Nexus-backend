import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createGoogleIdentity } from '../src/adapters/identity/google.js';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { ensureIndexes } from '../src/adapters/mongo/database.js';
import { createLogger } from '../src/adapters/logger.js';
let rs, client, db, app, privateKey, dataDir;
const clientId = '259045388211-p4fk2jnqhm40t1tqa91da7ic1qbn76ak.apps.googleusercontent.com';
const password = 'Clave-de-pruebas-larga-123';
before(
  async () => {
    dataDir = await mkdtemp(join(process.env.TEST_TMP_ROOT ?? tmpdir(), 'nexo-google-'));
    rs = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [
        { dbPath: dataDir, args: ['--nounixsocket', '--wiredTigerCacheSizeGB', '0.25'] },
      ],
      binary: { version: '8.0.16' },
    });
    client = await new MongoClient(rs.getUri()).connect();
    db = client.db('nexo_google_' + randomUUID().replaceAll('-', ''));
    await ensureIndexes(db);
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = 'test-key';
    const config = {
      nodeEnv: 'test',
      jwtSecret: 'test-secret-'.repeat(8),
      jwtIssuer: 'nexo-test',
      jwtAudience: 'nexo-test',
      tokenMinutes: 30,
      corsOrigins: ['https://nexo.aethel.ing'],
      trustProxyHops: 0,
      googleClientId: clientId,
    };
    const logger = createLogger('silent'),
      googleIdentity = createGoogleIdentity({
        clientId,
        keySet: createLocalJWKSet({ keys: [jwk] }),
      });
    const services = await createContainer({ client, db, config, logger, googleIdentity });
    app = createApp({ services, config, logger, db });
  },
  { timeout: 180000 },
);
after(async () => {
  if (db) await db.dropDatabase();
  await client?.close();
  await rs?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});
const post = (path, body, token) => {
  let r = request(app).post('/api/v1/auth/' + path);
  if (token) r = r.auth(token, { type: 'bearer' });
  return r.send(body);
};
const challenge = async () => (await post('google/challenge', {}).expect(200)).body;
async function credential(
  attempt,
  { sub = randomUUID(), email = randomUUID() + '@gmail.com', claims = {}, key = privateKey } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: 'https://accounts.google.com',
    aud: clientId,
    sub,
    email,
    email_verified: true,
    name: 'Usuario Google',
    nonce: attempt.nonce,
    iat: now,
    exp: now + 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(key);
}
const login = async (attempt, credential) =>
  post('google', { challengeId: attempt.challengeId, credential });
async function local() {
  return (
    await post('register', {
      name: 'Cuenta existente',
      email: randomUUID() + '@example.test',
      password,
    }).expect(201)
  ).body;
}

test('Google crea sesión Nexo, guarda identidad estable y consume el intento una sola vez', async () => {
  const attempt = await challenge();
  assert.equal(attempt.clientId, clientId);
  assert.equal(attempt.expiresIn, 300);
  const stored = await db.collection('authChallenges').findOne({ _id: attempt.challengeId });
  assert.equal(stored.nonceHash, createHash('sha256').update(attempt.nonce).digest('hex'));
  assert.equal(stored.nonce, undefined);
  const sub = randomUUID(),
    email = randomUUID() + '@gmail.com',
    jwt = await credential(attempt, { sub, email });
  const result = await login(attempt, jwt);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.googleLinked, true);
  const me = await request(app)
    .get('/api/v1/auth/me')
    .auth(result.body.accessToken, { type: 'bearer' })
    .expect(200);
  assert.equal(me.body._id, result.body.user._id);
  assert.equal(me.body.googleEmail, email);
  const user = await db.collection('users').findOne({ _id: me.body._id });
  assert.equal(user.googleSub, sub);
  assert.equal(user.passwordHash, undefined);
  assert.equal(user.credential, undefined);
  assert.equal((await login(attempt, jwt)).status, 401);
  const next = await challenge(),
    again = await login(next, await credential(next, { sub, email: 'changed@gmail.com' }));
  assert.equal(again.status, 200);
  assert.equal(again.body.user._id, user._id);
  assert.equal(await db.collection('users').countDocuments({ googleSub: sub }), 1);
  assert.equal(
    (await request(app).get('/api/v1/businesses').auth(jwt, { type: 'bearer' })).status,
    401,
  );
  await post('logout', {}, result.body.accessToken).expect(200);
  await request(app)
    .get('/api/v1/auth/me')
    .auth(result.body.accessToken, { type: 'bearer' })
    .expect(401);
  const events = await db.collection('securityEvents').find({ userId: user._id }).toArray();
  assert.ok(events.some((e) => e.action === 'auth.google.registered'));
  assert.ok(!JSON.stringify(events).includes(jwt));
});

test('Google rechaza firma, audiencia, emisor, vencimiento, correo y nonce incorrectos sin crear usuarios', async () => {
  const attempt = await challenge(),
    before = await db.collection('users').countDocuments();
  for (const claims of [
    { aud: 'otro-cliente' },
    { iss: 'https://attacker.example' },
    { exp: Math.floor(Date.now() / 1000) - 120 },
    { email_verified: false },
    { nonce: 'otro-intento' },
    { nonce: undefined },
    { azp: 'otro-cliente' },
    { sub: '' },
  ]) {
    const r = await login(attempt, await credential(attempt, { claims }));
    assert.equal(r.status, 401, JSON.stringify(r.body));
    assert.equal(r.body.accessToken, undefined);
  }
  const other = await generateKeyPair('RS256');
  assert.equal(
    (await login(attempt, await credential(attempt, { key: other.privateKey }))).status,
    401,
  );
  assert.equal((await login(attempt, 'not-a-jwt')).status, 401);
  assert.equal(await db.collection('users').countDocuments(), before);
  await db
    .collection('authChallenges')
    .updateOne({ _id: attempt.challengeId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(
    (await login(attempt, await credential(attempt))).body.error.code,
    'GOOGLE_CHALLENGE_EXPIRED',
  );
});

test('Vincular Google exige contraseña y conserva el usuario, sus negocios y su acceso original', async () => {
  const owner = await local();
  const business = (
    await request(app)
      .post('/api/v1/businesses')
      .auth(owner.accessToken, { type: 'bearer' })
      .send({ name: 'Mi negocio anterior', currency: 'MXN' })
      .expect(201)
  ).body;
  const attempt = await challenge(),
    sub = randomUUID(),
    jwt = await credential(attempt, { sub, email: owner.user.email });
  const conflict = await login(attempt, jwt);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'GOOGLE_LINK_REQUIRED');
  assert.equal(
    (await db.collection('users').findOne({ _id: owner.user._id })).googleSub,
    undefined,
  );
  await post('google/link/challenge', { password }).expect(401);
  await post(
    'google/link/challenge',
    { password: 'Otra-clave-invalida-123' },
    owner.accessToken,
  ).expect(401);
  const link = (await post('google/link/challenge', { password }, owner.accessToken).expect(200))
    .body;
  const stranger = await local();
  const linkToken = await credential(link, { sub, email: owner.user.email });
  await post(
    'google/link',
    { challengeId: attempt.challengeId, credential: jwt },
    owner.accessToken,
  ).expect(401);
  await post(
    'google/link',
    { challengeId: link.challengeId, credential: linkToken },
    stranger.accessToken,
  ).expect(401);
  const linked = (
    await post(
      'google/link',
      { challengeId: link.challengeId, credential: linkToken },
      owner.accessToken,
    ).expect(200)
  ).body;
  assert.equal(linked._id, owner.user._id);
  assert.equal(linked.googleLinked, true);
  const next = await challenge(),
    session = await login(next, await credential(next, { sub, email: owner.user.email }));
  assert.equal(session.body.user._id, owner.user._id);
  const spaces = (
    await request(app)
      .get('/api/v1/businesses')
      .auth(session.body.accessToken, { type: 'bearer' })
      .expect(200)
  ).body;
  assert.equal(spaces.data[0]._id, business._id);
  assert.equal(spaces.data[0].role, 'owner');
  await post('login', { email: owner.user.email, password }).expect(200);
  const strangerChallenge = (
    await post('google/link/challenge', { password }, stranger.accessToken).expect(200)
  ).body;
  const taken = await post(
    'google/link',
    {
      challengeId: strangerChallenge.challengeId,
      credential: await credential(strangerChallenge, { sub, email: owner.user.email }),
    },
    stranger.accessToken,
  );
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'GOOGLE_ACCOUNT_IN_USE');
});

test('Google evita usuarios duplicados y sesiones repetidas ante solicitudes concurrentes', async () => {
  const sub = randomUUID(),
    email = randomUUID() + '@gmail.com',
    a = await challenge(),
    b = await challenge();
  const responses = await Promise.all([
    credential(a, { sub, email }).then((jwt) => login(a, jwt)),
    credential(b, { sub, email }).then((jwt) => login(b, jwt)),
  ]);
  for (const r of responses) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(responses[0].body.user._id, responses[1].body.user._id);
  assert.equal(await db.collection('users').countDocuments({ googleSub: sub }), 1);
  const attempt = await challenge(),
    jwt = await credential(attempt, { sub, email });
  const repeated = await Promise.all([login(attempt, jwt), login(attempt, jwt)]);
  assert.deepEqual(repeated.map((r) => r.status).sort(), [200, 401]);
});
