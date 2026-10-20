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
export function totals(lines, discount) {
  const subtotalMinor = lines.reduce(
    (sum, l) => safeInteger(sum + lineAmount(l.unitPriceMinor, l.quantityMilli)),
    0,
  );
  const costMinor = lines.reduce(
    (sum, l) => safeInteger(sum + lineAmount(l.unitCostMinor, l.quantityMilli)),
    0,
  );
  const discountMinor =
    discount.type === 'percent'
      ? roundRatio(BigInt(subtotalMinor) * BigInt(discount.value), 10000)
      : discount.value;
  ensure(
    discountMinor <= subtotalMinor,
    422,
    'INVALID_DISCOUNT',
    'El descuento supera el subtotal',
  );
  return {
    subtotalMinor,
    discountMinor,
    totalMinor: subtotalMinor - discountMinor,
    costMinor,
    profitMinor: subtotalMinor - discountMinor - costMinor,
  };
}
