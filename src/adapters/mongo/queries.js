import {
  allows,
  assertAccess,
  resourceModules,
  projectFilter,
  memberFields,
} from '../modules/workspace-access.js';
import { personalPreferences } from '../../modules/businesses/preferences.js';
import { z, id } from '../../core/validation.js';
import { ensure, missing } from '../../core/errors.js';
import { businessSettings } from '../../modules/businesses/settings.js';
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
  'creditStatements',
  'debts',
  'debtPayments',
]);
const snapshotCollections = Object.fromEntries(
  [...readable].map((name) => [
    {
      inventoryLists: 'inventory-lists',
      stockMovements: 'stock-movements',
      contactLists: 'contact-lists',
      creditLines: 'credit-lines',
      creditStatements: 'credit-statements',
      debtPayments: 'debt-payments',
    }[name] || name,
    name,
  ]),
);
const snapshotSchema = z.strictObject({
  collections: z
    .string()
    .default(Object.keys(snapshotCollections).join(','))
    .transform((value) => value.split(','))
    .pipe(
      z
        .array(z.enum(Object.keys(snapshotCollections)))
        .min(1)
        .max(readable.size),
    )
    .refine((names) => new Set(names).size === names.length, 'Recursos repetidos'),
  at: z.iso.datetime({ offset: true }).optional(),
});
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
  async function listPage(tx, ctx, collection, p) {
    assertAccess(tx.accessMember, resourceModules[collection]);
    const filter = { businessId: ctx.businessId, ...projectFilter(tx.accessMember, collection) };
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
  }
  async function historyPage(tx, ctx, d) {
    assertAccess(tx.accessMember, 'history');
    assertAccess(tx.accessMember, resourceModules[d.collection]);
    const at = new Date(d.at);
    const match = {
      businessId: ctx.businessId,
      collection: d.collection,
      recordedAt: { $lte: at },
      ...(d.collection === 'projects' && tx.accessMember?.access?.projectScope.mode === 'selected'
        ? { entityId: { $in: tx.accessMember.access.projectScope.ids } }
        : {}),
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
  }
  return {
    authorize: authorized,
    list(ctx, collection, query) {
      ensure(readable.has(collection), 404, 'NOT_FOUND', 'Recurso no encontrado');
      const p = pageSchema.parse(query);
      return authorized(ctx, async (tx) => {
        return listPage(tx, ctx, collection, p);
      });
    },
    snapshot(ctx, query) {
      const d = snapshotSchema.parse(query);
      if (d.at)
        ensure(
          new Date(d.at) <= new Date(),
          422,
          'FUTURE_HISTORY',
          'La fecha debe estar en el pasado',
        );
      const load = async (tx, member) => {
        if (d.at) assertAccess(member, 'history');
        // One database round trip after membership validation. Results are emitted
        // per record, rather than as a single BSON document with a 16 MiB ceiling.
        const pipeline = [
          { $match: { _id: ctx.businessId, businessId: ctx.businessId } },
          { $project: { _id: 0, business: '$$ROOT' } },
        ];
        for (const name of d.collections) {
          const collection = snapshotCollections[name];
          if (!allows(member, resourceModules[collection])) {
            pipeline.push({ $set: { [name]: [] } });
            continue;
          }
          const stages = d.at
            ? [
                {
                  $match: {
                    businessId: ctx.businessId,
                    collection,
                    ...(collection === 'projects' && member.access?.projectScope.mode === 'selected'
                      ? { entityId: { $in: member.access.projectScope.ids } }
                      : {}),
                    recordedAt: { $lte: new Date(d.at) },
                  },
                },
                { $sort: { entityId: 1, 'after.revision': -1, order: -1 } },
                { $group: { _id: '$entityId', snapshot: { $first: '$after' } } },
                { $sort: { _id: 1 } },
                { $limit: 101 },
                { $replaceRoot: { newRoot: '$snapshot' } },
              ]
            : [
                { $match: { businessId: ctx.businessId, ...projectFilter(member, collection) } },
                { $sort: { createdAt: -1, _id: -1 } },
                { $limit: 101 },
              ];
          pipeline.push({
            $lookup: { from: d.at ? 'audit' : collection, pipeline: stages, as: name },
          });
        }
        pipeline.push(
          {
            $project: {
              entries: [
                { resource: { $literal: 'business' }, rows: ['$business'] },
                ...d.collections.map((name) => ({
                  resource: { $literal: name },
                  rows: '$' + name,
                })),
              ],
            },
          },
          { $unwind: '$entries' },
          { $unwind: { path: '$entries.rows', preserveNullAndEmptyArrays: true } },
          { $replaceRoot: { newRoot: '$entries' } },
        );
        const rows = await db
          .collection('businesses')
          .aggregate(pipeline, { session: tx.session })
          .toArray();
        if (!rows.length) throw missing();
        const collections = Object.fromEntries(
          d.collections.map((name) => [
            name,
            {
              data: [],
              nextCursor: null,
              ...(d.at ? { at: d.at, readOnly: true, basis: 'recordedAt' } : {}),
            },
          ]),
        );
        let business;
        for (const row of rows) {
          if (row.resource === 'business') business = row.rows;
          else if (row.rows) collections[row.resource].data.push(row.rows);
        }
        for (const page of Object.values(collections)) {
          page.nextCursor = page.data.length > 100 ? page.data[99]._id : null;
          page.data = page.data.slice(0, 100);
        }
        return {
          business: businessSettings({
            ...business,
            ...memberFields(member),
            ...personalPreferences(member),
          }),
          collections,
          ...(d.at ? { at: d.at, readOnly: true } : {}),
        };
      };
      return authorized(ctx, load).catch((error) => {
        // MongoDB 7 does not support transactional lookups into sharded collections.
        // Keep the existing sequential read path for that deployment topology.
        if (error.code !== 263) throw error;
        return authorized(ctx, async (tx, member) => {
          const business = await tx.get('businesses', ctx.businessId),
            collections = {};
          if (d.at) assertAccess(member, 'history');
          for (const name of d.collections)
            collections[name] = !allows(member, resourceModules[snapshotCollections[name]])
              ? { data: [], nextCursor: null, restricted: true }
              : d.at
                ? await historyPage(tx, ctx, {
                    collection: snapshotCollections[name],
                    at: d.at,
                    limit: 100,
                  })
                : await listPage(tx, ctx, snapshotCollections[name], { limit: 100 });
          return {
            business: businessSettings({
              ...business,
              ...memberFields(member),
              ...personalPreferences(member),
            }),
            collections,
            ...(d.at ? { at: d.at, readOnly: true } : {}),
          };
        });
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
        return historyPage(tx, ctx, d);
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
        ensure(
          !tx.accessMember?.access,
          403,
          'FORBIDDEN',
          'Solo el propietario consulta la auditoría',
        );
        const filter = { businessId: ctx.businessId };
        const blocked = Object.keys(resourceModules).filter(
          (name) => !allows(tx.accessMember, resourceModules[name]),
        );
        if (blocked.length) filter.collection = { $nin: blocked };
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
        assertAccess(tx.accessMember, 'finance');
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
