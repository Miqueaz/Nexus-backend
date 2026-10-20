import { randomUUID } from 'node:crypto';
import { z, text, id, revision } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
export function createBusinessService({ uow, directory, audit, commands }) {
  return {
    async list(ctx) {
      return directory.listForUser(ctx.userId);
    },
    async create(ctx, input) {
      const data = z
        .strictObject({
          name: text,
          currency: z.string().regex(/^[A-Z]{3}$/),
          timezone: z
            .string()
            .max(80)
            .refine((v) => {
              try {
                new Intl.DateTimeFormat('en', { timeZone: v });
                return true;
              } catch {
                return false;
              }
            }, 'Zona IANA inválida')
            .default('America/Mexico_City'),
        })
        .parse(input);
      const businessId = randomUUID();
      return uow.run(businessId, async (tx) => {
        // El ID del agregado coincide con el límite de aislamiento del negocio.
        const business = await tx.insert('businesses', data, businessId);
        await tx.insert('memberships', { userId: ctx.userId, role: 'owner' });
        await audit.append(tx, ctx, 'business.created');
        return business;
      });
    },
    async update(ctx, input) {
      const data = z.strictObject({ name: text, revision }).parse(input);
      return commands.run(
        ctx,
        'business.updated',
        data,
        (tx) => tx.update('businesses', ctx.businessId, data.revision, { name: data.name }),
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
