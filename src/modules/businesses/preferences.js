import { z, id, date } from '../../core/validation.js';
const unique = (schema, max) =>
  z
    .array(schema)
    .max(max)
    .refine((v) => new Set(v).size === v.length, 'Valores repetidos');
const account = z.union([
  id,
  z
    .string()
    .refine(
      (value) => value.startsWith('credit:') && id.safeParse(value.slice(7)).success,
      'Línea inválida',
    ),
]);
export const widgetSchema = z
  .strictObject({
    id,
    title: z.string().trim().min(1).max(80),
    type: z.enum(['chart', 'list', 'metric']),
    preset: z.enum([
      'activity',
      'inflows',
      'outflows',
      'creditPurchases',
      'creditPayments',
      'balances',
      'debt',
      'availableCredit',
      'lowStock',
      'projects',
    ]),
    accounts: unique(account, 200),
    periodMode: z.enum(['global', 'all', 'custom']),
    from: date.optional(),
    to: date.optional(),
    category: z.string().trim().max(200),
    limit: z.number().int().min(3).max(50),
    size: z.enum(['normal', 'wide']),
    columns: z.number().int().min(3).max(12).optional(),
    height: z.number().int().min(220).max(1200).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .refine(
    (w) => w.periodMode !== 'custom' || (w.from && w.to && w.from <= w.to),
    'Revisa el intervalo de fechas',
  );
export const preferencesSchema = z.strictObject({
  revision: z.number().int().min(0),
  preferences: z.strictObject({
    version: z.literal(1),
    walletOrder: unique(id, 500),
    creditOrder: unique(id, 500),
    widgets: z
      .array(widgetSchema)
      .max(24)
      .refine((v) => new Set(v.map((w) => w.id)).size === v.length, 'Widgets repetidos'),
  }),
});
export function personalPreferences(member) {
  return {
    uiPreferences: member.uiPreferences ?? null,
    preferencesRevision: member.preferencesRevision ?? 0,
  };
}
