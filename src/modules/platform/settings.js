import { z } from '../../core/validation.js';
import { moduleIds } from '../businesses/settings.js';
export const policySchema = z.strictObject({
  registration: z.strictObject({ portal: z.boolean(), google: z.boolean() }),
  login: z
    .strictObject({ password: z.boolean(), google: z.boolean() })
    .refine((v) => v.password || v.google, 'Conserva al menos una forma de iniciar sesión'),
  enabledModules: z
    .array(z.enum(moduleIds))
    .max(moduleIds.length)
    .refine((a) => new Set(a).size === a.length, 'Módulos repetidos')
    .refine(
      (a) => !a.includes('sales') || ['finance', 'inventory'].every((m) => a.includes(m)),
      'Ventas requiere Finanzas e Inventario',
    ),
  features: z.strictObject({
    workspaceCreation: z.boolean(),
    organizationCreation: z.boolean(),
    docsUploads: z.boolean(),
  }),
});
export const updatePolicySchema = policySchema
  .extend({ revision: z.number().int().min(0) })
  .refine(
    (p) =>
      (!p.registration.portal || p.login.password) && (!p.registration.google || p.login.google),
    'Cada método de registro necesita su método de inicio de sesión activo',
  );
export function defaultPolicy(config) {
  return {
    registration: { portal: true, google: !!config.googleClientId },
    login: { password: true, google: !!config.googleClientId },
    enabledModules: [...moduleIds],
    features: { workspaceCreation: true, organizationCreation: true, docsUploads: true },
  };
}
