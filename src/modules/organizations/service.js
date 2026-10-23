import { randomUUID, createHash } from 'node:crypto';
import { id } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import {
  organizationSchema,
  organizationPatch,
  roleSchema,
  rolePatch,
  memberSchema,
  memberPatch,
  grantSchema,
  attachSchema,
} from './schemas.js';
export function createOrganizationService({ uow, store, audit, idempotency, logger, platform }) {
  const one = (tx, n, f) => store.one(tx, n, f),
    find = (tx, n, f, options) => store.find(tx, n, f, options);
  async function owner(tx, ctx, orgId) {
    const o = await one(tx, 'organizations', { _id: orgId });
    ensure(o?.ownerId === ctx.userId, 404, 'NOT_FOUND', 'Organización no encontrada');
    return o;
  }
  async function command(ctx, orgId, action, data, operation, { creating = false } = {}) {
    id.parse(orgId);
    ensure(
      /^[A-Za-z0-9_.:-]{8,120}$/.test(ctx.key || ''),
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Incluye una Idempotency-Key única',
    );
    const hash = createHash('sha256')
      .update(JSON.stringify({ action, data, userId: ctx.userId }))
      .digest('hex');
    const run = (tx) =>
      (async () => {
        if (!creating) await owner(tx, ctx, orgId);
        const prior = await idempotency.get(tx, ctx.key);
        if (prior) {
          ensure(prior.hash === hash, 409, 'IDEMPOTENCY_CONFLICT', 'La clave ya se usó');
          return prior.response;
        }
        const response = await operation(tx);
        await audit.append(tx, ctx, action);
        await idempotency.save(tx, { key: ctx.key, hash, response, createdAt: new Date() });
        return response;
      })();
    let result;
    try {
      result = await uow.run(orgId, run);
    } catch (e) {
      if (e.code !== 11000) throw e;
      result = await uow.run(orgId, run);
    }
    logger.info(
      { action, organizationId: orgId, actorId: ctx.userId, requestId: ctx.requestId },
      'organization.command.completed',
    );
    return result;
  }
  return {
    async list(ctx) {
      const members = await find(null, 'organizationMembers', {
        userId: ctx.userId,
        state: 'active',
      });
      return find(null, 'organizations', { _id: { $in: members.map((m) => m.businessId) } });
    },
    create(ctx, input) {
      const data = organizationSchema.parse(input);
      const hex = createHash('sha256')
        .update(ctx.userId + ':org:' + ctx.key)
        .digest('hex');
      const orgId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      return command(
        ctx,
        orgId,
        'organization.created',
        data,
        async (tx) => {
          await platform?.assertFeature('organizationCreation', tx);
          const org = await store.insert(
            tx,
            'organizations',
            orgId,
            { ...data, ownerId: ctx.userId },
            orgId,
          );
          await store.insert(tx, 'organizationMembers', orgId, {
            userId: ctx.userId,
            state: 'active',
          });
          return org;
        },
        { creating: true },
      );
    },
    async get(ctx, orgId) {
      id.parse(orgId);
      return uow.run(orgId, async (tx) => {
        const org = await one(tx, 'organizations', { _id: orgId });
        const member = await one(tx, 'organizationMembers', {
          businessId: orgId,
          userId: ctx.userId,
          state: 'active',
        });
        ensure(org && member, 404, 'NOT_FOUND', 'Organización no encontrada');
        if (org.ownerId !== ctx.userId) {
          const own = await find(tx, 'memberships', {
            organizationId: orgId,
            userId: ctx.userId,
            role: 'custom',
          });
          return {
            ...org,
            canManage: false,
            spaces: await find(tx, 'businesses', {
              _id: { $in: own.map((g) => g.businessId) },
              organizationId: orgId,
            }),
            members: [],
            roles: [],
            grants: [],
            projects: [],
          };
        }
        const spaces = await find(tx, 'businesses', { organizationId: orgId });
        const members = await find(tx, 'organizationMembers', {
          businessId: orgId,
          state: 'active',
        });
        const grants = await find(tx, 'memberships', {
          businessId: { $in: spaces.map((s) => s._id) },
        });
        const users = await find(
          tx,
          'users',
          {
            _id: { $in: [...members.map((m) => m.userId), ...grants.map((g) => g.userId)] },
          },
          { projection: { _id: 1, name: 1, email: 1 } },
        );
        return {
          ...org,
          canManage: true,
          spaces,
          members: members.map((m) => {
            const u = users.find((u) => u._id === m.userId);
            return { ...m, name: u?.name || 'Usuario', email: u?.email || '' };
          }),
          roles: await find(tx, 'organizationRoles', {
            businessId: orgId,
            archived: { $ne: true },
          }),
          grants: grants.map(({ uiPreferences, preferencesRevision, ...g }) => {
            const u = users.find((u) => u._id === g.userId);
            return { ...g, name: u?.name || 'Usuario', email: u?.email || '' };
          }),
          projects: await find(
            tx,
            'projects',
            { businessId: { $in: spaces.map((s) => s._id) } },
            { projection: { _id: 1, businessId: 1, name: 1 } },
          ),
        };
      });
    },
    update(ctx, orgId, input) {
      const d = organizationPatch.parse(input);
      return command(ctx, orgId, 'organization.updated', d, async (tx) =>
        store.update(tx, 'organizations', await owner(tx, ctx, orgId), d.revision, {
          name: d.name,
          description: d.description,
          color: d.color,
        }),
      );
    },
    role(ctx, orgId, roleId, input) {
      if (roleId) id.parse(roleId);
      const d = (roleId ? rolePatch : roleSchema).parse(input);
      return command(
        ctx,
        orgId,
        roleId ? 'organization.role.updated' : 'organization.role.created',
        { roleId, ...d },
        async (tx) => {
          if (!roleId)
            return store.insert(tx, 'organizationRoles', orgId, { ...d, archived: false });
          const role = await one(tx, 'organizationRoles', { _id: roleId, businessId: orgId });
          ensure(role, 404, 'NOT_FOUND', 'Rol no encontrado');
          if (d.archived)
            ensure(
              !(await one(tx, 'memberships', {
                organizationId: orgId,
                customRoleId: roleId,
                role: 'custom',
              })),
              409,
              'ROLE_IN_USE',
              'Reasigna o retira los accesos antes de eliminar el rol',
            );
          const { revision, ...patch } = d;
          return store.update(tx, 'organizationRoles', role, revision, patch);
        },
      );
    },
    addMember(ctx, orgId, input) {
      const d = memberSchema.parse(input);
      return command(ctx, orgId, 'organization.member.added', d, async (tx) => {
        const user = await one(tx, 'users', { email: d.email });
        ensure(user, 404, 'USER_NOT_FOUND', 'La persona debe tener una cuenta registrada en Nexo');
        const existing = await one(tx, 'organizationMembers', {
          businessId: orgId,
          userId: user._id,
        });
        if (existing?.state === 'active') return existing;
        return existing
          ? store.update(tx, 'organizationMembers', existing, existing.revision, {
              state: 'active',
            })
          : store.insert(tx, 'organizationMembers', orgId, { userId: user._id, state: 'active' });
      });
    },
    member(ctx, orgId, memberId, input) {
      id.parse(memberId);
      const d = memberPatch.parse(input);
      return command(ctx, orgId, 'organization.member.updated', { memberId, ...d }, async (tx) => {
        const m = await one(tx, 'organizationMembers', { _id: memberId, businessId: orgId });
        ensure(m, 404, 'NOT_FOUND', 'Miembro no encontrado');
        const org = await owner(tx, ctx, orgId);
        ensure(
          m.userId !== org.ownerId,
          422,
          'OWNER_PROTECTED',
          'El propietario conserva el control',
        );
        const result = await store.update(tx, 'organizationMembers', m, d.revision, {
          state: d.state,
        });
        if (d.state === 'removed')
          for (const grant of await find(tx, 'memberships', {
            businessId: {
              $in: (await find(tx, 'businesses', { organizationId: orgId })).map((s) => s._id),
            },
            userId: m.userId,
            role: { $in: ['custom', 'editor', 'viewer'] },
          }))
            await store.update(tx, 'memberships', grant, grant.revision, { role: 'removed' });
        return result;
      });
    },
    attach(ctx, orgId, businessId, input) {
      id.parse(businessId);
      const d = attachSchema.parse(input);
      return command(
        ctx,
        orgId,
        'organization.space.attached',
        { businessId, ...d },
        async (tx) => {
          const space = await one(tx, 'businesses', { _id: businessId, businessId });
          const m = await one(tx, 'memberships', { businessId, userId: ctx.userId, role: 'owner' });
          ensure(space && m, 404, 'NOT_FOUND', 'Solo puedes agregar tus propios espacios');
          ensure(
            !space.organizationId || space.organizationId === orgId,
            409,
            'SPACE_ALREADY_ATTACHED',
            'El espacio ya pertenece a otra organización',
          );
          return store.update(tx, 'businesses', space, d.revision, { organizationId: orgId });
        },
      );
    },
    grant(ctx, orgId, businessId, memberId, input) {
      id.parse(businessId);
      id.parse(memberId);
      const d = grantSchema.parse(input);
      return command(
        ctx,
        orgId,
        'organization.access.updated',
        { businessId, memberId, ...d },
        async (tx) => {
          const space = await one(tx, 'businesses', {
            _id: businessId,
            businessId,
            organizationId: orgId,
          });
          ensure(space, 404, 'NOT_FOUND', 'Espacio no encontrado');
          const m = await one(tx, 'organizationMembers', {
            _id: memberId,
            businessId: orgId,
            state: 'active',
          });
          ensure(m, 404, 'NOT_FOUND', 'Miembro no encontrado');
          // Fence membership removal and role archival against concurrent grants.
          await store.fence(tx, 'organizationMembers', {
            _id: m._id,
            businessId: orgId,
            state: 'active',
          });
          const existing = await one(tx, 'memberships', { businessId, userId: m.userId });
          ensure(
            existing?.role !== 'owner',
            422,
            'OWNER_PROTECTED',
            'El propietario conserva el control',
          );
          if (d.roleId) {
            const role = await one(tx, 'organizationRoles', {
              _id: d.roleId,
              businessId: orgId,
              archived: { $ne: true },
            });
            ensure(role, 404, 'NOT_FOUND', 'Rol no encontrado');
            await store.fence(tx, 'organizationRoles', {
              _id: role._id,
              businessId: orgId,
              archived: { $ne: true },
            });
          }
          if (d.projectScope.mode === 'selected' && d.projectScope.ids.length) {
            const projects = await find(tx, 'projects', {
              businessId,
              _id: { $in: d.projectScope.ids },
            });
            ensure(
              projects.length === d.projectScope.ids.length,
              422,
              'INVALID_PROJECT_SCOPE',
              'Hay proyectos que no pertenecen a este espacio',
            );
          }
          const patch = {
            role: d.roleId ? 'custom' : 'removed',
            organizationId: orgId,
            customRoleId: d.roleId,
            projectScope: d.projectScope.mode === 'all' ? { mode: 'all', ids: [] } : d.projectScope,
          };
          if (existing) return store.update(tx, 'memberships', existing, d.revision, patch);
          ensure(d.revision === 0, 409, 'REVISION_CONFLICT', 'Recarga los accesos');
          return store.insert(tx, 'memberships', businessId, { ...patch, userId: m.userId });
        },
      );
    },
  };
}
