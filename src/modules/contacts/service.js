import { parsePatch, z, text, notes, id, revision, values } from '../../core/validation.js';
import { listIds, validateListValues } from '../inventory/flexible-lists.js';
const schema = z.strictObject({
  name: text,
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
export function createContactsService({ commands }) {
  return {
    create(ctx, input) {
      const d = schema.parse(input);
      return commands.run(ctx, 'contact.created', d, async (tx) => {
        await validateListValues(tx, 'contactLists', d.listIds, d.values);
        return tx.insert('contacts', { ...d, archived: false });
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
        await validateListValues(tx, 'contactLists', next.listIds, next.values);
        return tx.update('contacts', contactId, d.revision, d);
      });
    },
  };
}
