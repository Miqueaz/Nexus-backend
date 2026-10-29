import { ensure } from '../../core/errors.js';
import { moduleIds } from '../../modules/businesses/settings.js';
export const resourceModules = {
  documents: 'docs',
  docs: 'docs',
  wallets: 'finance',
  commitments: 'finance',
  commitmentResolutions: 'finance',
  'commitment-resolutions': 'finance',
  movements: 'finance',
  transfers: 'finance',
  creditLines: 'finance',
  creditStatements: 'finance',
  debts: 'finance',
  debtPayments: 'finance',
  summary: 'finance',
  inventoryLists: 'inventory',
  items: 'inventory',
  stockMovements: 'inventory',
  contacts: 'contacts',
  contactLists: 'contacts',
  sales: 'sales',
  services: 'sales',
  quotes: 'quotes',
  projections: 'projections',
  events: 'calendar',
  calendar: 'calendar',
  projects: 'projects',
  history: 'history',
  audit: 'history',
  'credit-lines': 'finance',
  'credit-statements': 'finance',
  'debt-payments': 'finance',
  'inventory-lists': 'inventory',
  'stock-movements': 'inventory',
  'contact-lists': 'contacts',
};
export const allows = (member, module, write = false) =>
  (!module || !member?.platformEnabledModules || member.platformEnabledModules.includes(module)) &&
  (!member?.access ||
    !module ||
    (write
      ? member.access.permissions[module] === 'write'
      : ['read', 'write'].includes(member.access.permissions[module])));
export function assertAccess(member, module, write = false) {
  ensure(
    allows(member, module, write),
    403,
    'MODULE_FORBIDDEN',
    'Tu rol no permite esta acción en este módulo',
  );
}
export function projectFilter(member, collection) {
  return collection === 'projects' && member?.access?.projectScope?.mode === 'selected'
    ? { _id: { $in: member.access.projectScope.ids } }
    : {};
}
export function memberFields(member) {
  return {
    role: member.role,
    ...(member.platformEnabledModules
      ? { platformEnabledModules: member.platformEnabledModules }
      : {}),
    ...(member.access ? { access: member.access } : {}),
    ...(member.organizationName ? { organizationName: member.organizationName } : {}),
  };
}
export function createWorkspaceAccess(db) {
  async function resolve(member, session) {
    if (member.role !== 'custom') return member;
    const opts = { session };
    const org = await db.collection('organizations').findOne({ _id: member.organizationId }, opts);
    const account = await db
      .collection('organizationMembers')
      .findOne({ businessId: member.organizationId, userId: member.userId, state: 'active' }, opts);
    const role = await db
      .collection('organizationRoles')
      .findOne(
        { _id: member.customRoleId, businessId: member.organizationId, archived: { $ne: true } },
        opts,
      );
    const space = await db
      .collection('businesses')
      .findOne({ _id: member.businessId, organizationId: member.organizationId }, opts);
    ensure(org && account && role && space, 404, 'NOT_FOUND', 'Espacio no encontrado');
    const permissions = Object.fromEntries(
      moduleIds.map((id) => [id, role.permissions[id] ?? 'none']),
    );
    return {
      ...member,
      role: Object.values(permissions).includes('write') ? 'editor' : 'viewer',
      organizationName: org.name,
      access: {
        source: 'organization',
        roleId: role._id,
        roleName: role.name,
        permissions,
        projectScope: member.projectScope ?? { mode: 'all', ids: [] },
      },
    };
  }
  function bind(tx, member) {
    tx.accessMember = member;
    if (
      !member.access &&
      (!member.platformEnabledModules || member.platformEnabledModules.length === moduleIds.length)
    )
      return;
    const raw = {
      get: tx.get.bind(tx),
      find: tx.find.bind(tx),
      insert: tx.insert.bind(tx),
      update: tx.update.bind(tx),
    };
    const checkProject = (name, id) => {
      if (name === 'projects' && member.access?.projectScope.mode === 'selected')
        ensure(
          member.access.projectScope.ids.includes(id),
          404,
          'NOT_FOUND',
          'Proyecto no encontrado',
        );
    };
    tx.get = async (name, id) => {
      assertAccess(member, resourceModules[name]);
      checkProject(name, id);
      return raw.get(name, id);
    };
    tx.find = async (name, filter = {}) =>
      allows(member, resourceModules[name])
        ? raw.find(name, { $and: [filter, projectFilter(member, name)] })
        : [];
    tx.insert = async (name, data, id) => {
      assertAccess(member, resourceModules[name], true);
      if (name === 'projects' && member.access)
        ensure(
          member.access?.projectScope.mode === 'all',
          403,
          'PROJECT_SCOPE',
          'Este rol solo puede usar los proyectos asignados',
        );
      return raw.insert(name, data, id);
    };
    tx.update = async (name, id, revision, patch) => {
      assertAccess(member, resourceModules[name], true);
      checkProject(name, id);
      return raw.update(name, id, revision, patch);
    };
  }
  return {
    resolve,
    bind,
    assertRoute(member, ctx) {
      if (!member.access) return;
      const r = ctx.accessRequirement;
      if (r?.resource === 'audit' || r?.resource === 'members')
        ensure(false, 403, 'FORBIDDEN', 'Solo el propietario administra accesos y auditoría');
      if (r?.resource === 'history' || r?.history) assertAccess(member, 'history');
      assertAccess(member, resourceModules[r?.resource], r?.write);
    },
  };
}
