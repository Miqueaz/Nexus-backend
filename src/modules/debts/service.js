import {
  z,
  id,
  text,
  notes,
  money,
  amount,
  date,
  revision,
  parsePatch,
} from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { safeInteger } from '../../core/money.js';
import { buildSchedule, allocatePayment, pending } from './schedule.js';
import {
  creditLineCreateSchema,
  creditLineUpdateSchema,
  assertStatementDates,
} from './credit-lines.js';
const terms = z.number().int().min(1).max(120);
const mode = z.enum(['monthly', 'balloon']);
export function createDebtsService({ commands, finance, contacts, financialManagement }) {
  async function capacity(tx, lineId, additionalMinor, ignoreDebtId) {
    if (!lineId) return;
    const line = await tx.get('creditLines', lineId);
    ensure(!line.archived, 422, 'CREDIT_LINE_ARCHIVED', 'Línea de crédito archivada');
    const debts = await tx.find('debts', { creditLineId: lineId, status: 'active' });
    const usedMinor = debts
      .filter((d) => d._id !== ignoreDebtId)
      .reduce(
        (n, d) => n + d.principalMinor + d.feeMinor - d.paidPrincipalMinor - d.paidFeeMinor,
        0,
      );
    ensure(
      usedMinor + additionalMinor <= line.limitMinor,
      422,
      'CREDIT_LIMIT',
      'El crédito supera el cupo disponible',
    );
    // Escritura deliberada en el agregado para serializar disposiciones concurrentes.
    await tx.update('creditLines', lineId, line.revision, { lastActivityAt: new Date() });
  }
  return {
    createLine(ctx, input) {
      const d = creditLineCreateSchema.parse(input);
      assertStatementDates(d);
      return commands.run(ctx, 'creditLine.created', d, (tx) =>
        tx.insert('creditLines', { ...d, archived: false }),
      );
    },
    updateLine(ctx, lineId, input) {
      id.parse(lineId);
      const d = parsePatch(creditLineUpdateSchema, input);
      return commands.run(ctx, 'creditLine.updated', { lineId, ...d }, async (tx) => {
        const line = await tx.get('creditLines', lineId);
        await financialManagement.assertLineEmpty(tx, line);
        assertStatementDates({ ...line, ...d });
        return tx.update('creditLines', lineId, d.revision, d);
      });
    },
    lineBalances(ctx) {
      return commands.read(ctx, async (tx) => {
        const lines = await tx.find('creditLines');
        const debts = await tx.find('debts', { status: 'active' });
        return lines.map((l) => {
          const usedMinor = debts
            .filter((d) => d.creditLineId === l._id)
            .reduce(
              (n, d) => n + d.principalMinor + d.feeMinor - d.paidPrincipalMinor - d.paidFeeMinor,
              0,
            );
          return { ...l, usedMinor, availableMinor: l.limitMinor - usedMinor };
        });
      });
    },
    create(ctx, input) {
      const d = z
        .strictObject({
          name: text,
          kind: z.enum(['credit', 'deferred']),
          principalMinor: amount,
          feeMinor: money.default(0),
          terms,
          firstDueOn: date,
          mode: mode.default('monthly'),
          walletId: id.optional(),
          creditLineId: id.optional(),
          contactId: id.optional(),
          notes,
        })
        .parse(input);
      ensure(
        d.kind !== 'credit' || d.walletId,
        422,
        'WALLET_REQUIRED',
        'El crédito recibido requiere una cartera',
      );
      return commands.run(ctx, 'debt.created', d, async (tx) => {
        if (d.contactId) await contacts.assertCustomer(tx, d.contactId);
        await capacity(tx, d.creditLineId, d.principalMinor + d.feeMinor);
        const debt = await tx.insert('debts', {
          ...d,
          status: 'active',
          paidPrincipalMinor: 0,
          paidFeeMinor: 0,
          schedule: buildSchedule(d.principalMinor, d.feeMinor, d.terms, d.firstDueOn, d.mode),
        });
        if (d.kind === 'credit')
          await finance.post(tx, {
            walletId: d.walletId,
            amountMinor: d.principalMinor,
            kind: 'credit',
            category: 'loanPrincipal',
            operatingMinor: 0,
            description: d.name,
            reference: debt._id,
          });
        return debt;
      });
    },
    pay(ctx, debtId, input) {
      id.parse(debtId);
      const d = z
        .strictObject({ walletId: id, amountMinor: amount, description: notes, revision })
        .parse(input);
      return commands.run(ctx, 'debt.payment.created', { debtId, ...d }, async (tx) => {
        const debt = await tx.get('debts', debtId);
        ensure(debt.status === 'active', 409, 'DEBT_SETTLED', 'La deuda ya está liquidada');
        const allocation = allocatePayment(debt.schedule, d.amountMinor);
        const paidPrincipalMinor = debt.paidPrincipalMinor + allocation.principalMinor;
        const paidFeeMinor = debt.paidFeeMinor + allocation.feeMinor;
        const payment = await tx.insert('debtPayments', {
          debtId,
          walletId: d.walletId,
          amountMinor: d.amountMinor,
          principalMinor: allocation.principalMinor,
          feeMinor: allocation.feeMinor,
          description: d.description,
        });
        await finance.post(tx, {
          walletId: d.walletId,
          amountMinor: -d.amountMinor,
          kind: 'debtPayment',
          category: debt.kind,
          operatingMinor: -(debt.kind === 'credit' ? allocation.feeMinor : d.amountMinor),
          description: d.description,
          reference: payment._id,
        });
        const updated = await tx.update('debts', debtId, d.revision, {
          schedule: allocation.schedule,
          paidPrincipalMinor,
          paidFeeMinor,
          status:
            paidPrincipalMinor === debt.principalMinor && paidFeeMinor === debt.feeMinor
              ? 'settled'
              : 'active',
        });
        if (debt.creditLineId) await capacity(tx, debt.creditLineId, 0);
        return { debt: updated, payment };
      });
    },
    reschedule(ctx, debtId, input) {
      id.parse(debtId);
      const d = z
        .strictObject({
          terms,
          firstDueOn: date,
          mode,
          additionalFeeMinor: money.default(0),
          reason: text,
          revision,
        })
        .parse(input);
      return commands.run(ctx, 'debt.rescheduled', { debtId, ...d }, async (tx) => {
        const debt = await tx.get('debts', debtId);
        ensure(debt.status === 'active', 409, 'DEBT_SETTLED', 'La deuda está liquidada');
        const remaining = pending(debt);
        const feeMinor = safeInteger(debt.feeMinor + d.additionalFeeMinor);
        await capacity(
          tx,
          debt.creditLineId,
          remaining.principalMinor + remaining.feeMinor + d.additionalFeeMinor,
          debtId,
        );
        const paid = debt.schedule
          .filter((p) => p.paidPrincipalMinor || p.paidFeeMinor)
          .map((p) => ({ ...p, principalMinor: p.paidPrincipalMinor, feeMinor: p.paidFeeMinor }));
        return tx.update('debts', debtId, d.revision, {
          terms: d.terms,
          mode: d.mode,
          firstDueOn: d.firstDueOn,
          feeMinor,
          schedule: [
            ...paid,
            ...buildSchedule(
              remaining.principalMinor,
              remaining.feeMinor + d.additionalFeeMinor,
              d.terms,
              d.firstDueOn,
              d.mode,
            ),
          ],
          rescheduleReason: d.reason,
        });
      });
    },
  };
}
