import { randomUUID } from 'node:crypto';
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
const publicUser = (u) => ({ _id: u._id, name: u.name, email: u.email });
export async function createAuthService({ store, config, logger }) {
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
