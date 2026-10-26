import { randomUUID } from 'node:crypto';
import { z, qty, text } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
// Integer scale factors keep cm ↔ m conversions exact; incompatible dimensions never mix.
export const units = { mm: ['length', 1], cm: ['length', 10], m: ['length', 1000], g: ['mass', 1], kg: ['mass', 1000], ml: ['volume', 1], l: ['volume', 1000], m2: ['area', 1] };
export const stockConfig = z.strictObject({
  pricing: z.enum(['unit', 'measure', 'fixed']).default('unit'),
  priceUnit: text.optional(),
  tracking: z.enum(['aggregate', 'batches']).default('aggregate'),
  packageSizeMilli: qty.default(1000),
});
export const inventoryDefaults = stockConfig.extend({
  unit: text.default('unidad'), trackStock: z.boolean().default(true), sellable: z.boolean().default(true),
}).superRefine((d, ctx) => {
  if(d.pricing !== 'unit' && !units[d.unit]) ctx.addIssue({code:'custom',path:['unit'],message:'Selecciona una unidad de medida compatible'});
  if(d.pricing === 'measure' && d.priceUnit && (!units[d.unit] || !units[d.priceUnit] || units[d.unit][0] !== units[d.priceUnit][0])) ctx.addIssue({code:'custom',path:['priceUnit'],message:'La unidad de cobro debe ser compatible con la de inventario'});
  if(d.tracking === 'batches' && !d.trackStock) ctx.addIssue({code:'custom',path:['trackStock'],message:'El control por rollo requiere contar existencias'});
});
export function convertQuantity(value, from, to) {
  if (from === to) return value;
  ensure(units[from] && units[to] && units[from][0] === units[to][0], 422, 'INCOMPATIBLE_UNIT', 'Las unidades de medida no son compatibles');
  const scaled = BigInt(value) * BigInt(units[from][1]), denominator = BigInt(units[to][1]);
  ensure(scaled % denominator === 0n, 422, 'QUANTITY_PRECISION', 'La cantidad convertida debe tener como máximo tres decimales');
  const result = Number(scaled / denominator);
  ensure(Number.isSafeInteger(result) && Math.abs(result) <= 1e9, 422, 'QUANTITY_RANGE', 'Cantidad fuera de rango');
  return result;
}
export function assertConfiguration(item) {
  const config = item.stockConfig;
  if (!config) return;
  ensure(config.pricing === 'unit' || units[item.unit], 422, 'INVALID_UNIT', 'Selecciona una unidad de medida compatible');
  if (config.pricing === 'measure' && config.priceUnit) ensure(units[item.unit] && units[config.priceUnit] && units[item.unit][0] === units[config.priceUnit][0], 422, 'INCOMPATIBLE_UNIT', 'La unidad de cobro debe ser compatible con la de inventario');
  ensure(config.tracking !== 'batches' || item.trackStock, 422, 'NOT_TRACKED', 'El control por rollo requiere contar existencias');
}
// Embedded batches share the item revision and transaction: stock and roll balances cannot diverge.
export function adjustBatches(item, delta, { batchId, batchLabel, batchCount = 1 } = {}) {
  if (item.stockConfig?.tracking !== 'batches') {
    ensure(!batchId && !batchLabel && batchCount === 1, 422, 'BATCH_DISABLED', 'Este artículo se controla por saldo total');
    return { batches: undefined, allocations: [] };
  }
  const batches = (item.batches || []).filter(b => delta < 0 || b.remainingMilli > 0).map(b => ({ ...b })), allocations = [];
  if (delta > 0) {
    ensure(!batchId, 422, 'BATCH_ENTRY', 'Registra el nuevo rollo como una entrada independiente');
    ensure(batches.length + batchCount <= 200 && delta % batchCount === 0, 422, 'BATCH_LIMIT', 'Usa hasta 200 rollos por ficha y cantidades iguales con tres decimales');
    for (let i = 0; i < batchCount; i++) {
      const quantity = delta / batchCount;
      const id = randomUUID();
      const batch = { id, label: batchLabel ? batchLabel + (batchCount > 1 ? ' ' + (i + 1) : '') : 'Rollo ' + id.slice(0, 8), initialMilli: quantity, remainingMilli: quantity };
      batches.push(batch); allocations.push({ batchId: batch.id, label: batch.label, quantityMilli: quantity });
    }
  } else {
    let remaining = -delta;
    if (batchId) ensure(batches.some(b => b.id === batchId), 422, 'BATCH_NOT_FOUND', 'El rollo no pertenece a este material');
    for (const batch of batches) {
      if (batchId && batch.id !== batchId) continue;
      const used = Math.min(remaining, batch.remainingMilli);
      if (used) { batch.remainingMilli -= used; remaining -= used; allocations.push({ batchId: batch.id, label: batch.label, quantityMilli: used }); }
      if (!remaining) break;
    }
    ensure(remaining === 0, 422, 'INSUFFICIENT_BATCH', 'El rollo seleccionado no tiene material suficiente');
  }
  return { batches, allocations };
}
