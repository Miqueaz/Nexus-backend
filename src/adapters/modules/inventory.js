import { ensure } from '../../core/errors.js';
export function createInventoryAdapter() {
  return {
    async prepare(tx, lines) {
      const snapshots = [];
      for (const line of lines) {
        if (!line.itemId) {
          snapshots.push({
            ...line,
            unitCostMinor: line.unitCostMinor ?? 0,
            unit: 'servicio',
            trackStock: false,
          });
          continue;
        }
        const item = await tx.get('items', line.itemId);
        ensure(
          !item.archived && item.sellable,
          422,
          'NOT_SELLABLE',
          'Artículo archivado o no vendible',
        );
        snapshots.push({
          ...line,
          name: line.name ?? item.name,
          unit: item.unit,
          unitPriceMinor: line.unitPriceMinor ?? item.priceMinor,
          unitCostMinor: item.costMinor,
          trackStock: item.trackStock,
        });
      }
      return snapshots;
    },
    async consume(tx, lines, reference) {
      // Obtener la versión actual en cada línea también cubre IDs repetidos.
      for (const line of lines) {
        if (!line.itemId || !line.trackStock) continue;
        const item = await tx.get('items', line.itemId);
        ensure(
          item.stockMilli >= line.quantityMilli,
          422,
          'INSUFFICIENT_STOCK',
          `Existencias insuficientes: ${item.name}`,
        );
        const stockMilli = item.stockMilli - line.quantityMilli;
        await tx.update('items', item._id, item.revision, { stockMilli });
        await tx.insert('stockMovements', {
          itemId: item._id,
          deltaMilli: -line.quantityMilli,
          stockAfterMilli: stockMilli,
          kind: 'sale',
          reason: 'Venta',
          reference,
        });
      }
    },
  };
}
