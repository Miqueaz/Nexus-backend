import test from 'node:test';
import assert from 'node:assert/strict';
import { datesBetween, commitmentRows } from '../src/modules/commitments/schedule.js';
test('Recurrence preserves anchor days, leap years, intervals and stopping boundaries', () => {
  const p = { _id: 'p', startOn: '2028-01-31', frequency: 'monthly', interval: 1 };
  assert.deepEqual(datesBetween(p, '2028-01-01', '2028-04-30'), [
    '2028-01-31',
    '2028-02-29',
    '2028-03-31',
    '2028-04-30',
  ]);
  assert.deepEqual(
    datesBetween({ ...p, frequency: 'yearly', startOn: '2028-02-29' }, '2028-01-01', '2032-12-31'),
    ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29'],
  );
  assert.deepEqual(
    datesBetween({ ...p, interval: 2, endOn: '2028-05-30' }, '2028-01-01', '2028-12-31'),
    ['2028-01-31', '2028-03-31'],
  );
  assert.deepEqual(datesBetween({ ...p, frequency: 'once' }, '2028-02-01', '2028-12-31'), []);
  assert.deepEqual(datesBetween({ ...p, stoppedOn: '2028-02-29' }, '2028-01-01', '2028-12-31'), [
    '2028-01-31',
    '2028-02-29',
  ]);
  const rows = commitmentRows(
    [p],
    [{ commitmentId: 'p', dueOn: '2028-01-31', status: 'paid', amountMinor: 123 }],
    '2028-01-01',
    '2028-04-30',
    '2028-02-29',
  );
  assert.deepEqual(
    rows.map((r) => r.status),
    ['paid', 'pending', 'upcoming', 'upcoming'],
  );
  assert.equal(rows[0].amountMinor, 123);
});
