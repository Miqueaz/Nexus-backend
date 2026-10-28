import { ensure } from './errors.js';
export function safeInteger(n) {
  ensure(
    Number.isSafeInteger(n) && Math.abs(n) <= 1_000_000_000_000_000,
    422,
    'AMOUNT_OVERFLOW',
    'Importe fuera de rango',
  );
  return n;
}
export function roundRatio(numerator, denominator) {
  const a = BigInt(numerator),
    b = BigInt(denominator);
  return safeInteger(Number((a + b / 2n) / b));
}
export function lineAmount(unitMinor, quantityMilli) {
  return roundRatio(BigInt(unitMinor) * BigInt(quantityMilli), 1000);
}
export const lineRevenue = (line) =>
  line.revenueMinor ?? lineAmount(line.unitPriceMinor, line.quantityMilli);
export function totals(lines, discount) {
  const subtotalMinor = lines.reduce((sum, l) => safeInteger(sum + lineRevenue(l)), 0);
  const costMinor = lines.reduce(
    (sum, l) =>
      safeInteger(
        sum +
          (l.costTotalMinor ??
            lineAmount(l.unitCostMinor, l.consumedQuantityMilli ?? l.quantityMilli)),
      ),
    0,
  );
  const discountMinor =
    discount.type === 'percent'
      ? roundRatio(BigInt(subtotalMinor) * BigInt(discount.value), 10000)
      : discount.type === 'charged'
        ? subtotalMinor - discount.value
        : discount.value;
  ensure(
    discountMinor >= 0 && discountMinor <= subtotalMinor,
    422,
    'INVALID_DISCOUNT',
    'El descuento o monto cobrado debe estar entre cero y el subtotal',
  );
  return {
    subtotalMinor,
    discountMinor,
    totalMinor: subtotalMinor - discountMinor,
    costMinor,
    profitMinor: subtotalMinor - discountMinor - costMinor,
  };
}
