import { z, text, notes, revision } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';

export const moduleCatalog = [
  {
    id: 'docs',
    name: 'Docs',
    description: 'Documentos por bloques, notas y pizarrones de ideas.',
    requires: [],
  },
  {
    id: 'finance',
    name: 'Finanzas',
    description: 'Carteras, movimientos, créditos y diferidos.',
    requires: [],
  },
  {
    id: 'inventory',
    name: 'Inventario',
    description: 'Listas, productos y existencias.',
    requires: [],
  },
  {
    id: 'sales',
    name: 'Ventas',
    description: 'Ventas, descuentos y cobros.',
    requires: ['finance', 'inventory'],
  },
  {
    id: 'quotes',
    name: 'Cotizaciones',
    description: 'Presupuestos y propuestas para clientes.',
    requires: [],
  },
  {
    id: 'projections',
    name: 'Proyecciones',
    description: 'Escenarios de inversión y rentabilidad.',
    requires: [],
  },
  {
    id: 'contacts',
    name: 'Contactos',
    description: 'Personas, proveedores y listas dinámicas.',
    requires: [],
  },
  { id: 'calendar', name: 'Calendario', description: 'Eventos y vencimientos.', requires: [] },
  {
    id: 'projects',
    name: 'Proyectos',
    description: 'Proyectos, tareas y objetivos.',
    requires: [],
  },
  {
    id: 'history',
    name: 'Historial',
    description: 'Consulta del negocio por fecha.',
    requires: [],
  },
];
export const moduleIds = moduleCatalog.map((m) => m.id);
const enabledModules = z
  .array(z.enum(moduleIds))
  .max(moduleIds.length)
  .refine((ids) => new Set(ids).size === ids.length, 'Módulos repetidos')
  .refine(
    (ids) =>
      moduleCatalog.every(
        (m) => !ids.includes(m.id) || m.requires.every((dep) => ids.includes(dep)),
      ),
    'Ventas requiere Finanzas e Inventario',
  );
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((s) => s.toLowerCase());
const fields = {
  name: text,
  kind: z.enum(['business', 'workspace']).default('business'),
  description: notes,
  color: color.default('#164e3d'),
  enabledModules: enabledModules.default(moduleIds),
};
export const businessCreateSchema = z.strictObject({
  ...fields,
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z
    .string()
    .max(80)
    .refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, 'Zona IANA inválida')
    .default('America/Mexico_City'),
});
export const businessUpdateSchema = z
  .strictObject({
    name: text,
    kind: z.enum(['business', 'workspace']),
    description: z.string().trim().max(4000),
    color,
    enabledModules,
  })
  .partial()
  .extend({ revision })
  .refine((d) => Object.keys(d).some((key) => key !== 'revision'), 'Incluye algún cambio');
export function businessSettings(business) {
  return {
    ...business,
    capabilities: {
      inventoryMaterials: 1,
      saleServices: 1,
      saleCommissions: 1,
      commissionerProfiles: 1,
      commissionWallets: 1,
      serviceProductPricing: 1,
      chargedDiscount: 1,
      associationConsent: 1,
      namedCustomers: 1,
      movementCorrections: 1,
    },
    kind: business.kind ?? 'business',
    description: business.description ?? '',
    color: business.color ?? '#164e3d',
    enabledModules: business.enabledModules ?? [...moduleIds],
  };
}
export function assertModuleEnabled(business, module) {
  ensure(
    (business.enabledModules ?? moduleIds).includes(module),
    409,
    'MODULE_DISABLED',
    'El propietario desactivó este módulo en el negocio',
  );
}
