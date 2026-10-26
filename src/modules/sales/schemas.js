import { commissionsSchema } from './commissions.js';
import { materialInput } from '../services/schemas.js';
import { z, id, text, notes, money, qty, discount, date } from '../../core/validation.js';
export const line = z
  .strictObject({
    itemId: id.optional(),
    serviceId: id.optional(),
    materials: z.array(materialInput).max(50).optional(),
    consumption: z
      .strictObject({ quantityMilli: qty, unit: text, batchId: id.optional() })
      .optional(),
    name: text.optional(),
    quantityMilli: qty,
    unitPriceMinor: money.optional(),
    unitCostMinor: money.optional(),
  })
  .refine(
    (l) => l.itemId || l.serviceId || (l.name && l.unitPriceMinor !== undefined),
    'Una línea libre requiere nombre y precio',
  )
  .refine(
    (l) =>
      !(l.itemId && (l.serviceId || l.materials !== undefined)) &&
      !(l.consumption && (l.serviceId || l.materials !== undefined)),
    'Selecciona un producto o un servicio por concepto',
  );
export const quoteSchema = z.strictObject({
  customerId: id.optional(),
  title: text,
  lines: z.array(line).min(1).max(100),
  discount,
  notes,
  expiresOn: date,
});
export const saleSchema = z.strictObject({
  commissions: commissionsSchema,
  walletId: id,
  customerId: id.optional(),
  lines: z.array(line).min(1).max(100),
  discount,
  description: notes,
});
