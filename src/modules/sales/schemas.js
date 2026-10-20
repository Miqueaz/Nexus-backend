import { z, id, text, notes, money, qty, discount, date } from '../../core/validation.js';
export const line = z
  .strictObject({
    itemId: id.optional(),
    name: text.optional(),
    quantityMilli: qty,
    unitPriceMinor: money.optional(),
    unitCostMinor: money.optional(),
  })
  .refine(
    (l) => l.itemId || (l.name && l.unitPriceMinor !== undefined),
    'Una línea libre requiere nombre y precio',
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
  walletId: id,
  customerId: id.optional(),
  lines: z.array(line).min(1).max(100),
  discount,
  description: notes,
});
