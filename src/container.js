import { createContactUsers } from './adapters/mongo/contact-users.js';
import { createDebtCorrections } from './modules/debts/corrections.js';
import { createMovementCorrections } from './modules/finance/corrections.js';
import { createServiceCatalog } from './modules/services/service.js';
import { createSaleLinesAdapter } from './adapters/modules/sale-lines.js';
import { createPlatformService } from './modules/platform/service.js';
import { createPlatformStore } from './adapters/mongo/platform-store.js';
import { createOrganizationService } from './modules/organizations/service.js';
import { createOrganizationStore } from './adapters/mongo/organization-store.js';
import { createWorkspaceAccess } from './adapters/modules/workspace-access.js';
import { createDocsService } from './modules/docs/service.js';
import { createDocsStore } from './adapters/mongo/docs-store.js';
import { createGoogleIdentity } from './adapters/identity/google.js';
import { createIdentityStore } from './adapters/mongo/identity-store.js';
import { createBusinessDirectory } from './adapters/mongo/business-directory.js';
import { createIdempotencyStore } from './adapters/mongo/idempotency-store.js';
import { createUnitOfWork } from './adapters/mongo/unit-of-work.js';
import { createAuditAdapter } from './adapters/mongo/audit.js';
import { createQueries } from './adapters/mongo/queries.js';
import { createCommands } from './core/commands.js';
import { createModuleAccessAdapter } from './adapters/modules/module-access.js';
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
import { createCreditStatementsService } from './modules/debts/statements.js';
import { createDebtsService } from './modules/debts/service.js';
import { createFinanceAdapter } from './adapters/modules/finance.js';
import { createFinancialManagementAdapter } from './adapters/modules/financial-management.js';
import { createInventoryAdapter } from './adapters/modules/inventory.js';
import { createContactsAdapter } from './adapters/modules/contacts.js';
import { createSalesAdapter } from './adapters/modules/sales.js';
export async function createContainer({ client, db, config, logger, googleIdentity }) {
  const uow = createUnitOfWork(client, db);
  const audit = createAuditAdapter(db);
  const idempotency = createIdempotencyStore(db);
  const platform = createPlatformService({
    store: createPlatformStore(db),
    config,
    uow,
    audit,
    idempotency,
    logger,
  });
  const workspaceAccess = createWorkspaceAccess(db);
  const commands = createCommands({
    workspaceAccess,
    platform,
    uow,
    idempotency,
    audit,
    logger,
    moduleAccess: createModuleAccessAdapter(platform),
  });
  const finance = createFinanceAdapter();
  const financialManagement = createFinancialManagementAdapter();
  const inventory = createInventoryAdapter();
  const saleLines = createSaleLinesAdapter(inventory);
  const contacts = createContactsAdapter();
  const sales = createSalesService({ commands, inventory: saleLines, finance, contacts });
  return {
    platform,
    auth: await createAuthService({
      platform,
      store: createIdentityStore({ db, client }),
      config,
      logger,
      googleIdentity: googleIdentity ?? createGoogleIdentity({ clientId: config.googleClientId }),
    }),
    organizations: createOrganizationService({
      uow,
      platform,
      store: createOrganizationStore(db),
      audit,
      idempotency,
      logger,
    }),
    businesses: createBusinessService({
      platform,
      uow,
      directory: createBusinessDirectory(db, workspaceAccess, platform),
      audit,
      commands,
      idempotency,
    }),
    debtCorrections: createDebtCorrections({ commands }),
    movementCorrections: createMovementCorrections({ commands }),
    finance: createFinanceService({ commands, finance, financialManagement }),
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
    contacts: createContactsService({
      commands,
      contactUsers: createContactUsers(db, workspaceAccess),
    }),
    sales,
    serviceCatalog: createServiceCatalog({ commands, inventory }),
    quotes: createQuotesService({
      commands,
      inventory: saleLines,
      contacts,
      sales: createSalesAdapter(sales),
    }),
    planning: createPlanningService({ commands }),
    docs: createDocsService({ commands, store: createDocsStore(db) }),
    projections: createProjectionsService({ commands }),
    debts: createDebtsService({ commands, finance, contacts, financialManagement }),
    creditStatements: createCreditStatementsService({ commands }),
    queries: createQueries({ db, commands }),
  };
}
