import { requestedLink } from './user-links.js';
import { randomUUID } from 'node:crypto';
import { commissionProfile } from './commission-profile.js';
import { ensure } from '../../core/errors.js';
import { parsePatch, z, text, notes, id, revision, values } from '../../core/validation.js';
import { listIds, validateListValues } from '../inventory/flexible-lists.js';
const schema = z.strictObject({
  name: text,
  userId: id.nullable().optional(),
  commissionProfile: commissionProfile.optional(),
  listIds,
  values,
  phone: z.string().max(60).default(''),
  email: z.union([z.email(), z.literal('')]).default(''),
  occupation: z.string().max(200).default(''),
  location: z.string().max(500).default(''),
  links: z
    .array(
      z.url().refine((v) => {
        const u = new URL(v);
        return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
      }),
    )
    .max(20)
    .default([]),
  notes,
  favorite: z.boolean().default(false),
});
export function createContactsService({ commands, contactUsers, commissionWallets }) {
  async function validateLinks(tx, d) {
    if (d.userId) await contactUsers.assert(tx, d.userId);
    if (d.commissionProfile)
      for (const rule of d.commissionProfile.services) {
        const service = await tx.get('services', rule.serviceId);
        ensure(
          !d.commissionProfile.enabled || !service.archived,
          422,
          'SERVICE_ARCHIVED',
          'El servicio de la condición está archivado',
        );
      }
  }
  return {
    users(ctx) {
      return commands.read(
        ctx,
        async (tx) => ({ data: await contactUsers.list(tx), nextCursor: null }),
        { module: 'contacts' },
      );
    },
    create(ctx, input) {
      const d = schema.parse(input);
      return commands.run(ctx, 'contact.created', d, async (tx) => {
        await validateListValues(tx, 'contactLists', d.listIds, d.values);
        await validateLinks(tx, d);
        const contactId = randomUUID();
        let profile = d.commissionProfile;
        if (profile?.enabled) {
          const wallet = await commissionWallets.resolve(
            tx,
            { contactId, name: d.name, walletId: profile.walletId, newContact: true },
            true,
          );
          profile = { ...profile, walletId: wallet._id };
        }
        return tx.insert(
          'contacts',
          {
            ...requestedLink(ctx, d),
            ...(profile ? { commissionProfile: profile } : {}),
            archived: false,
          },
          contactId,
        );
      });
    },
    update(ctx, contactId, input) {
      id.parse(contactId);
      const d = parsePatch(
        schema.partial().extend({ archived: z.boolean().optional(), revision }),
        input,
      );
      return commands.run(ctx, 'contact.updated', { contactId, ...d }, async (tx) => {
        const old = await tx.get('contacts', contactId);
        const next = { ...old, ...d };
        await validateLinks(tx, d);
        await validateListValues(tx, 'contactLists', next.listIds, next.values);
        let profile = d.commissionProfile;
        if (profile?.enabled) {
          const requested = Object.hasOwn(d.commissionProfile, 'walletId')
            ? d.commissionProfile.walletId
            : old.commissionProfile?.walletId;
          const wallet = await commissionWallets.resolve(
            tx,
            { contactId, name: next.name, walletId: requested },
            requested !== old.commissionProfile?.walletId ||
              !old.commissionProfile?.enabled ||
              !old.commissionProfile?.walletId,
          );
          profile = { ...d.commissionProfile, walletId: wallet._id };
        }
        return tx.update(
          'contacts',
          contactId,
          d.revision,
          requestedLink(ctx, { ...d, ...(profile ? { commissionProfile: profile } : {}) }, old),
        );
      });
    },
  };
}
