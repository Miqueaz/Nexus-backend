import { ensure } from '../../core/errors.js';
/** Metadata reads keep board strokes and document blocks out of the library listing. */
export function createDocsStore(db) {
  return {
    async updateContent(tx, current, expectedRevision, patch) {
      const after = { ...current, ...patch, revision: expectedRevision + 1, updatedAt: new Date() };
      const result = await db
        .collection('documents')
        .updateOne(
          { _id: current._id, businessId: tx.businessId, revision: expectedRevision },
          { $set: { ...patch, revision: after.revision, updatedAt: after.updatedAt } },
          { session: tx.session },
        );
      ensure(result.modifiedCount === 1, 409, 'REVISION_CONFLICT', 'Conflicto de actualización');
      tx.changes.push({ collection: 'documents', entityId: current._id, before: current, after });
      return after;
    },
    async containers(tx) {
      return db
        .collection('documents')
        .find(
          { businessId: tx.businessId, kind: { $in: ['folder', 'section'] } },
          { session: tx.session, projection: { blocks: 0, elements: 0, board: 0, attachment: 0 } },
        )
        .sort({ title: 1 })
        .toArray();
    },
    async list(tx, { limit, cursor, kind, archived, q, parentId }) {
      const filter = { businessId: tx.businessId, archived: archived === 'true' };
      filter.kind = kind || { $in: ['document', 'board', 'file'] };
      if (parentId) filter.parentId = parentId === 'root' ? null : parentId;
      if (q) filter.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      if (cursor) {
        const previous = await tx.get('documents', cursor);
        filter.$or = [
          { updatedAt: { $lt: previous.updatedAt } },
          { updatedAt: previous.updatedAt, _id: { $lt: previous._id } },
        ];
      }
      const rows = await db
        .collection('documents')
        .find(filter, {
          session: tx.session,
          projection: { blocks: 0, elements: 0, board: 0, 'attachment.data': 0 },
        })
        .sort({ updatedAt: -1, _id: -1 })
        .limit(limit + 1)
        .toArray();
      return {
        data: rows.slice(0, limit),
        nextCursor: rows.length > limit ? rows[limit - 1]._id : null,
      };
    },
  };
}
