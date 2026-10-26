import { z, id, text, notes, money } from '../../core/validation.js';
import { roundRatio, safeInteger } from '../../core/money.js';
export const commissionSchema = z
  .strictObject({
    contactId: id.optional(),
    name: text.optional(),
    type: z.enum(['percent', 'fixed']),
    value: money,
    base: z.enum(['sale', 'profit']).default('sale'),
    description: notes,
  })
  .refine(
    (c) => c.contactId || c.name,
    'Selecciona un contacto o escribe el nombre del comisionista',
  )
  .refine(
    (c) => c.type !== 'percent' || c.value <= 10000,
    'El porcentaje debe estar entre 0 y 100',
  );
export const commissionsInput = z.array(commissionSchema).max(50);
export const commissionsSchema = commissionsInput.default([]);
// Commissions are allocations of the sale, not cash payments. All bases are immutable snapshots.
export async function calculateCommissions(tx, input, commercial, contacts) {
  const commissions = [];
  let commissionTotalMinor = 0;
  for (const commission of input) {
    const contact = commission.contactId
      ? await contacts.assertCustomer(tx, commission.contactId)
      : null;
    const baseMinor =
      commission.base === 'profit' ? Math.max(0, commercial.profitMinor) : commercial.totalMinor;
    const amountMinor =
      commission.type === 'fixed'
        ? commission.value
        : roundRatio(BigInt(baseMinor) * BigInt(commission.value), 10000);
    commissionTotalMinor = safeInteger(commissionTotalMinor + amountMinor);
    commissions.push({
      ...commission,
      name: contact?.name || commission.name,
      baseMinor,
      amountMinor,
    });
  }
  return {
    commissions,
    commissionTotalMinor,
    netProfitMinor: safeInteger(commercial.profitMinor - commissionTotalMinor),
  };
}
