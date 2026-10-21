import { ensure } from '../../core/errors.js';
export function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
export function buildSchedule(principalMinor, feeMinor, terms, firstDueOn, mode) {
  const split = (total, i) => Math.floor(total / terms) + (i < total % terms ? 1 : 0);
  return Array.from({ length: terms }, (_, i) => ({
    dueOn: addMonths(firstDueOn, i),
    principalMinor:
      mode === 'balloon' ? (i === terms - 1 ? principalMinor : 0) : split(principalMinor, i),
    feeMinor: split(feeMinor, i),
    paidPrincipalMinor: 0,
    paidFeeMinor: 0,
  }));
}
/** Custom installment totals preserve principal and known fees, in integer cents. */
export function buildCustomSchedule(principalMinor, feeMinor, installmentsMinor, firstDueOn) {
  ensure(
    Array.isArray(installmentsMinor) &&
      installmentsMinor.length > 0 &&
      installmentsMinor.length <= 120,
    422,
    'INVALID_SCHEDULE',
    'Selecciona entre 1 y 120 mensualidades',
  );
  ensure(
    installmentsMinor.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000_000),
    422,
    'INVALID_SCHEDULE',
    'Los importes mensuales deben ser centavos enteros y no negativos',
  );
  const total = installmentsMinor.reduce((sum, n) => sum + n, 0);
  ensure(
    Number.isSafeInteger(total) && total === principalMinor + feeMinor && total > 0,
    422,
    'SCHEDULE_TOTAL_MISMATCH',
    'La suma de los pagos debe coincidir con el saldo pendiente más los cargos adicionales',
  );
  let feesLeft = feeMinor;
  return installmentsMinor.map((amountMinor, i) => {
    const fees = Math.min(amountMinor, feesLeft);
    feesLeft -= fees;
    return {
      dueOn: addMonths(firstDueOn, i),
      principalMinor: amountMinor - fees,
      feeMinor: fees,
      paidPrincipalMinor: 0,
      paidFeeMinor: 0,
    };
  });
}
export function allocatePayment(schedule, amountMinor) {
  const next = structuredClone(schedule);
  let remaining = amountMinor;
  let principalMinor = 0,
    feeMinor = 0;
  for (const installment of next) {
    const fee = Math.min(remaining, installment.feeMinor - installment.paidFeeMinor);
    installment.paidFeeMinor += fee;
    feeMinor += fee;
    remaining -= fee;
    const principal = Math.min(
      remaining,
      installment.principalMinor - installment.paidPrincipalMinor,
    );
    installment.paidPrincipalMinor += principal;
    principalMinor += principal;
    remaining -= principal;
    if (!remaining) break;
  }
  ensure(remaining === 0, 422, 'OVERPAYMENT', 'El pago supera el saldo pendiente');
  return { schedule: next, principalMinor, feeMinor };
}
export const pending = (d) => ({
  principalMinor: d.principalMinor - d.paidPrincipalMinor,
  feeMinor: d.feeMinor - d.paidFeeMinor,
});
