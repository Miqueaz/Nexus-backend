import { z, text, money } from '../../core/validation.js';
import { lineAmount, roundRatio, safeInteger } from '../../core/money.js';
const rate = z.number().int().min(0).max(10000);
export const projectionSchema = z.strictObject({
  name: text,
  months: z.number().int().min(1).max(60),
  initialInvestmentMinor: money,
  unitPriceMinor: money,
  unitCostMinor: money,
  quantityMilli: z.number().int().nonnegative().max(1e9),
  monthlyGrowthBps: z.number().int().min(-10000).max(10000).default(0),
  discountBps: rate.default(0),
  salesFeeBps: rate.default(0),
  fixedMonthlyMinor: money.default(0),
});
export function project(input) {
  const d = projectionSchema.parse(input);
  let quantityMilli = d.quantityMilli;
  let cumulativeMinor = -d.initialInvestmentMinor;
  let paybackMonth = null;
  const months = [];
  for (let month = 1; month <= d.months; month++) {
    const grossMinor = lineAmount(d.unitPriceMinor, quantityMilli);
    const revenueMinor = grossMinor - roundRatio(BigInt(grossMinor) * BigInt(d.discountBps), 10000);
    const costMinor = lineAmount(d.unitCostMinor, quantityMilli);
    const feeMinor = roundRatio(BigInt(revenueMinor) * BigInt(d.salesFeeBps), 10000);
    const profitMinor = safeInteger(revenueMinor - costMinor - feeMinor - d.fixedMonthlyMinor);
    cumulativeMinor = safeInteger(cumulativeMinor + profitMinor);
    if (paybackMonth === null && cumulativeMinor >= 0) paybackMonth = month;
    months.push({
      month,
      quantityMilli,
      revenueMinor,
      costMinor,
      feeMinor,
      profitMinor,
      cumulativeMinor,
    });
    quantityMilli = roundRatio(BigInt(quantityMilli) * BigInt(10000 + d.monthlyGrowthBps), 10000);
  }
  const contributionMinor =
    d.unitPriceMinor * (1 - d.discountBps / 10000) * (1 - d.salesFeeBps / 10000) - d.unitCostMinor;
  return {
    assumptions: d,
    months,
    netAfterInvestmentMinor: cumulativeMinor,
    roiPercent: d.initialInvestmentMinor
      ? Math.round((cumulativeMinor / d.initialInvestmentMinor) * 10000) / 100
      : null,
    paybackMonth,
    breakEvenQuantityMilli:
      contributionMinor > 0 ? Math.ceil((d.fixedMonthlyMinor / contributionMinor) * 1000) : null,
  };
}
export function createProjectionsService({ commands }) {
  return {
    calculate: project,
    save(ctx, input) {
      const result = project(input);
      return commands.run(ctx, 'projection.saved', result.assumptions, (tx) =>
        tx.insert('projections', result),
      );
    },
  };
}
