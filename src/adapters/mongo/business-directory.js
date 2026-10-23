import { memberFields } from '../modules/workspace-access.js';
export function createBusinessDirectory(db, workspaceAccess) {
  return {
    async listForUser(userId) {
      const members = await db
        .collection('memberships')
        .find({ userId, role: { $ne: 'removed' } })
        .toArray();
      const businesses = await db
        .collection('businesses')
        .find({ _id: { $in: members.map((m) => m.businessId) } })
        .toArray();
      const result = [];
      for (const b of businesses) {
        try {
          const member = await workspaceAccess.resolve(members.find((m) => m.businessId === b._id));
          result.push({ ...b, ...memberFields(member) });
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      return result;
    },
    findUserByEmail: (tx, email) =>
      db.collection('users').findOne({ email }, { session: tx.session, projection: { _id: 1 } }),
  };
}
