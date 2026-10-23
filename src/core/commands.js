import { createHash } from 'node:crypto';
import { ensure } from './errors.js';
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
export function createCommands({ uow, idempotency, audit, logger, moduleAccess, workspaceAccess }) {
  async function membership(tx, ctx, write = false, owner = false) {
    let member = (await tx.find('memberships', { userId: ctx.userId }))[0];
    ensure(member && member.role !== 'removed', 404, 'NOT_FOUND', 'Negocio no encontrado');
    if (workspaceAccess) {
      member = await workspaceAccess.resolve(member, tx.session);
      workspaceAccess.assertRoute(member, ctx);
      workspaceAccess.bind(tx, member);
    }
    ensure(
      !write || ['owner', 'editor'].includes(member.role),
      403,
      'FORBIDDEN',
      'Permisos de lectura',
    );
    ensure(!owner || member.role === 'owner', 403, 'FORBIDDEN', 'Se requiere propietario');
    return member;
  }
  return {
    membership,
    async run(ctx, action, input, operation, { owner = false } = {}) {
      ensure(
        !ctx.key || /^[A-Za-z0-9_.:-]{8,120}$/.test(ctx.key),
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key debe tener 8 a 120 caracteres',
      );
      const hash = createHash('sha256')
        .update(JSON.stringify(stable({ action, input, userId: ctx.userId })))
        .digest('hex');
      const operationInTx = async (tx) => {
        await membership(tx, ctx, true, owner);
        if (ctx.key) {
          const stored = await idempotency.get(tx, ctx.key);
          if (stored) {
            ensure(
              stored.hash === hash,
              409,
              'IDEMPOTENCY_CONFLICT',
              'La clave ya se usó con otra operación',
            );
            return stored.response;
          }
        }
        await moduleAccess.assertAction(tx, action);
        const response = await operation(tx);
        await audit.append(tx, ctx, action);
        if (ctx.key)
          await idempotency.save(tx, { key: ctx.key, hash, response, createdAt: new Date() });
        return response;
      };
      let result;
      try {
        result = await uow.run(ctx.businessId, operationInTx);
      } catch (error) {
        if (error.code === 11000 && error.keyPattern?.key && ctx.key)
          result = await uow.run(ctx.businessId, operationInTx);
        else throw error;
      }
      logger.info(
        { action, businessId: ctx.businessId, actorId: ctx.userId, requestId: ctx.requestId },
        'command.completed',
      );
      return result;
    },
    async read(ctx, operation, { module } = {}) {
      return uow.run(ctx.businessId, async (tx) => {
        const member = await membership(tx, ctx);
        if (module) {
          if (tx.accessMember?.access)
            ensure(
              ['read', 'write'].includes(tx.accessMember.access.permissions[module]),
              403,
              'MODULE_FORBIDDEN',
              'Módulo sin acceso',
            );
          await moduleAccess.assertEnabled(tx, module);
        }
        return operation(tx, member);
      });
    },
  };
}
