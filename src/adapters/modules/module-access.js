import { assertModuleEnabled } from '../../modules/businesses/settings.js';

// Centraliza el contrato de módulos sin conectar directamente los servicios.
const actions = {
  wallet: 'finance',
  finance: 'finance',
  creditLine: 'finance',
  debt: 'finance',
  inventory: 'inventory',
  inventoryLists: 'inventory',
  sale: 'sales',
  quote: 'quotes',
  projection: 'projections',
  contact: 'contacts',
  contactLists: 'contacts',
  events: 'calendar',
  projects: 'projects',
};
export function createModuleAccessAdapter() {
  return {
    async assertEnabled(tx, module) {
      assertModuleEnabled(await tx.get('businesses', tx.businessId), module);
    },
    async assertAction(tx, action) {
      const module = actions[action.split('.')[0]];
      if (!module) return;
      await this.assertEnabled(tx, module);
      // Convertir una cotización también crea una venta y movimientos de stock/dinero.
      if (action === 'quote.converted') await this.assertEnabled(tx, 'sales');
    },
  };
}
