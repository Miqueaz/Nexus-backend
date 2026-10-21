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
import { buildSchedule, buildCustomSchedule, allocatePayment, pending } from './schedule.js';
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
  async function payInTx(tx, debtId, d, checkCapacity = true) {
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
    if (checkCapacity && debt.creditLineId) await capacity(tx, debt.creditLineId, 0);
    return { debt: updated, payment };
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
          category: text.default('General'),
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
        return payInTx(tx, debtId, d);
      });
    },
    payLine(ctx, lineId, input) {
      id.parse(lineId);
      const d = z
        .strictObject({ walletId: id, amountMinor: amount, description: notes, revision })
        .parse(input);
      return commands.run(ctx, 'debt.line.payment.created', { lineId, ...d }, async (tx) => {
        const line = await tx.get('creditLines', lineId);
        ensure(!line.archived, 422, 'CREDIT_LINE_ARCHIVED', 'Línea de crédito archivada');
        ensure(
          line.revision === d.revision,
          409,
          'REVISION_CONFLICT',
          'La línea cambió; recarga su versión',
        );
        const remaining = (debt) => {
          const p = pending(debt);
          return p.principalMinor + p.feeMinor;
        };
        const firstDue = (debt) =>
          debt.schedule.find(
            (r) => r.principalMinor + r.feeMinor > r.paidPrincipalMinor + r.paidFeeMinor,
          )?.dueOn ?? debt.firstDueOn;
        const debts = (await tx.find('debts', { creditLineId: lineId, status: 'active' }))
          .filter((debt) => remaining(debt) > 0)
          .sort(
            (a, b) =>
              firstDue(a).localeCompare(firstDue(b)) ||
              a.createdAt - b.createdAt ||
              a._id.localeCompare(b._id),
          );
        const total = debts.reduce((sum, debt) => safeInteger(sum + remaining(debt)), 0);
        ensure(total > 0, 409, 'NO_PENDING_DEBT', 'La línea no tiene deuda pendiente');
        ensure(
          d.amountMinor <= total,
          422,
          'OVERPAYMENT',
          'El pago supera el saldo pendiente de la línea',
        );
        let left = d.amountMinor;
        const payments = [];
        for (const debt of debts) {
          if (!left) break;
          const amountMinor = Math.min(left, remaining(debt));
          payments.push(
            await payInTx(tx, debt._id, { ...d, amountMinor, revision: debt.revision }, false),
          );
          left -= amountMinor;
        }
        await capacity(tx, lineId, 0);
        return { line: await tx.get('creditLines', lineId), payments, amountMinor: d.amountMinor };
      });
    },
    reschedule(ctx, debtId, input) {
      id.parse(debtId);
      const d = z
        .strictObject({
          terms,
          firstDueOn: date,
          mode: z.enum(['monthly', 'balloon', 'custom']),
          installmentsMinor: z.array(money).min(1).max(120).optional(),
          additionalFeeMinor: money.default(0),
          reason: text,
          revision,
        })
        .parse(input);
      ensure(
        d.mode === 'custom'
          ? d.installmentsMinor?.length === d.terms
          : d.installmentsMinor === undefined,
        422,
        'INVALID_SCHEDULE',
        'El plan personalizado requiere un importe por cada mes; los demás planes no admiten importes manuales',
      );
      return commands.run(ctx, 'debt.rescheduled', { debtId, ...d }, async (tx) => {
        const debt = await tx.get('debts', debtId);
        ensure(debt.status === 'active', 409, 'DEBT_SETTLED', 'La deuda está liquidada');
        ensure(
          debt.revision === d.revision,
          409,
          'REVISION_CONFLICT',
          'La deuda cambió; recarga su versión',
        );
        const remaining = pending(debt);
        const feeMinor = safeInteger(debt.feeMinor + d.additionalFeeMinor);
        const schedule =
          d.mode === 'custom'
            ? buildCustomSchedule(
                remaining.principalMinor,
                remaining.feeMinor + d.additionalFeeMinor,
                d.installmentsMinor,
                d.firstDueOn,
              )
            : buildSchedule(
                remaining.principalMinor,
                remaining.feeMinor + d.additionalFeeMinor,
                d.terms,
                d.firstDueOn,
                d.mode,
              );
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
          schedule: [...paid, ...schedule],
          rescheduleReason: d.reason,
        });
      });
    },
  };
}
