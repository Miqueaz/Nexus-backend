import { convertQuantity, adjustBatches } from '../../modules/inventory/materials.js';
import { ensure } from '../../core/errors.js';
export function createInventoryAdapter() {
  return {
    async prepareMaterials(tx, materials) {
      const snapshots = [];
      for (const material of materials) {
        const item = await tx.get('items', material.itemId);
        ensure(
          !item.archived && item.trackStock,
          422,
          'MATERIAL_UNAVAILABLE',
          'El material debe estar activo y tener conteo de existencias',
        );
        const source = material.consumption || material;
        const consumedQuantityMilli = convertQuantity(source.quantityMilli, source.unit, item.unit);
        ensure(
          consumedQuantityMilli > 0,
          422,
          'INVALID_CONSUMPTION',
          'El consumo debe ser mayor que cero',
        );
        snapshots.push({
          itemId: item._id,
          name: item.name,
          unit: item.unit,
          stockUnit: item.unit,
          quantityMilli: consumedQuantityMilli,
          consumedQuantityMilli,
          unitPriceMinor: 0,
          unitCostMinor: item.costMinor,
          trackStock: true,
          consumption: {
            quantityMilli: source.quantityMilli,
            unit: source.unit,
            ...(source.batchId ? { batchId: source.batchId } : {}),
          },
        });
      }
      return snapshots;
    },
    async prepare(tx, lines) {
      const snapshots = [];
      for (const line of lines) {
        if (!line.itemId) {
          ensure(
            !line.consumption,
            422,
            'MATERIAL_REQUIRED',
            'Selecciona un artículo para consumir material',
          );
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
        const pricing = item.stockConfig?.pricing || 'unit';
        const priceUnit =
          pricing === 'measure' ? item.stockConfig?.priceUnit || item.unit : item.unit;
        if (Object.hasOwn(line, 'trackStock'))
          ensure(
            (line.stockUnit || line.unit) === item.unit &&
              line.unit === priceUnit &&
              (line.pricing || 'unit') === pricing,
            409,
            'QUOTE_MATERIAL_CHANGED',
            'Cambió la unidad o forma de cobro del material; crea una cotización actualizada',
          );
        ensure(
          pricing === 'unit' || line.consumption,
          422,
          'CONSUMPTION_REQUIRED',
          'Indica cuánto material usaste en este trabajo',
        );
        const consumedQuantityMilli = line.consumption
          ? convertQuantity(line.consumption.quantityMilli, line.consumption.unit, item.unit)
          : line.quantityMilli;
        ensure(
          consumedQuantityMilli > 0,
          422,
          'INVALID_CONSUMPTION',
          'El consumo debe ser mayor que cero',
        );
        ensure(
          pricing !== 'unit' || consumedQuantityMilli === line.quantityMilli,
          422,
          'INVALID_CONSUMPTION',
          'En venta por pieza la cantidad vendida debe coincidir con el consumo',
        );
        const quantityMilli =
          pricing === 'fixed'
            ? 1000
            : pricing === 'measure'
              ? convertQuantity(consumedQuantityMilli, item.unit, priceUnit)
              : line.quantityMilli;
        snapshots.push({
          ...line,
          quantityMilli,
          consumedQuantityMilli,
          pricing,
          name: line.name ?? item.name,
          unit: priceUnit,
          stockUnit: item.unit,
          unitPriceMinor: line.unitPriceMinor ?? item.priceMinor,
          unitCostMinor: item.costMinor,
          trackStock: item.trackStock,
        });
      }
      return snapshots;
    },
    async consume(tx, lines, reference, context = {}) {
      // Obtener la versión actual en cada línea también cubre IDs repetidos.
      for (const line of lines) {
        if (line.materials)
          await this.consume(tx, line.materials, reference, {
            serviceId: line.serviceId,
            serviceName: line.name,
          });
        if (!line.itemId || !line.trackStock) continue;
        const item = await tx.get('items', line.itemId);
        ensure(
          item.stockMilli >= (line.consumedQuantityMilli ?? line.quantityMilli),
          422,
          'INSUFFICIENT_STOCK',
          `Existencias insuficientes: ${item.name}`,
        );
        const consumed = line.consumedQuantityMilli ?? line.quantityMilli;
        const stockMilli = item.stockMilli - consumed;
        const { batches, allocations } = adjustBatches(item, -consumed, {
          batchId: line.consumption?.batchId,
        });
        line.allocations = allocations;
        await tx.update('items', item._id, item.revision, {
          stockMilli,
          ...(batches ? { batches } : {}),
        });
        await tx.insert('stockMovements', {
          itemId: item._id,
          deltaMilli: -consumed,
          unit: item.unit,
          ...(allocations.length ? { allocations } : {}),
          stockAfterMilli: stockMilli,
          kind: 'sale',
          reason: context.serviceName ? 'Servicio: ' + context.serviceName : 'Venta',
          ...(context.serviceId ? { serviceId: context.serviceId } : {}),
          reference,
        });
      }
    },
  };
}
