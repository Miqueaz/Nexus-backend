import { id, revision, z, parsePatch } from '../../core/validation.js';
import { serviceSchema } from './schemas.js';
export function createServiceCatalog({ commands, inventory }) {
  return {
    create(ctx, input) {
      const data = serviceSchema.parse(input);
      return commands.run(ctx, 'serviceCatalog.created', data, async (tx) => {
        await inventory.prepareMaterials(tx, data.materials);
        return tx.insert('services', { ...data, archived: false });
      });
    },
    update(ctx, serviceId, input) {
      id.parse(serviceId);
      const data = parsePatch(
        serviceSchema.partial().extend({ revision, archived: z.boolean().optional() }),
        input,
      );
      return commands.run(ctx, 'serviceCatalog.updated', { serviceId, ...data }, async (tx) => {
        await tx.get('services', serviceId);
        if (data.materials) await inventory.prepareMaterials(tx, data.materials);
        return tx.update('services', serviceId, data.revision, data);
      });
    },
  };
}
