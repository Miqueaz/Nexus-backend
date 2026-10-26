import { z, id, revision, text, notes, amount, money, date } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { buildSchedule } from './schedule.js';
import { localDay } from './statements.js';
const replacement = z.strictObject({
  name: text,
  creditLineId: id,
  principalMinor: amount,
  feeMinor: money,
  terms: z.number().int().min(1).max(120),
  firstDueOn: date,
  mode: z.enum(['monthly', 'balloon']),
  category: text,
  notes,
});
export function createDebtCorrections({ commands }) {
  async function chain(tx, selected) {
    const rootId = selected.rootDebtId || selected._id,
      rows = [await tx.get('debts', rootId)];
    const related = new Map(
      (await tx.find('debts', { rootDebtId: rootId })).map((r) => [r._id, r]),
    );
    while (rows.at(-1).adjustmentDebtId && rows.length < 200) {
      const next = related.get(rows.at(-1).adjustmentDebtId);
      ensure(next, 409, 'HISTORY_LINK', 'El historial está incompleto');
      rows.push(next);
    }
    return { rootId, rows };
  }
  return {
    history(ctx, debtId) {
      id.parse(debtId);
      return commands.read(ctx, async (tx) => chain(tx, await tx.get('debts', debtId)), {
        module: 'finance',
      });
    },
    correct(ctx, debtId, input, cancel = false) {
      id.parse(debtId);
      const d = z
        .strictObject({ revision, reason: text, replacement: replacement.optional() })
        .parse(input);
      ensure(
        cancel ? !d.replacement : !!d.replacement,
        422,
        'REPLACEMENT_REQUIRED',
        'Envía los datos del ajuste o cancela sin reemplazo',
      );
      return commands.run(
        ctx,
        cancel ? 'debt.charge.cancelled' : 'debt.charge.corrected',
        { debtId, ...d },
        async (tx) => {
          const old = await tx.get('debts', debtId);
          ensure(
            old.revision === d.revision,
            409,
            'REVISION_CONFLICT',
            'El compromiso cambió; recarga su versión',
          );
          ensure(
            !old.correctionStatus &&
              old.kind === 'deferred' &&
              old.creditLineId &&
              old.status === 'active',
            422,
            'SOURCE_MOVEMENT',
            'Solo se corrigen compras a crédito activas',
          );
          ensure(
            !old.paidPrincipalMinor &&
              !old.paidFeeMinor &&
              !(await tx.find('debtPayments', { debtId })).length,
            409,
            'CHARGE_HAS_PAYMENTS',
            'Esta compra ya tiene abonos. No se puede reemplazar sin ajustar sus pagos',
          );
          ensure(
            (await chain(tx, old)).rows.length < 200,
            422,
            'HISTORY_LIMIT',
            'Se alcanzó el límite de ajustes',
          );
          const business = await tx.get('businesses', tx.businessId);
          const lines = [
            ...new Set([old.creditLineId, d.replacement?.creditLineId].filter(Boolean)),
          ];
          for (const lineId of lines) {
            const line = await tx.get('creditLines', lineId);
            const closed = await tx.find('creditStatements', { creditLineId: lineId });
            ensure(
              !closed.some((s) => s.cutoffOn >= localDay(old.createdAt, business.timezone)),
              409,
              'CLOSED_STATEMENT',
              'La compra pertenece a un período cerrado. El estado de cuenta se conserva; registra un ajuste en el período abierto',
            );
            const used = (await tx.find('debts', { creditLineId: lineId, status: 'active' }))
              .filter((x) => x._id !== old._id)
              .reduce(
                (n, x) => n + x.principalMinor + x.feeMinor - x.paidPrincipalMinor - x.paidFeeMinor,
                0,
              );
            const added =
              d.replacement?.creditLineId === lineId
                ? d.replacement.principalMinor + d.replacement.feeMinor
                : 0;
            ensure(
              !added || !line.archived,
              422,
              'CREDIT_LINE_ARCHIVED',
              'La línea está archivada',
            );
            ensure(
              used + added <= line.limitMinor,
              422,
              'CREDIT_LIMIT',
              'El ajuste supera el límite disponible',
            );
            await tx.update('creditLines', lineId, line.revision, { lastActivityAt: new Date() });
          }
          const p = d.replacement,
            rootDebtId = old.rootDebtId || old._id;
          const adjusted = p
            ? await tx.insert('debts', {
                ...p,
                kind: 'deferred',
                billingKind: old.billingKind || 'revolving',
                status: 'active',
                paidPrincipalMinor: 0,
                paidFeeMinor: 0,
                schedule: buildSchedule(
                  p.principalMinor,
                  p.feeMinor,
                  p.terms,
                  p.firstDueOn,
                  p.mode,
                ),
                entryRole: 'adjustment',
                rootDebtId,
                previousDebtId: old._id,
                adjustmentReason: d.reason,
                createdBy: ctx.userId,
                changeReason: d.reason,
                changedBy: ctx.userId,
              })
            : null;
          const original = await tx.update('debts', old._id, old.revision, {
            status: 'cancelled',
            correctionStatus: cancel ? 'cancelled' : 'edited',
            changeReason: d.reason,
            changedBy: ctx.userId,
            changedAt: new Date(),
            ...(adjusted ? { adjustmentDebtId: adjusted._id } : {}),
          });
          return { original, adjusted };
        },
      );
    },
  };
}
