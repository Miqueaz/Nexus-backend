import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z, text } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { hashPassword, verifyPassword } from './passwords.js';
const credentials = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  password: z.string().min(12).max(128),
});
const register = credentials.extend({ name: text });
const publicUser = (u) => ({
  _id: u._id,
  name: u.name,
  email: u.email,
  googleLinked: !!u.googleSub,
  ...(u.googleSub ? { googleEmail: u.googleEmail || '' } : {}),
});
const googleInput = z.strictObject({
  credential: z.string().min(1).max(16000),
  challengeId: z.uuid(),
});
const nonceHash = (nonce) => createHash('sha256').update(nonce).digest('hex');
export async function createAuthService({ store, config, logger, googleIdentity }) {
  const secret = new TextEncoder().encode(config.jwtSecret);
  const dummy = await hashPassword(randomUUID());
  async function security(action, userId, requestId, repository = store) {
    await repository.insertSecurityEvent({
      _id: randomUUID(),
      action,
      userId: userId ?? null,
      requestId,
      recordedAt: new Date(),
    });
    logger.info({ action, userId, requestId }, 'security.event');
  }
  async function issue(user, requestId, repository = store) {
    const sid = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + config.tokenMinutes * 60;
    await repository.insertSession({
      _id: sid,
      userId: user._id,
      expiresAt: new Date(exp * 1000),
      createdAt: new Date(),
    });
    const accessToken = await new SignJWT({ sid })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user._id)
      .setIssuer(config.jwtIssuer)
      .setAudience(config.jwtAudience)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(secret);
    await security('auth.session.created', user._id, requestId, repository);
    return { user: publicUser(user), accessToken, tokenType: 'Bearer', expiresIn: exp - now };
  }
  async function googleChallenge(purpose, userId = null) {
    ensure(
      config.googleClientId,
      503,
      'GOOGLE_NOT_CONFIGURED',
      'El acceso con Google todavía no está configurado.',
    );
    const nonce = randomBytes(32).toString('base64url'),
      challengeId = randomUUID(),
      expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await store.insertGoogleChallenge({
      _id: challengeId,
      purpose,
      userId,
      nonceHash: nonceHash(nonce),
      expiresAt,
      createdAt: new Date(),
    });
    return { challengeId, nonce, clientId: config.googleClientId, expiresIn: 300 };
  }
  async function verifiedGoogle(input, purpose, userId = null) {
    const data = googleInput.parse(input);
    const challenge = await store.findGoogleChallenge(data.challengeId, purpose, userId);
    ensure(challenge, 401, 'GOOGLE_CHALLENGE_EXPIRED', 'Vuelve a abrir el acceso con Google.');
    const identity = await googleIdentity.verify(data.credential);
    ensure(
      nonceHash(identity.nonce) === challenge.nonceHash,
      401,
      'INVALID_GOOGLE_NONCE',
      'La identificación de Google no corresponde a este intento.',
    );
    return { ...identity, challengeId: data.challengeId };
  }
  async function consume(repository, data, purpose, userId = null) {
    ensure(
      await repository.consumeGoogleChallenge(data.challengeId, purpose, userId),
      401,
      'GOOGLE_CHALLENGE_EXPIRED',
      'Este intento de Google ya se utilizó o venció.',
    );
  }
  async function identityTransaction(operation) {
    try {
      return await store.transaction(operation);
    } catch (error) {
      if (error.code !== 11000) throw error;
      return store.transaction(operation);
    }
  }
  return {
    async register(input, requestId) {
      const data = register.parse(input);
      const user = {
        _id: randomUUID(),
        name: data.name,
        email: data.email,
        passwordHash: await hashPassword(data.password),
        createdAt: new Date(),
      };
      return store.transaction(async (repository) => {
        await repository.insertUser(user);
        await security('auth.registered', user._id, requestId, repository);
        return issue(user, requestId, repository);
      });
    },
    async login(input, requestId) {
      const data = credentials.parse(input);
      const user = await store.findUserByEmail(data.email);
      const valid = await verifyPassword(data.password, user?.passwordHash ?? dummy);
      if (!user || !valid) {
        await security('auth.login.failed', null, requestId);
        ensure(false, 401, 'INVALID_CREDENTIALS', 'Credenciales incorrectas');
      }
      return store.transaction((repository) => issue(user, requestId, repository));
    },
    googleChallenge() {
      return googleChallenge('login');
    },
    async googleLogin(input, requestId) {
      let data;
      try {
        data = await verifiedGoogle(input, 'login');
      } catch (error) {
        await security('auth.google.login.failed', null, requestId);
        throw error;
      }
      return identityTransaction(async (repository) => {
        await consume(repository, data, 'login');
        let user = await repository.findUserByGoogleSub(data.subject);
        if (!user) {
          ensure(
            !(await repository.findUserByEmail(data.email)),
            409,
            'GOOGLE_LINK_REQUIRED',
            'Ya existe una cuenta con este correo. Inicia sesión con tu contraseña y vincula Google desde Mi perfil.',
          );
          user = {
            _id: randomUUID(),
            name: data.name || data.email.split('@')[0],
            email: data.email,
            googleSub: data.subject,
            googleEmail: data.email,
            googleLinkedAt: new Date(),
            createdAt: new Date(),
          };
          await repository.insertUser(user);
          await security('auth.google.registered', user._id, requestId, repository);
        }
        await security('auth.google.login', user._id, requestId, repository);
        return issue(user, requestId, repository);
      });
    },
    async googleLinkChallenge(ctx, input) {
      const data = z.strictObject({ password: z.string().min(12).max(128) }).parse(input);
      const user = await store.findUserById(ctx.userId);
      ensure(user, 401, 'INVALID_SESSION', 'Usuario no disponible');
      ensure(
        !user.googleSub,
        409,
        'GOOGLE_ALREADY_LINKED',
        'Esta cuenta ya tiene Google vinculado.',
      );
      if (!(await verifyPassword(data.password, user.passwordHash ?? dummy))) {
        await security('auth.google.link.failed', ctx.userId, ctx.requestId);
        ensure(false, 401, 'INVALID_CREDENTIALS', 'La contraseña no es correcta.');
      }
      return googleChallenge('link', ctx.userId);
    },
    async googleLink(ctx, input) {
      const data = await verifiedGoogle(input, 'link', ctx.userId);
      return identityTransaction(async (repository) => {
        await consume(repository, data, 'link', ctx.userId);
        const user = await repository.findUserById(ctx.userId),
          other = await repository.findUserByGoogleSub(data.subject);
        ensure(user, 401, 'INVALID_SESSION', 'Usuario no disponible');
        ensure(
          !user.googleSub || user.googleSub === data.subject,
          409,
          'GOOGLE_ALREADY_LINKED',
          'Esta cuenta ya tiene otro Google vinculado.',
        );
        ensure(
          !other || other._id === user._id,
          409,
          'GOOGLE_ACCOUNT_IN_USE',
          'Esa cuenta de Google ya está vinculada a otra cuenta de Nexo.',
        );
        await repository.setGoogleIdentity(user._id, data.subject, data.email);
        await security('auth.google.linked', user._id, ctx.requestId, repository);
        return publicUser({ ...user, googleSub: data.subject, googleEmail: data.email });
      });
    },
    async authenticate(header) {
      ensure(
        typeof header === 'string' && /^Bearer [^\s]+$/i.test(header),
        401,
        'UNAUTHORIZED',
        'Se requiere Authorization: Bearer <token>',
      );
      let payload;
      try {
        ({ payload } = await jwtVerify(header.slice(7), secret, {
          algorithms: ['HS256'],
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
          requiredClaims: ['sub', 'sid', 'exp', 'iat'],
        }));
      } catch {
        ensure(false, 401, 'INVALID_TOKEN', 'Token inválido o vencido');
      }
      ensure(
        typeof payload.sub === 'string' && typeof payload.sid === 'string',
        401,
        'INVALID_TOKEN',
        'Token inválido',
      );
      const session = await store.findActiveSession(payload.sid, payload.sub);
      ensure(session, 401, 'INVALID_SESSION', 'Sesión finalizada');
      return { userId: payload.sub, sessionId: payload.sid };
    },
    async me(ctx) {
      const u = await store.findUserById(ctx.userId);
      ensure(u, 401, 'INVALID_SESSION', 'Usuario no disponible');
      return publicUser(u);
    },
    async logout(ctx) {
      return store.transaction(async (repository) => {
        await repository.revokeSession(ctx.sessionId, ctx.userId);
        await security('auth.logout', ctx.userId, ctx.requestId, repository);
        return { revoked: true };
      });
    },
  };
}
