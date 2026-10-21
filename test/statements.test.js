import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateStatement } from '../src/modules/debts/statements.js';
const period = {
  periodStartOn: '2026-09-01',
  cutoffOn: '2026-09-30',
  dueOn: '2026-10-10',
  revolvingMinor: 100000,
};
const line = { limitMinor: 500000 };
test('Mínimo estimado compara criterios, suma mensualidades y limita al saldo, sin usar el límite como deuda', () => {
  const c = calculateStatement(
    {
      ...period,
      interestMinor: 1000,
      vatMinor: 160,
      interestFreeInstallmentMinor: 20000,
      financedInstallmentMinor: 5000,
      arrearsMinor: 1000,
    },
    line,
  );
  assert.equal(c.balanceCriterionMinor, 2660);
  assert.equal(c.limitCriterionMinor, 6250);
  assert.equal(c.estimatedMinimumMinor, 32250);
  assert.equal(c.totalDueMinor, 127160);
  assert.equal(
    calculateStatement({ ...period, revolvingMinor: 500 }, line).estimatedMinimumMinor,
    500,
  );
  assert.equal(calculateStatement({ ...period, revolvingMinor: 0 }, line).estimatedMinimumMinor, 0);
  assert.equal(
    calculateStatement(period, {
      ...line,
      minimumRule: { principalBps: 1000, limitBps: 0, floorMinor: 20000 },
    }).estimatedMinimumMinor,
    20000,
  );
});
test('Intereses estimados usan promedio diario, días, tasa y base; los capturados se preservan', () => {
  const c = calculateStatement(
    {
      ...period,
      interestSource: 'averageDaily',
      averageDailyBalanceMinor: 100000,
      annualInterestBps: 3600,
    },
    line,
  );
  assert.equal(c.days, 30);
  assert.equal(c.interestMinor, 3000);
  assert.equal(c.vatMinor, 480);
  assert.equal(
    calculateStatement({ ...period, interestMinor: 123, vatMinor: 20 }, line).interestMinor,
    123,
  );
  assert.throws(() => calculateStatement({ ...period, interestSource: 'averageDaily' }, line), {
    code: 'INTEREST_INPUTS',
  });
  for (const changes of [
    { revolvingMinor: -1 },
    { revolvingMinor: 1.5 },
    { periodStartOn: '2026-10-01' },
    { dueOn: '2026-09-30' },
    { periodStartOn: '2026-01-01' },
    { calculation: { estimatedMinimumMinor: 0 } },
  ])
    assert.throws(() => calculateStatement({ ...period, ...changes }, line));
});
