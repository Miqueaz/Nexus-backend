import { randomUUID, createHash } from 'node:crypto';
import { z, id, revision, parsePatch } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { businessCreateSchema, businessUpdateSchema, businessSettings } from './settings.js';
export function createBusinessService({ uow, directory, audit, commands, idempotency }) {
  return {
    async list(ctx) {
      return (await directory.listForUser(ctx.userId)).map(businessSettings);
    },
    async get(ctx) {
      return commands.read(ctx, async (tx) => {
        const business = await tx.get('businesses', ctx.businessId);
        const member = (await tx.find('memberships', { userId: ctx.userId }))[0];
        return businessSettings({ ...business, role: member.role });
      });
    },
    async create(ctx, input) {
      const data = businessCreateSchema.parse(input);
      ensure(
        !ctx.key || /^[A-Za-z0-9_.:-]{8,120}$/.test(ctx.key),
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key debe tener 8 a 120 caracteres',
      );
      const digest = createHash('sha256')
        .update(ctx.userId + ':' + (ctx.key ?? randomUUID()))
        .digest('hex');
      const businessId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      const hash = createHash('sha256')
        .update(JSON.stringify({ userId: ctx.userId, data }))
        .digest('hex');
      const operation = async (tx) => {
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
        // El ID del agregado coincide con el límite de aislamiento del negocio.
        const business = await tx.insert('businesses', data, businessId);
        await tx.insert('memberships', { userId: ctx.userId, role: 'owner' });
        await audit.append(tx, ctx, 'business.created');
        if (ctx.key)
          await idempotency.save(tx, {
            key: ctx.key,
            hash,
            response: business,
            createdAt: new Date(),
          });
        return business;
      };
      try {
        return await uow.run(businessId, operation);
      } catch (error) {
        if (error.code === 11000 && ctx.key) return uow.run(businessId, operation);
        throw error;
      }
    },
    async update(ctx, input) {
      const data = parsePatch(businessUpdateSchema, input);
      return commands.run(
        ctx,
        'business.updated',
        data,
        async (tx) =>
          businessSettings(await tx.update('businesses', ctx.businessId, data.revision, data)),
        { owner: true },
      );
    },
    async members(ctx) {
      return commands.read(ctx, (tx) => tx.find('memberships'));
    },
    async addMember(ctx, input) {
      const data = z
        .strictObject({
          email: z.email().transform((s) => s.toLowerCase()),
          role: z.enum(['editor', 'viewer']),
        })
        .parse(input);
      return commands.run(
        ctx,
        'membership.added',
        data,
        async (tx) => {
          const user = await directory.findUserByEmail(tx, data.email);
          ensure(user, 404, 'USER_NOT_FOUND', 'El usuario debe registrarse primero');
          return tx.insert('memberships', { userId: user._id, role: data.role });
        },
        { owner: true },
      );
    },
    async changeMember(ctx, memberId, input) {
      id.parse(memberId);
      const data = z
        .strictObject({ role: z.enum(['editor', 'viewer', 'removed']), revision })
        .parse(input);
      return commands.run(
        ctx,
        'membership.updated',
        { memberId, ...data },
        async (tx) => {
          const m = await tx.get('memberships', memberId);
          ensure(
            m.role !== 'owner',
            422,
            'OWNER_PROTECTED',
            'No se puede modificar al propietario',
          );
          return tx.update('memberships', memberId, data.revision, { role: data.role });
        },
        { owner: true },
      );
    },
  };
}
