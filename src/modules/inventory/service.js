import { stockConfig, assertConfiguration, adjustBatches } from './materials.js';
import { parsePatch, z, text, notes, money, id, revision, values } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { safeInteger } from '../../core/money.js';
import { listIds, validateListValues } from './flexible-lists.js';
const itemSchema = z.strictObject({
  name: text,
  stockConfig: stockConfig.optional(),
  sku: z.string().trim().min(1).max(80).optional(),
  unit: text.default('unidad'),
  listIds,
  values,
  notes,
  trackStock: z.boolean().default(true),
  sellable: z.boolean().default(true),
  priceMinor: money.default(0),
  costMinor: money.default(0),
  minStockMilli: z.number().int().nonnegative().max(1e9).default(0),
});
export function createInventoryService({ commands }) {
  return {
    create(ctx, input) {
      const d = itemSchema.parse(input);
      return commands.run(ctx, 'inventory.item.created', d, async (tx) => {
        await validateListValues(tx, 'inventoryLists', d.listIds, d.values);
        if (!d.stockConfig) {
          for (const listId of d.listIds) { const list = await tx.get('inventoryLists', listId); if (!list.inventoryDefaults) continue; const { unit, trackStock, sellable, ...config } = list.inventoryDefaults; d.stockConfig = config; for (const [key,value] of Object.entries({unit,trackStock,sellable})) if (!Object.hasOwn(input,key)) d[key]=value; break; }
        }
        assertConfiguration(d);
        return tx.insert('items', { ...d, ...(d.stockConfig?.tracking === 'batches' ? {batches: []} : {}), stockMilli: 0, archived: false });
      });
    },
    update(ctx, itemId, input) {
      id.parse(itemId);
      const d = parsePatch(
        itemSchema.partial().extend({ archived: z.boolean().optional(), revision }),
        input,
      );
      return commands.run(ctx, 'inventory.item.updated', { itemId, ...d }, async (tx) => {
        const item = await tx.get('items', itemId);
        const next = { ...item, ...d };
        assertConfiguration(next);
        ensure(item.stockMilli === 0 || (next.unit === item.unit && (next.stockConfig?.tracking || 'aggregate') === (item.stockConfig?.tracking || 'aggregate')), 409, 'STOCK_CONFIGURATION_LOCKED', 'Ajusta las existencias a cero antes de cambiar la unidad o el control por rollo');
        ensure(
          next.trackStock || item.stockMilli === 0,
          422,
          'STOCK_NOT_EMPTY',
          'Ajusta las existencias a cero antes de desactivar su conteo',
        );
        await validateListValues(tx, 'inventoryLists', next.listIds, next.values);
        return tx.update('items', itemId, d.revision, { ...d, ...(next.unit !== item.unit || (next.stockConfig?.tracking || 'aggregate') !== (item.stockConfig?.tracking || 'aggregate') ? {batches: []} : {}) });
      });
    },
    adjust(ctx, itemId, input) {
      id.parse(itemId);
      const d = z
        .strictObject({
          deltaMilli: z
            .number()
            .int()
            .min(-1e9)
            .max(1e9)
            .refine((v) => v !== 0),
          reason: text,
          batchId: id.optional(),
          batchLabel: text.optional(),
          batchCount: z.number().int().min(1).max(200).default(1),
          revision,
        })
        .parse(input);
      return commands.run(ctx, 'inventory.stock.adjusted', { itemId, ...d }, async (tx) => {
        const item = await tx.get('items', itemId);
        ensure(
          item.trackStock && !item.archived,
          422,
          'NOT_TRACKED',
          'Artículo no contable o archivado',
        );
        const stockMilli = safeInteger(item.stockMilli + d.deltaMilli);
        ensure(stockMilli >= 0, 422, 'INSUFFICIENT_STOCK', 'Existencias insuficientes');
        const {batches, allocations} = adjustBatches(item, d.deltaMilli, d);
        const updated = await tx.update('items', itemId, d.revision, { stockMilli, ...(batches ? {batches} : {}) });
        const movement = await tx.insert('stockMovements', {
          itemId,
          deltaMilli: d.deltaMilli,
          stockAfterMilli: stockMilli,
          reason: d.reason,
          kind: 'adjustment',
          unit: item.unit,
          ...(allocations.length ? {allocations} : {}),
        });
        return { item: updated, movement };
      });
    },
  };
}
