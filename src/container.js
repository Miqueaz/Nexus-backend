import { createIdentityStore } from './adapters/mongo/identity-store.js';
import { createBusinessDirectory } from './adapters/mongo/business-directory.js';
import { createIdempotencyStore } from './adapters/mongo/idempotency-store.js';
import { createUnitOfWork } from './adapters/mongo/unit-of-work.js';
import { createAuditAdapter } from './adapters/mongo/audit.js';
import { createQueries } from './adapters/mongo/queries.js';
import { createCommands } from './core/commands.js';
import { createAuthService } from './modules/auth/service.js';
import { createBusinessService } from './modules/businesses/service.js';
import { createFinanceService } from './modules/finance/service.js';
import { createInventoryService } from './modules/inventory/service.js';
import { createListService } from './modules/inventory/flexible-lists.js';
import { createContactsService } from './modules/contacts/service.js';
import { createSalesService } from './modules/sales/service.js';
import { createQuotesService } from './modules/planning/quotes.js';
import { createPlanningService } from './modules/planning/resources.js';
import { createProjectionsService } from './modules/planning/projections.js';
import { createDebtsService } from './modules/debts/service.js';
import { createFinanceAdapter } from './adapters/modules/finance.js';
import { createInventoryAdapter } from './adapters/modules/inventory.js';
import { createContactsAdapter } from './adapters/modules/contacts.js';
import { createSalesAdapter } from './adapters/modules/sales.js';
export async function createContainer({ client, db, config, logger }) {
  const uow = createUnitOfWork(client, db);
  const audit = createAuditAdapter(db);
  const commands = createCommands({ uow, idempotency: createIdempotencyStore(db), audit, logger });
  const finance = createFinanceAdapter();
  const inventory = createInventoryAdapter();
  const contacts = createContactsAdapter();
  const sales = createSalesService({ commands, inventory, finance, contacts });
  return {
    auth: await createAuthService({ store: createIdentityStore({ db, client }), config, logger }),
    businesses: createBusinessService({
      uow,
      directory: createBusinessDirectory(db),
      audit,
      commands,
    }),
    finance: createFinanceService({ commands, finance }),
    inventory: createInventoryService({ commands }),
    inventoryLists: createListService({
      commands,
      collection: 'inventoryLists',
      entryCollection: 'items',
    }),
    contactLists: createListService({
      commands,
      collection: 'contactLists',
      entryCollection: 'contacts',
    }),
    contacts: createContactsService({ commands }),
    sales,
    quotes: createQuotesService({
      commands,
      inventory,
      contacts,
      sales: createSalesAdapter(sales),
    }),
    planning: createPlanningService({ commands }),
    projections: createProjectionsService({ commands }),
    debts: createDebtsService({ commands, finance, contacts }),
    queries: createQueries({ db, commands }),
  };
}
