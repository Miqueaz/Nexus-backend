import { createHash } from 'node:crypto';
import { ensure } from '../../core/errors.js';
import { defaultPolicy, updatePolicySchema } from './settings.js';
import { resourceModules } from '../../adapters/modules/workspace-access.js';
export function createPlatformService({ store, config, uow, audit, idempotency, logger }) {
  const bootstrapEmails = config.platformAdminEmails ?? [],
    adminIds = config.platformAdminUserIds ?? [];
  // A self-declared email from portal registration is never proof of ownership.
  const isAdmin = (user) =>
    !!user &&
    (adminIds.includes(user._id) ||
      (!!user.googleSub && bootstrapEmails.includes((user.googleEmail || '').toLowerCase())));
  const role = (user) => (isAdmin(user) ? 'admin' : 'user');
  async function read(tx) {
    if (tx?.platformPolicy) return tx.platformPolicy;
    const stored = await store.read(tx?.session);
    const d = stored ?? { ...defaultPolicy(config), revision: 0 };
    const result = {
      registration: d.registration,
      login: d.login,
      enabledModules: d.enabledModules,
      features: d.features,
      revision: d.revision,
      googleConfigured: !!config.googleClientId,
    };
    if (tx) tx.platformPolicy = result;
    return result;
  }
  async function requireAdmin(ctx, tx) {
    const user = await store.user(ctx.userId, tx?.session);
    ensure(isAdmin(user), 403, 'ADMIN_REQUIRED', 'Se requiere administrador de la plataforma');
    return user;
  }
  function assertModule(policy, module) {
    ensure(
      !module || policy.enabledModules.includes(module),
      403,
      'MODULE_DISABLED_BY_ADMIN',
      'Este módulo fue desactivado por el administrador',
    );
  }
  async function assertFeature(feature, tx) {
    const p = await read(tx);
    ensure(
      p.features[feature],
      403,
      'FEATURE_DISABLED',
      'Esta función fue desactivada por el administrador',
    );
  }
  return {
    role,
    isAdmin,
    read,
    assertFeature,
    assertModule,
    async options() {
      const p = await read();
      return {
        registration: p.registration,
        login: p.login,
        googleConfigured: p.googleConfigured,
        features: p.features,
        enabledModules: p.enabledModules,
        revision: p.revision,
      };
    },
    async guardAuth(kind, repository) {
      const p = await read(repository?.session ? { session: repository.session } : undefined);
      const allowed = {
        portalRegistration: p.registration.portal,
        passwordLogin: p.login.password,
        googleLogin: p.login.google,
        googleRegistration: p.registration.google,
      }[kind];
      ensure(
        allowed,
        403,
        kind.endsWith('Registration') ? 'REGISTRATION_DISABLED' : 'LOGIN_METHOD_DISABLED',
        kind.endsWith('Registration')
          ? 'La creación de cuentas por este método está desactivada.'
          : 'Este método de inicio de sesión está desactivado.',
      );
    },
    async authorizeWorkspace(tx, ctx, member) {
      const p = await read(tx);
      const r = ctx.accessRequirement;
      assertModule(p, resourceModules[r?.resource]);
      if (r?.history) assertModule(p, 'history');
      member.platformEnabledModules = p.enabledModules;
      return member;
    },
    async get(ctx) {
      const actor = await requireAdmin(ctx);
      return {
        ...(await read()),
        actor: {
          _id: actor._id,
          name: actor.name,
          email: actor.email,
          googleLinked: !!actor.googleSub,
          passwordAvailable: !!actor.passwordHash,
        },
      };
    },
    async history(ctx) {
      await requireAdmin(ctx);
      return { data: await store.audit() };
    },
    async update(ctx, input) {
      await requireAdmin(ctx);
      const data = updatePolicySchema.parse(input);
      ensure(
        /^[A-Za-z0-9_.:-]{8,120}$/.test(ctx.key || ''),
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Incluye Idempotency-Key',
      );
      const hash = createHash('sha256')
        .update(JSON.stringify({ userId: ctx.userId, data }))
        .digest('hex');
      const run = async (tx) => {
        const actor = await requireAdmin(ctx, tx);
        const saved = await idempotency.get(tx, ctx.key);
        if (saved) {
          ensure(saved.hash === hash, 409, 'IDEMPOTENCY_CONFLICT', 'La clave ya se usó');
          return saved.response;
        }
        ensure(
          !data.login.google || config.googleClientId,
          422,
          'GOOGLE_NOT_CONFIGURED',
          'Configura GOOGLE_CLIENT_ID antes de habilitar Google',
        );
        ensure(
          !data.registration.google || config.googleClientId,
          422,
          'GOOGLE_NOT_CONFIGURED',
          'Configura GOOGLE_CLIENT_ID antes de habilitar el registro con Google',
        );
        ensure(
          (data.login.password && actor.passwordHash) || (data.login.google && actor.googleSub),
          422,
          'ADMIN_LOCKOUT',
          'Conserva un método que puedas usar para volver a entrar como administrador',
        );
        const { revision, ...policy } = data;
        const result = await store.write(tx, policy, revision);
        const response = {
          ...policy,
          revision: result.revision,
          googleConfigured: !!config.googleClientId,
        };
        await audit.append(tx, ctx, 'platform.settings.updated');
        await idempotency.save(tx, { key: ctx.key, hash, response, createdAt: new Date() });
        return response;
      };
      let result;
      try {
        result = await uow.run('platform', run);
      } catch (e) {
        if (e.code !== 11000) throw e;
        result = await uow.run('platform', run);
      }
      logger.info(
        { action: 'platform.settings.updated', actorId: ctx.userId, requestId: ctx.requestId },
        'administration.updated',
      );
      return result;
    },
  };
}
