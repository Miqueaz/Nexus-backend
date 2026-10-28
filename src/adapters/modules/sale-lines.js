import { ensure } from '../../core/errors.js';
import { lineAmount, safeInteger } from '../../core/money.js';
// Services and inventory keep separate catalogs; this adapter composes their sale snapshots.
export function createSaleLinesAdapter(inventory) {
  return {
    async prepare(tx, input) {
      const lines = [];
      let materialCount = 0;
      for (const line of input) {
        if (!line.serviceId && line.materials === undefined) {
          lines.push(...(await inventory.prepare(tx, [line])));
          continue;
        }
        const service = line.serviceId ? await tx.get('services', line.serviceId) : null;
        ensure(!service?.archived, 422, 'SERVICE_ARCHIVED', 'Este servicio está archivado');
        const materials =
          line.materials ??
          (service?.materials || []).map((material) => {
            const numerator = BigInt(material.quantityMilli) * BigInt(line.quantityMilli);
            ensure(
              numerator % 1000n === 0n,
              422,
              'QUANTITY_PRECISION',
              'El consumo por servicio debe tener como máximo tres decimales',
            );
            const quantityMilli = Number(numerator / 1000n);
            ensure(
              Number.isSafeInteger(quantityMilli) && quantityMilli > 0 && quantityMilli <= 1e9,
              422,
              'QUANTITY_RANGE',
              'Consumo fuera de rango',
            );
            return { ...material, quantityMilli };
          });
        materialCount += materials.length;
        ensure(
          materialCount <= 200,
          422,
          'MATERIAL_LIMIT',
          'Una operación admite hasta 200 consumos de material',
        );
        // Generated quote snapshots keep their agreed prices, including legacy quotes.
        const snapshots = await inventory.prepareMaterials(tx, materials, {
          serviceQuantityMilli: line.quantityMilli,
          priceMaterials:
            !Object.hasOwn(line, 'trackStock') || Object.hasOwn(line, 'materialSalesMinor'),
        });
        const unitCostMinor = service ? 0 : line.unitCostMinor || 0;
        const costTotalMinor = snapshots.reduce(
          (sum, m) => safeInteger(sum + lineAmount(m.unitCostMinor, m.consumedQuantityMilli)),
          lineAmount(unitCostMinor, line.quantityMilli),
        );
        const unitPriceMinor = line.unitPriceMinor ?? service?.priceMinor;
        const baseRevenueMinor = lineAmount(unitPriceMinor, line.quantityMilli);
        const materialSalesMinor = snapshots.reduce(
          (sum, m) => safeInteger(sum + m.saleTotalMinor),
          0,
        );
        lines.push({
          ...line,
          name: line.name || service?.name,
          serviceRevision: service?.revision,
          unit: 'servicio',
          unitPriceMinor,
          baseRevenueMinor,
          materialSalesMinor,
          revenueMinor: safeInteger(baseRevenueMinor + materialSalesMinor),
          unitCostMinor,
          costTotalMinor,
          trackStock: false,
          materials: snapshots,
        });
      }
      return lines;
    },
    consume: (...args) => inventory.consume(...args),
  };
}
