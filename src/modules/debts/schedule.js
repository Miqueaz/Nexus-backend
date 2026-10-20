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
