import { z, id, text, notes, money, date, revision } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { roundRatio, safeInteger } from '../../core/money.js';

const bps = z.number().int().min(0).max(10000);
export const minimumRuleSchema = z.strictObject({
  issuer: text.default('Regla personalizada'),
  principalBps: bps.default(150),
  limitBps: bps.default(125),
  floorMinor: money.default(0),
  includeInstallments: z.boolean().default(true),
  includeFees: z.boolean().default(true),
  includeArrears: z.boolean().default(true),
  dayBasis: z.union([z.literal(360), z.literal(365)]).default(360),
  vatBps: bps.default(1600),
});
export const statementInputSchema = z.strictObject({
  periodStartOn: date,
  cutoffOn: date,
  dueOn: date,
  revolvingMinor: money,
  interestFreeInstallmentMinor: money.default(0),
  financedInstallmentMinor: money.default(0),
  feesMinor: money.default(0),
  arrearsMinor: money.default(0),
  interestSource: z.enum(['captured', 'averageDaily']).default('captured'),
  interestMinor: money.default(0),
  vatMinor: money.default(0),
  averageDailyBalanceMinor: money.nullable().default(null),
  annualInterestBps: z.number().int().min(0).max(100000).nullable().default(null),
  officialMinimumMinor: money.nullable().default(null),
  officialInterestFreeMinor: money.nullable().default(null),
  notes,
});
export function localDay(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/Tijuana',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k).value).join('-');
}
export function calculateStatement(input, line) {
  const d = statementInputSchema.parse(input),
    rule = minimumRuleSchema.parse(line.minimumRule || {});
  ensure(
    d.periodStartOn <= d.cutoffOn && d.dueOn > d.cutoffOn,
    422,
    'STATEMENT_DATES',
    'El inicio debe ser anterior o igual al corte y el pago debe vencer después del corte',
  );
  const days = (Date.parse(d.cutoffOn) - Date.parse(d.periodStartOn)) / 86400000 + 1;
  ensure(days <= 62, 422, 'STATEMENT_PERIOD', 'El período no puede exceder 62 días');
  let interestMinor = d.interestMinor,
    vatMinor = d.vatMinor;
  const annualInterestBps = d.annualInterestBps ?? line.annualInterestBps ?? null;
  if (d.interestSource === 'averageDaily') {
    ensure(
      d.averageDailyBalanceMinor !== null && annualInterestBps !== null,
      422,
      'INTEREST_INPUTS',
      'Captura el saldo promedio diario y la tasa anual para estimar intereses',
    );
    interestMinor = roundRatio(
      BigInt(d.averageDailyBalanceMinor) * BigInt(annualInterestBps) * BigInt(days),
      10000 * rule.dayBasis,
    );
    vatMinor = roundRatio(BigInt(interestMinor) * BigInt(rule.vatBps), 10000);
  }
  const installmentsMinor = safeInteger(
    d.interestFreeInstallmentMinor + d.financedInstallmentMinor,
  );
  const revolvingTotalMinor = safeInteger(
    d.revolvingMinor + interestMinor + vatMinor + d.feesMinor,
  );
  const totalDueMinor = safeInteger(revolvingTotalMinor + installmentsMinor + d.arrearsMinor);
  ensure(
    totalDueMinor <= 100_000_000_000,
    422,
    'STATEMENT_TOTAL',
    'El total del estado de cuenta supera el importe permitido',
  );
  const balanceCriterionMinor = safeInteger(
    roundRatio(BigInt(d.revolvingMinor) * BigInt(rule.principalBps), 10000) +
      interestMinor +
      vatMinor +
      (rule.includeFees ? d.feesMinor : 0),
  );
  const limitCriterionMinor = roundRatio(BigInt(line.limitMinor) * BigInt(rule.limitBps), 10000);
  const revolvingMinimumMinor = Math.min(
    revolvingTotalMinor,
    Math.max(balanceCriterionMinor, limitCriterionMinor, rule.floorMinor),
  );
  const estimatedMinimumMinor = Math.min(
    totalDueMinor,
    safeInteger(
      revolvingMinimumMinor +
        (rule.includeInstallments ? installmentsMinor : 0) +
        (rule.includeArrears ? d.arrearsMinor : 0),
    ),
  );
  return {
    algorithmVersion: 1,
    days,
    ruleSnapshot: rule,
    lineLimitMinor: line.limitMinor,
    annualInterestBps,
    interestMinor,
    vatMinor,
    balanceCriterionMinor,
    limitCriterionMinor,
    revolvingMinimumMinor,
    estimatedMinimumMinor,
    totalDueMinor,
  };
}
/** A real payment belongs to the last cut strictly preceding its posting day. */
export async function allocateStatementPayment(tx, lineId, payment, timezone) {
  const day = localDay(payment.createdAt, timezone);
  const statement = (await tx.find('creditStatements', { creditLineId: lineId }))
    .filter((s) => s.cutoffOn < day)
    .sort((a, b) => b.cutoffOn.localeCompare(a.cutoffOn))[0];
  if (!statement || statement.payments.some((p) => p.debtPaymentId === payment._id)) return;
  await tx.update('creditStatements', statement._id, statement.revision, {
    paidMinor: safeInteger(statement.paidMinor + payment.amountMinor),
    payments: [
      ...statement.payments,
      { debtPaymentId: payment._id, amountMinor: payment.amountMinor, paidOn: day },
    ],
  });
}
export function createCreditStatementsService({ commands }) {
  async function reconcile(tx, lineId) {
    const b = await tx.get('businesses', tx.businessId),
      debtIds = (await tx.find('debts', { creditLineId: lineId })).map((d) => d._id);
    const periods = (await tx.find('creditStatements', { creditLineId: lineId })).sort((a, b) =>
      a.cutoffOn.localeCompare(b.cutoffOn),
    );
    const payments = (await tx.find('debtPayments', { debtId: { $in: debtIds } })).sort(
      (a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id),
    );
    const assigned = new Map(periods.map((s) => [s._id, []]));
    for (const p of payments) {
      const day = localDay(p.createdAt, b.timezone),
        period = [...periods].reverse().find((s) => s.cutoffOn < day);
      if (period)
        assigned
          .get(period._id)
          .push({ debtPaymentId: p._id, amountMinor: p.amountMinor, paidOn: day });
    }
    for (const s of periods) {
      const receipts = assigned.get(s._id);
      if (JSON.stringify(receipts) !== JSON.stringify(s.payments))
        await tx.update('creditStatements', s._id, s.revision, {
          payments: receipts,
          paidMinor: receipts.reduce((sum, p) => safeInteger(sum + p.amountMinor), 0),
        });
    }
  }
  return {
    classify(ctx, debtId, input) {
      id.parse(debtId);
      const d = z
        .strictObject({
          billingKind: z.enum(['revolving', 'interestFree', 'installments']),
          revision,
        })
        .parse(input);
      return commands.run(ctx, 'debt.billingKind.updated', { debtId, ...d }, async (tx) =>
        tx.update('debts', debtId, d.revision, { billingKind: d.billingKind }),
      );
    },
    rule(ctx, lineId, input) {
      id.parse(lineId);
      const d = z.strictObject({ rule: minimumRuleSchema, revision }).parse(input);
      return commands.run(ctx, 'creditLine.minimumRule.updated', { lineId, ...d }, async (tx) => {
        const line = await tx.get('creditLines', lineId);
        ensure(!line.archived, 422, 'CREDIT_LINE_ARCHIVED', 'La línea está archivada');
        return tx.update('creditLines', lineId, d.revision, { minimumRule: d.rule });
      });
    },
    preview(ctx, lineId, input) {
      id.parse(lineId);
      const d = statementInputSchema.parse(input);
      return commands.read(
        ctx,
        async (tx) => calculateStatement(d, await tx.get('creditLines', lineId)),
        { module: 'finance' },
      );
    },
    close(ctx, lineId, input) {
      id.parse(lineId);
      const { revision: expected, ...d } = statementInputSchema.extend({ revision }).parse(input);
      return commands.run(
        ctx,
        'creditLine.statement.closed',
        { lineId, ...d, revision: expected },
        async (tx) => {
          const line = await tx.get('creditLines', lineId),
            b = await tx.get('businesses', tx.businessId);
          ensure(!line.archived, 422, 'CREDIT_LINE_ARCHIVED', 'La línea está archivada');
          ensure(
            line.revision === expected,
            409,
            'REVISION_CONFLICT',
            'La línea cambió; recarga antes de cerrar',
          );
          ensure(
            d.cutoffOn <= localDay(Date.now(), b.timezone),
            422,
            'FUTURE_STATEMENT',
            'Solo puedes cerrar períodos que ya llegaron a su fecha de corte',
          );
          const existing = await tx.find('creditStatements', { creditLineId: lineId });
          ensure(
            existing.every((s) => s.cutoffOn < d.periodStartOn),
            409,
            'STATEMENT_OVERLAP',
            'Este período se superpone con otro o es anterior al último cierre',
          );
          const calculation = calculateStatement(d, line);
          const statement = await tx.insert('creditStatements', {
            ...d,
            creditLineId: lineId,
            status: 'closed',
            calculation,
            paidMinor: 0,
            payments: [],
          });
          await tx.update('creditLines', lineId, expected, { lastStatementId: statement._id });
          await reconcile(tx, lineId);
          return tx.get('creditStatements', statement._id);
        },
      );
    },
    official(ctx, statementId, input) {
      id.parse(statementId);
      const d = z
        .strictObject({
          officialMinimumMinor: money.nullable(),
          officialInterestFreeMinor: money.nullable(),
          notes,
          revision,
        })
        .parse(input);
      return commands.run(
        ctx,
        'creditLine.statement.official.updated',
        { statementId, ...d },
        async (tx) => {
          const statement = await tx.get('creditStatements', statementId),
            line = await tx.get('creditLines', statement.creditLineId);
          await tx.update('creditLines', line._id, line.revision, {
            lastStatementActivityAt: new Date(),
          });
          await tx.update('creditStatements', statementId, d.revision, d);
          await reconcile(tx, line._id);
          return tx.get('creditStatements', statementId);
        },
      );
    },
  };
}
