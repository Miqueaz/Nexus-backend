import { z, id, text, notes, date, amount, revision } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { datesBetween } from './schedule.js';
const schema = z
  .strictObject({
    name: text,
    amountMinor: amount,
    startOn: date,
    frequency: z.enum(['once', 'daily', 'weekly', 'monthly', 'yearly']).default('once'),
    interval: z.number().int().min(1).max(120).default(1),
    endOn: date.nullable().default(null),
    category: text.default('Compromisos'),
    paymentMethod: z.enum(['cash', 'card', 'transfer', 'other']).default('transfer'),
    preferredWalletId: id.nullable().default(null),
    notes,
  })
  .refine(
    (d) =>
      d.startOn >= '2000-01-01' &&
      d.startOn <= '2100-12-31' &&
      (!d.endOn || (d.endOn >= d.startOn && d.endOn <= '2100-12-31')),
    'Revisa las fechas del compromiso',
  );
export function createCommitmentsService({ commands, finance }) {
  const today = async (tx) => {
    const b = await tx.get('businesses', tx.businessId);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: b.timezone || 'America/Tijuana',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    return ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k).value).join('-');
  };
  return {
    create(ctx, input) {
      const d = schema.parse(input);
      return commands.run(ctx, 'commitment.created', d, async (tx) => {
        if (d.preferredWalletId) {
          const w = await tx.get('wallets', d.preferredWalletId);
          ensure(!w.archived, 422, 'WALLET_ARCHIVED', 'Cartera archivada');
        }
        return tx.insert('commitments', { ...d, archived: false, stoppedOn: null });
      });
    },
    stop(ctx, commitmentId, input) {
      id.parse(commitmentId);
      const d = z.strictObject({ revision }).parse(input);
      return commands.run(ctx, 'commitment.stopped', { commitmentId, ...d }, async (tx) => {
        const plan = await tx.get('commitments', commitmentId);
        ensure(!plan.archived, 409, 'COMMITMENT_STOPPED', 'El compromiso ya está detenido');
        return tx.update('commitments', commitmentId, d.revision, {
          archived: true,
          stoppedOn: await today(tx),
        });
      });
    },
    resolve(ctx, commitmentId, input) {
      id.parse(commitmentId);
      const d = z
        .strictObject({
          dueOn: date,
          decision: z.enum(['paid', 'cancelled']),
          walletId: id.optional(),
          amountMinor: amount.optional(),
          occurredOn: date.optional(),
          reason: notes,
          revision,
        })
        .parse(input);
      return commands.run(ctx, 'commitment.resolved', { commitmentId, ...d }, async (tx) => {
        const plan = await tx.get('commitments', commitmentId),
          now = await today(tx);
        ensure(d.dueOn <= now, 422, 'COMMITMENT_NOT_DUE', 'El compromiso aún no vence');
        ensure(
          datesBetween(plan, d.dueOn, d.dueOn).length === 1,
          422,
          'INVALID_OCCURRENCE',
          'Esta fecha no corresponde al compromiso',
        );
        ensure(
          !(await tx.find('commitmentResolutions', { commitmentId, dueOn: d.dueOn })).length,
          409,
          'COMMITMENT_RESOLVED',
          'Este pago ya fue resuelto',
        );
        ensure(
          d.decision !== 'cancelled' || d.reason.trim(),
          422,
          'REASON_REQUIRED',
          'Indica por qué se canceló',
        );
        ensure(
          d.decision !== 'paid' || d.walletId,
          422,
          'WALLET_REQUIRED',
          'Selecciona la cartera que pagó',
        );
        const occurredOn = d.occurredOn || now;
        ensure(
          occurredOn <= now,
          422,
          'FUTURE_MOVEMENT',
          'La fecha de pago no puede estar en el futuro',
        );
        // Serialize decisions on the plan; concurrent sessions cannot spend twice.
        await tx.update('commitments', commitmentId, d.revision, { lastDecisionAt: new Date() });
        const amountMinor =
          d.decision === 'paid' ? (d.amountMinor ?? plan.amountMinor) : plan.amountMinor;
        const resolution = await tx.insert('commitmentResolutions', {
          commitmentId,
          dueOn: d.dueOn,
          status: d.decision,
          name: plan.name,
          amountMinor,
          reason: d.reason,
          walletId: d.decision === 'paid' ? d.walletId : null,
          occurredOn: d.decision === 'paid' ? occurredOn : null,
        });
        let movement = null;
        if (d.decision === 'paid')
          movement = await finance.post(tx, {
            walletId: d.walletId,
            amountMinor: -amountMinor,
            kind: 'expense',
            category: plan.category,
            operatingMinor: -amountMinor,
            description: plan.name + (d.reason ? ' · ' + d.reason : ''),
            occurredOn,
            commitmentId,
            commitmentDueOn: d.dueOn,
            reference: resolution._id,
          });
        return { resolution, movement };
      });
    },
  };
}
