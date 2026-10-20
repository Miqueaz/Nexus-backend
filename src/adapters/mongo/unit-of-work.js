import { randomUUID } from 'node:crypto';
import { ensure, missing } from '../../core/errors.js';
export function createUnitOfWork(client, db) {
  return {
    async run(businessId, operation) {
      const session = client.startSession();
      try {
        return await session.withTransaction(
          async () => {
            const changes = [];
            const tx = {
              session,
              businessId,
              changes,
              async get(name, id) {
                const d = await db.collection(name).findOne({ _id: id, businessId }, { session });
                if (!d) throw missing();
                return d;
              },
              async find(name, filter = {}) {
                return db
                  .collection(name)
                  .find({ ...filter, businessId }, { session })
                  .toArray();
              },
              async insert(name, data, assignedId) {
                const now = new Date();
                const doc = {
                  ...data,
                  _id: assignedId ?? randomUUID(),
                  businessId,
                  revision: 1,
                  createdAt: now,
                  updatedAt: now,
                };
                await db.collection(name).insertOne(doc, { session });
                changes.push({ collection: name, entityId: doc._id, before: null, after: doc });
                return doc;
              },
              async update(name, id, expectedRevision, patch) {
                const before = await tx.get(name, id);
                ensure(
                  before.revision === expectedRevision,
                  409,
                  'REVISION_CONFLICT',
                  'El registro cambió; recarga su versión',
                );
                const {
                  _id,
                  businessId: ignoredBusiness,
                  revision: ignoredRevision,
                  createdAt,
                  ...allowed
                } = patch;
                const after = {
                  ...before,
                  ...allowed,
                  revision: before.revision + 1,
                  updatedAt: new Date(),
                };
                const result = await db
                  .collection(name)
                  .replaceOne({ _id: id, businessId, revision: expectedRevision }, after, {
                    session,
                  });
                ensure(
                  result.modifiedCount === 1,
                  409,
                  'REVISION_CONFLICT',
                  'Conflicto de actualización',
                );
                changes.push({ collection: name, entityId: id, before, after });
                return after;
              },
            };
            return operation(tx);
          },
          {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
            readPreference: 'primary',
          },
        );
      } finally {
        await session.endSession();
      }
    },
  };
}
