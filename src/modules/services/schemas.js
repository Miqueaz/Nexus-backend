import { z, id, text, notes, money, qty } from '../../core/validation.js';
export const materialInput = z.strictObject({
  itemId: id,
  quantityMilli: qty,
  unit: text,
  batchId: id.optional(),
});
export const serviceSchema = z.strictObject({
  name: text,
  description: notes,
  priceMinor: money,
  materials: z
    .array(materialInput.omit({ batchId: true }))
    .max(50)
    .default([]),
});
