import { ensure } from '../../core/errors.js';
// Identity lookup is confined to active members of this workspace, never a global directory.
export function createContactUsers(db, workspaceAccess) {
  async function valid(tx, member) {
    if (!member || member.role === 'removed') return false;
    try {
      await workspaceAccess.resolve(member, tx.session);
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }
  return {
    async assert(tx, userId) {
      ensure(
        await valid(
          tx,
          (await tx.find('memberships', { userId })).find((m) => m.role !== 'removed'),
        ),
        422,
        'CONTACT_USER_NOT_MEMBER',
        'El usuario debe tener acceso activo a este espacio',
      );
      const user = await db
        .collection('users')
        .findOne({ _id: userId }, { session: tx.session, projection: { _id: 1, name: 1 } });
      ensure(user, 422, 'CONTACT_USER_NOT_MEMBER', 'Usuario no disponible');
      return user;
    },
    async list(tx) {
      const members = await tx.find('memberships', { role: { $ne: 'removed' } }),
        ids = [];
      for (const m of members) if (await valid(tx, m)) ids.push(m.userId);
      return db
        .collection('users')
        .find(
          { _id: { $in: ids } },
          { session: tx.session, projection: { _id: 1, name: 1, email: 1 } },
        )
        .sort({ name: 1, _id: 1 })
        .toArray();
    },
  };
}
