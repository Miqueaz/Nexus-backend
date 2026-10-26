import { inventoryDefaults } from './materials.js';
import {
  parsePatch,
  z,
  text,
  notes,
  fields,
  id,
  revision,
  validateFields,
} from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
export function createListService({ commands, collection, entryCollection }) {
  return {
    create(ctx, input) {
      const d = z.strictObject({ name: text, description: notes, fields, ...(collection === 'inventoryLists' ? { inventoryDefaults: inventoryDefaults.optional() } : {}) }).parse(input);
      return commands.run(ctx, `${collection}.created`, d, (tx) =>
        tx.insert(collection, { ...d, archived: false }),
      );
    },
    update(ctx, listId, input) {
      id.parse(listId);
      const d = parsePatch(
        z.strictObject({
          name: text.optional(),
          description: notes.optional(),
          fields: fields.optional(),
          ...(collection === 'inventoryLists' ? { inventoryDefaults: inventoryDefaults.optional() } : {}),
          archived: z.boolean().optional(),
          revision,
        }),
        input,
      );
      return commands.run(ctx, `${collection}.updated`, { listId, ...d }, async (tx) => {
        const previous = await tx.get(collection, listId);
        if (d.fields && JSON.stringify(d.fields) !== JSON.stringify(previous.fields)) {
          const used = await tx.find(entryCollection, { listIds: listId });
          ensure(
            used.length === 0,
            409,
            'SCHEMA_IN_USE',
            'La lista tiene registros; crea otra lista para cambiar su esquema',
          );
        }
        return tx.update(collection, listId, d.revision, d);
      });
    },
  };
}
export async function validateListValues(tx, collection, listIds, values) {
  const merged = new Map();
  for (const listId of listIds) {
    const list = await tx.get(collection, listId);
    ensure(!list.archived, 422, 'LIST_ARCHIVED', 'Lista archivada');
    for (const field of list.fields) {
      const previous = merged.get(field.key);
      ensure(
        !previous || previous.type === field.type,
        422,
        'FIELD_CONFLICT',
        'Dos listas usan la misma clave con diferente tipo',
      );
      merged.set(field.key, { ...field, required: field.required || previous?.required || false });
    }
  }
  return validateFields([...merged.values()], values);
}
export const listIds = z
  .array(id)
  .min(1)
  .max(20)
  .refine((a) => new Set(a).size === a.length, 'Listas repetidas');
