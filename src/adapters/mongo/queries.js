import { z, id } from '../../core/validation.js';
import { ensure, missing } from '../../core/errors.js';
const readable = new Set([
  'wallets',
  'movements',
  'inventoryLists',
  'items',
  'stockMovements',
  'contactLists',
  'contacts',
  'sales',
  'quotes',
  'projects',
  'events',
  'projections',
  'creditLines',
  'debts',
  'debtPayments',
]);
const pageSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: id.optional(),
  listId: id.optional(),
  archived: z.enum(['true', 'false']).optional(),
});
export function createQueries({ db, commands }) {
  async function authorized(ctx, fn, options) {
    return commands.read(ctx, fn, options);
  }
  return {
    authorize: authorized,
    list(ctx, collection, query) {
      ensure(readable.has(collection), 404, 'NOT_FOUND', 'Recurso no encontrado');
      const p = pageSchema.parse(query);
      return authorized(ctx, async (tx) => {
        const filter = { businessId: ctx.businessId };
        if (p.archived !== undefined) filter.archived = p.archived === 'true';
        if (p.listId) filter.listIds = p.listId;
        if (p.cursor) {
          const c = await tx.get(collection, p.cursor);
          filter.$or = [
            { createdAt: { $lt: c.createdAt } },
            { createdAt: c.createdAt, _id: { $lt: c._id } },
          ];
        }
        const rows = await db
          .collection(collection)
          .find(filter, { session: tx.session })
          .sort({ createdAt: -1, _id: -1 })
          .limit(p.limit + 1)
          .toArray();
        return {
          data: rows.slice(0, p.limit),
          nextCursor: rows.length > p.limit ? rows[p.limit - 1]._id : null,
        };
      });
    },
    get(ctx, collection, entityId) {
      ensure(readable.has(collection), 404, 'NOT_FOUND', 'Recurso no encontrado');
      id.parse(entityId);
      return authorized(ctx, (tx) => tx.get(collection, entityId));
    },
    history(ctx, query) {
      const d = z
        .strictObject({
          at: z.iso.datetime({ offset: true }),
          collection: z.enum([...readable]),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          cursor: id.optional(),
        })
        .parse(query);
      const at = new Date(d.at);
      ensure(at <= new Date(), 422, 'FUTURE_HISTORY', 'La fecha debe estar en el pasado');
      return authorized(ctx, async (tx) => {
        const match = {
          businessId: ctx.businessId,
          collection: d.collection,
          recordedAt: { $lte: at },
        };
        const rows = await db
          .collection('audit')
          .aggregate(
            [
              { $match: match },
              { $sort: { entityId: 1, 'after.revision': -1, order: -1 } },
              { $group: { _id: '$entityId', snapshot: { $first: '$after' } } },
              ...(d.cursor ? [{ $match: { _id: { $gt: d.cursor } } }] : []),
              { $sort: { _id: 1 } },
              { $limit: d.limit + 1 },
              { $replaceRoot: { newRoot: '$snapshot' } },
            ],
            { session: tx.session },
          )
          .toArray();
        return {
          at: d.at,
          readOnly: true,
          basis: 'recordedAt',
          data: rows.slice(0, d.limit),
          nextCursor: rows.length > d.limit ? rows[d.limit - 1]._id : null,
        };
      });
    },
    audit(ctx, query) {
      const d = z
        .strictObject({
          entityId: id.optional(),
          before: z.iso.datetime({ offset: true }).optional(),
          cursor: id.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .parse(query);
      return authorized(ctx, async (tx) => {
        const filter = { businessId: ctx.businessId };
        if (d.entityId) filter.entityId = d.entityId;
        if (d.before) filter.recordedAt = { $lt: new Date(d.before) };
        if (d.cursor) {
          const c = await db
            .collection('audit')
            .findOne({ _id: d.cursor, businessId: ctx.businessId }, { session: tx.session });
          if (!c) throw missing();
          filter.$or = [
            { recordedAt: { $lt: c.recordedAt } },
            { recordedAt: c.recordedAt, _id: { $lt: c._id } },
          ];
        }
        const rows = await db
          .collection('audit')
          .find(filter, { session: tx.session })
          .sort({ recordedAt: -1, _id: -1 })
          .limit(d.limit + 1)
          .toArray();
        return {
          data: rows.slice(0, d.limit),
          nextCursor: rows.length > d.limit ? rows[d.limit - 1]._id : null,
        };
      });
    },
    summary(ctx, query) {
      const d = z
        .strictObject({ from: z.iso.date().optional(), to: z.iso.date().optional() })
        .parse(query);
      ensure(!d.from || !d.to || d.from <= d.to, 422, 'DATE_RANGE', 'Rango inválido');
      return authorized(ctx, async (tx) => {
        const filter = { businessId: ctx.businessId };
        if (d.from || d.to)
          filter.occurredOn = {
            ...(d.from ? { $gte: d.from } : {}),
            ...(d.to ? { $lte: d.to } : {}),
          };
        const [totals] = await db
          .collection('movements')
          .aggregate(
            [
              { $match: filter },
              {
                $group: {
                  _id: null,
                  cashInMinor: {
                    $sum: { $cond: [{ $gt: ['$amountMinor', 0] }, '$amountMinor', 0] },
                  },
                  cashOutMinor: {
                    $sum: {
                      $cond: [{ $lt: ['$amountMinor', 0] }, { $multiply: ['$amountMinor', -1] }, 0],
                    },
                  },
                  operatingNetMinor: { $sum: '$operatingMinor' },
                },
              },
            ],
            { session: tx.session },
          )
          .toArray();
        const wallets = await tx.find('wallets');
        return {
          period: d,
          ...(totals ?? { cashInMinor: 0, cashOutMinor: 0, operatingNetMinor: 0 }),
          wallets,
        };
      });
    },
  };
}
