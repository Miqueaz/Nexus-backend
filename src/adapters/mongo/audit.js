import { randomUUID } from 'node:crypto';
export function createAuditAdapter(db) {
  return {
    async append(tx, ctx, action) {
      const recordedAt = new Date();
      const commandId = randomUUID();
      if (!tx.changes.length) return;
      await db.collection('audit').insertMany(
        tx.changes.map((change, order) => ({
          _id: randomUUID(),
          businessId: tx.businessId,
          commandId,
          order,
          action,
          actorId: ctx.userId,
          requestId: ctx.requestId,
          recordedAt,
          ...change,
        })),
        { session: tx.session },
      );
    },
  };
}
