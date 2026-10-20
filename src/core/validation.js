import { z } from 'zod';
export { z };
export const id = z.uuid();
export const text = z.string().trim().min(1).max(200);
export const notes = z.string().trim().max(4000).default('');
export const money = z.number().int().min(0).max(100_000_000_000);
export const amount = money.refine((v) => v > 0, 'Debe ser mayor que cero');
export const qty = z.number().int().positive().max(1_000_000_000); // milésimas
export const date = z.iso.date();
export const revision = z.number().int().positive();
export const discount = z
  .strictObject({ type: z.enum(['percent', 'fixed']), value: money, reason: notes })
  .refine((d) => d.type !== 'percent' || d.value <= 10000, 'Porcentaje máximo: 10000 puntos base')
  .default({ type: 'fixed', value: 0, reason: '' });
export const field = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: text,
  type: z.enum(['text', 'longtext', 'phone', 'email', 'url', 'number', 'date', 'boolean']),
  required: z.boolean().default(false),
});
export const fields = z
  .array(field)
  .max(40)
  .default([])
  .refine((a) => new Set(a.map((f) => f.key)).size === a.length, 'Claves repetidas');
export const values = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    z.union([z.string().max(4000), z.number().finite(), z.boolean()]),
  )
  .default({});
export function validate(schema, data) {
  return schema.parse(data);
}
export function validateFields(definitions, data) {
  const shape = {};
  for (const f of definitions) {
    let s =
      f.type === 'number'
        ? z.number().finite()
        : f.type === 'boolean'
          ? z.boolean()
          : z.string().max(f.type === 'longtext' ? 4000 : 500);
    if (f.type === 'email') s = z.email();
    if (f.type === 'date') s = date;
    if (f.type === 'url')
      s = z.url().refine((v) => {
        const u = new URL(v);
        return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
      }, 'URL HTTP(S) sin credenciales');
    if (f.required && f.type !== 'number' && f.type !== 'boolean') s = s.min(1);
    shape[f.key] = f.required ? s : s.optional();
  }
  return z.strictObject(shape).parse(data);
}
// Zod conserva defaults al derivar .partial(): un PATCH debe conservar solo claves enviadas.
export function parsePatch(schema, input) {
  const parsed = schema.parse(input);
  return Object.fromEntries(Object.keys(input).map((key) => [key, parsed[key]]));
}
