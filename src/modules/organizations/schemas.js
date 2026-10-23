import { z, id, revision } from '../../core/validation.js';
import { moduleIds } from '../businesses/settings.js';
const identity = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  color: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default('#164e3d'),
};
export const organizationSchema = z.strictObject(identity);
export const organizationPatch = organizationSchema.extend({ revision });
export const roleSchema = z
  .strictObject({
    ...identity,
    permissions: z.strictObject(
      Object.fromEntries(
        moduleIds.map((id) => [id, z.enum(['none', 'read', 'write']).default('none')]),
      ),
    ),
  })
  .refine(
    (d) =>
      d.permissions.sales !== 'write' ||
      (d.permissions.finance === 'write' && d.permissions.inventory === 'write'),
    'Editar Ventas requiere edición de Finanzas e Inventario',
  );
export const rolePatch = z
  .strictObject({
    ...identity,
    permissions: z.strictObject(
      Object.fromEntries(
        moduleIds.map((id) => [id, z.enum(['none', 'read', 'write']).default('none')]),
      ),
    ),
    revision,
    archived: z.boolean().default(false),
  })
  .refine(
    (d) =>
      d.permissions.sales !== 'write' ||
      (d.permissions.finance === 'write' && d.permissions.inventory === 'write'),
    'Editar Ventas requiere edición de Finanzas e Inventario',
  );
export const memberSchema = z.strictObject({ email: z.email().transform((s) => s.toLowerCase()) });
export const memberPatch = z.strictObject({ revision, state: z.enum(['active', 'removed']) });
export const grantSchema = z.strictObject({
  revision: z.number().int().min(0),
  roleId: id.nullable(),
  projectScope: z
    .strictObject({
      mode: z.enum(['all', 'selected']),
      ids: z
        .array(id)
        .max(200)
        .refine((a) => new Set(a).size === a.length)
        .default([]),
    })
    .default({ mode: 'all', ids: [] }),
});
export const attachSchema = z.strictObject({ revision });
