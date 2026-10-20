export function createBusinessDirectory(db) {
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
      return businesses.map((b) => ({
        ...b,
        role: members.find((m) => m.businessId === b._id).role,
      }));
    },
    findUserByEmail: (tx, email) =>
      db.collection('users').findOne({ email }, { session: tx.session, projection: { _id: 1 } }),
  };
}
