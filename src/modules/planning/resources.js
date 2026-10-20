import { z, id, text, notes, date, revision } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
const schemas = {
  projects: z.strictObject({
    name: text,
    description: notes,
    status: z.enum(['planned', 'active', 'paused', 'completed']).default('planned'),
    dueOn: date.optional(),
    tasks: z
      .array(z.strictObject({ id, title: text, done: z.boolean().default(false) }))
      .max(200)
      .default([])
      .refine(
        (tasks) => new Set(tasks.map((t) => t.id)).size === tasks.length,
        'IDs de tareas repetidos',
      ),
  }),
  events: z
    .strictObject({
      title: text,
      description: notes,
      date: date,
      endDate: date.optional(),
      kind: z.enum(['reminder', 'meeting', 'payment', 'other']).default('reminder'),
    })
    .refine((d) => !d.endDate || d.endDate >= d.date, 'La fecha final precede al inicio'),
};
export function createPlanningService({ commands }) {
  return {
    create(ctx, collection, input) {
      const d = schemas[collection].parse(input);
      return commands.run(ctx, `${collection}.created`, d, (tx) =>
        tx.insert(collection, { ...d, archived: false }),
      );
    },
    update(ctx, collection, entityId, input) {
      id.parse(entityId);
      const d = schemas[collection]
        .safeExtend({ revision, archived: z.boolean().default(false) })
        .parse(input);
      return commands.run(ctx, `${collection}.updated`, { entityId, ...d }, (tx) =>
        tx.update(collection, entityId, d.revision, d),
      );
    },
    calendar(ctx, query) {
      const d = z.strictObject({ from: date, to: date }).parse(query);
      ensure(
        d.from <= d.to && Date.parse(d.to) - Date.parse(d.from) <= 366 * 86400000,
        422,
        'DATE_RANGE',
        'Selecciona un rango de hasta 366 días',
      );
      return commands.read(ctx, async (tx) => {
        const out = [];
        for (const e of await tx.find('events', {
          archived: false,
          date: { $lte: d.to },
          $or: [{ endDate: { $gte: d.from } }, { date: { $gte: d.from } }],
        }))
          out.push({ ...e, source: 'event' });
        for (const p of await tx.find('projects', {
          archived: false,
          status: { $ne: 'completed' },
          dueOn: { $gte: d.from, $lte: d.to },
        }))
          out.push({ _id: p._id, title: p.name, date: p.dueOn, source: 'project' });
        for (const q of await tx.find('quotes', {
          status: { $in: ['draft', 'sent', 'accepted'] },
          expiresOn: { $gte: d.from, $lte: d.to },
        }))
          out.push({ _id: q._id, title: q.title, date: q.expiresOn, source: 'quote' });
        for (const debt of await tx.find('debts', { status: 'active' }))
          for (const [i, p] of debt.schedule.entries())
            if (
              p.dueOn >= d.from &&
              p.dueOn <= d.to &&
              p.principalMinor + p.feeMinor > p.paidPrincipalMinor + p.paidFeeMinor
            )
              out.push({
                _id: `${debt._id}:${i}`,
                debtId: debt._id,
                title: debt.name,
                date: p.dueOn,
                source: 'debt',
                pendingMinor: p.principalMinor + p.feeMinor - p.paidPrincipalMinor - p.paidFeeMinor,
              });
        return out.sort((a, b) => a.date.localeCompare(b.date));
      });
    },
  };
}
