import { z, id, notes, money } from '../../core/validation.js';
export const commissionTerms = z
  .strictObject({
    type: z.enum(['percent', 'fixed']),
    value: money,
    base: z.enum(['sale', 'profit']).default('sale'),
    description: notes,
  })
  .refine((c) => c.type !== 'percent' || c.value <= 10000, 'El porcentaje máximo es 100');
export const commissionProfile = z
  .strictObject({
    enabled: z.boolean(),
    walletId: id.nullable().optional(),
    default: commissionTerms,
    services: z
      .array(commissionTerms.safeExtend({ serviceId: id }))
      .max(50)
      .default([]),
  })
  .refine(
    (c) => new Set(c.services.map((r) => r.serviceId)).size === c.services.length,
    'No repitas un servicio en las condiciones',
  );
