import { assertAccess } from './workspace-access.js';
import { assertModuleEnabled } from '../../modules/businesses/settings.js';

// Centraliza el contrato de módulos sin conectar directamente los servicios.
const actions = {
  docs: 'docs',
  wallet: 'finance',
  commitment: 'finance',
  finance: 'finance',
  creditLine: 'finance',
  debt: 'finance',
  inventory: 'inventory',
  inventoryLists: 'inventory',
  sale: 'sales',
  serviceCatalog: 'sales',
  quote: 'quotes',
  projection: 'projections',
  contact: 'contacts',
  contactLists: 'contacts',
  events: 'calendar',
  projects: 'projects',
};
export function createModuleAccessAdapter(platform) {
  return {
    async assertEnabled(tx, module) {
      if (platform) platform.assertModule(await platform.read(tx), module);
      assertAccess(tx.accessMember, module);
      assertModuleEnabled(await tx.get('businesses', tx.businessId), module);
    },
    async assertAction(tx, action) {
      const module = actions[action.split('.')[0]];
      if (!module) return;
      assertAccess(tx.accessMember, module, true);
      await this.assertEnabled(tx, module);
      // Convertir una cotización también crea una venta y movimientos de stock/dinero.
      if (action === 'quote.converted') {
        assertAccess(tx.accessMember, 'sales', true);
        await this.assertEnabled(tx, 'sales');
      }
    },
  };
}
