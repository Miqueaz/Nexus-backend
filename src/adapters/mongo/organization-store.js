import { randomUUID } from 'node:crypto';
import { ensure } from '../../core/errors.js';
// Cross-workspace writes are explicit, scoped, revision checked and audited in one transaction.
export function createOrganizationStore(db) {
  return {
    fence: (tx, name, filter) =>
      db.collection(name).updateOne(filter, { $inc: { accessEpoch: 1 } }, { session: tx.session }),
    find: (tx, name, filter, options = {}) =>
      db
        .collection(name)
        .find(filter, { ...options, session: tx?.session })
        .toArray(),
    one: (tx, name, filter) => db.collection(name).findOne(filter, { session: tx?.session }),
    async insert(tx, name, businessId, data, id = randomUUID()) {
      const doc = {
        ...data,
        _id: id,
        businessId,
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await db.collection(name).insertOne(doc, { session: tx.session });
      tx.changes.push({ collection: name, entityId: id, before: null, after: doc });
      return doc;
    },
    async update(tx, name, before, revision, patch) {
      ensure(
        before && before.revision === revision,
        409,
        'REVISION_CONFLICT',
        'El registro cambió; recarga su versión',
      );
      const after = { ...before, ...patch, revision: revision + 1, updatedAt: new Date() };
      const result = await db
        .collection(name)
        .replaceOne({ _id: before._id, businessId: before.businessId, revision }, after, {
          session: tx.session,
        });
      ensure(result.modifiedCount === 1, 409, 'REVISION_CONFLICT', 'El registro cambió');
      tx.changes.push({ collection: name, entityId: after._id, before, after });
      return after;
    },
  };
}
