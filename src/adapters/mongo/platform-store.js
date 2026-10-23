import { ensure } from '../../core/errors.js';
export function createPlatformStore(db) {
  return {
    read: (session) => db.collection('platformSettings').findOne({ _id: 'platform' }, { session }),
    user: (id, session) => db.collection('users').findOne({ _id: id }, { session }),
    async write(tx, data, expectedRevision) {
      const before = await this.read(tx.session);
      ensure(
        (before?.revision ?? 0) === expectedRevision,
        409,
        'REVISION_CONFLICT',
        'La configuración cambió; recarga antes de guardar',
      );
      const after = {
        ...data,
        _id: 'platform',
        businessId: 'platform',
        revision: expectedRevision + 1,
        createdAt: before?.createdAt ?? new Date(),
        updatedAt: new Date(),
      };
      if (before) {
        const result = await db
          .collection('platformSettings')
          .replaceOne({ _id: 'platform', revision: expectedRevision }, after, {
            session: tx.session,
          });
        ensure(result.modifiedCount === 1, 409, 'REVISION_CONFLICT', 'La configuración cambió');
      } else await db.collection('platformSettings').insertOne(after, { session: tx.session });
      tx.changes.push({ collection: 'platformSettings', entityId: 'platform', before, after });
      return after;
    },
    audit: () =>
      db
        .collection('audit')
        .find(
          { businessId: 'platform', collection: 'platformSettings' },
          { projection: { _id: 1, action: 1, actorId: 1, recordedAt: 1, 'after.revision': 1 } },
        )
        .sort({ recordedAt: -1, _id: -1 })
        .limit(20)
        .toArray(),
  };
}
