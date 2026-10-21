import test from 'node:test';
import assert from 'node:assert/strict';
import { totals, lineAmount } from '../src/core/money.js';
import { buildSchedule, allocatePayment, addMonths } from '../src/modules/debts/schedule.js';
import { project } from '../src/modules/planning/projections.js';
import { validateFields } from '../src/core/validation.js';
test('Descuentos fijos y porcentuales conservan centavos y cantidades fraccionarias', () => {
  const lines = [{ quantityMilli: 1500, unitPriceMinor: 1999, unitCostMinor: 1000 }];
  assert.equal(lineAmount(1999, 1500), 2999);
  assert.deepEqual(totals(lines, { type: 'percent', value: 1000 }), {
    subtotalMinor: 2999,
    discountMinor: 300,
    totalMinor: 2699,
    costMinor: 1500,
    profitMinor: 1199,
  });
  assert.equal(totals(lines, { type: 'fixed', value: 199 }).totalMinor, 2800);
  assert.throws(() => totals(lines, { type: 'fixed', value: 5000 }), { code: 'INVALID_DISCOUNT' });
});
test('Calendario mensual conserva el día original al cruzar febrero', () => {
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2028-01-31', 2), '2028-03-31');
});
test('Diferir capital al final y pagar parcialmente no pierde centavos', () => {
  const s = buildSchedule(10001, 1000, 3, '2028-01-31', 'balloon');
  assert.deepEqual(
    s.map((p) => p.principalMinor),
    [0, 0, 10001],
  );
  assert.equal(
    s.reduce((n, p) => n + p.feeMinor, 0),
    1000,
  );
  const p = allocatePayment(s, 500);
  assert.equal(p.feeMinor, 500);
  assert.equal(p.principalMinor, 0);
  const all = allocatePayment(p.schedule, 10501);
  assert.equal(all.principalMinor, 10001);
  assert.equal(all.feeMinor, 500);
  assert.throws(() => allocatePayment(s, 11002), { code: 'OVERPAYMENT' });
  assert.equal(s[0].paidFeeMinor, 0);
});
test('Proyección incluye inversión, costo, comisiones y punto de equilibrio', () => {
  const p = project({
    name: 'Escenario',
    months: 2,
    initialInvestmentMinor: 10000,
    unitPriceMinor: 1000,
    unitCostMinor: 400,
    quantityMilli: 100000,
    fixedMonthlyMinor: 10000,
    salesFeeBps: 1000,
  });
  assert.equal(p.months[0].profitMinor, 40000);
  assert.equal(p.netAfterInvestmentMinor, 70000);
  assert.equal(p.paybackMonth, 1);
  assert.equal(p.breakEvenQuantityMilli, 20000);
});
test('Campos dinámicos rechazan claves desconocidas y links ejecutables', () => {
  assert.throws(() =>
    validateFields([{ key: 'web', type: 'url', required: true }], { web: 'javascript:alert(1)' }),
  );
  assert.throws(() => validateFields([], { unknown: 'x' }));
  assert.deepEqual(
    validateFields([{ key: 'ok', type: 'boolean', required: true }], { ok: false }),
    { ok: false },
  );
});

test('Pagos personalizados conservan centavos, cargos y meses sin pago', async () => {
  const { buildCustomSchedule } = await import('../src/modules/debts/schedule.js');
  const schedule = buildCustomSchedule(90001, 999, [10000, 0, 81000], '2028-01-31');
  assert.deepEqual(
    schedule.map((r) => r.dueOn),
    ['2028-01-31', '2028-02-29', '2028-03-31'],
  );
  assert.equal(
    schedule.reduce((n, r) => n + r.principalMinor, 0),
    90001,
  );
  assert.equal(
    schedule.reduce((n, r) => n + r.feeMinor, 0),
    999,
  );
  assert.equal(schedule[0].feeMinor, 999);
  assert.deepEqual(
    schedule.map((r) => r.principalMinor + r.feeMinor),
    [10000, 0, 81000],
  );
  const paid = allocatePayment(schedule, 91000);
  assert.equal(paid.principalMinor, 90001);
  assert.equal(paid.feeMinor, 999);
  for (const amounts of [[10000, 0, 80999], [10000, 0, 81001], [-1, 91001], [0.5, 90999.5], []]) {
    assert.throws(() => buildCustomSchedule(90001, 999, amounts, '2028-01-31'));
  }
});
