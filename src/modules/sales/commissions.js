import { z, id, text, notes, money } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { roundRatio, safeInteger, lineAmount, lineRevenue } from '../../core/money.js';
export const commissionSchema = z
  .strictObject({
    contactId: id.optional(),
    walletId: id.optional(),
    serviceId: id.optional(),
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
    let totalMinor = commercial.totalMinor,
      profitMinor = commercial.profitMinor,
      serviceName;
    if (commission.serviceId) {
      const lines = (commercial.lines || []).filter((l) => l.serviceId === commission.serviceId);
      ensure(
        lines.length,
        422,
        'COMMISSION_SERVICE',
        'La comisión debe corresponder a un servicio incluido en esta venta',
      );
      const subtotal = lines.reduce((n, l) => safeInteger(n + lineRevenue(l)), 0);
      const cost = lines.reduce(
        (n, l) =>
          safeInteger(
            n +
              (l.costTotalMinor ??
                lineAmount(l.unitCostMinor, l.consumedQuantityMilli ?? l.quantityMilli)),
          ),
        0,
      );
      totalMinor = commercial.subtotalMinor
        ? roundRatio(BigInt(commercial.totalMinor) * BigInt(subtotal), commercial.subtotalMinor)
        : 0;
      profitMinor = totalMinor - cost;
      serviceName = lines[0].name;
    }
    const baseMinor = commission.base === 'profit' ? Math.max(0, profitMinor) : totalMinor;
    const amountMinor =
      commission.type === 'fixed'
        ? commission.value
        : roundRatio(BigInt(baseMinor) * BigInt(commission.value), 10000);
    commissionTotalMinor = safeInteger(commissionTotalMinor + amountMinor);
    commissions.push({
      ...commission,
      name: contact?.name || commission.name,
      ...(contact?.userId ? { userId: contact.userId } : {}),
      ...(serviceName ? { serviceName } : {}),
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
