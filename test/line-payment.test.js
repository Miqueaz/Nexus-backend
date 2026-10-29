import test from 'node:test';
import assert from 'node:assert/strict';
import { distributeUniform } from '../src/modules/debts/line-payment.js';
test('Uniform payments redistribute capped balances and preserve every cent deterministically', () => {
  assert.deepEqual(distributeUniform([10000, 20000, 30000], 6000), [2000, 2000, 2000]);
  assert.deepEqual(distributeUniform([100, 1000, 1000], 1001), [100, 451, 450]);
  assert.deepEqual(distributeUniform([1, 1, 100], 5), [1, 1, 3]);
  assert.deepEqual(distributeUniform([0, 3, 3], 1), [0, 1, 0]);
  for (let a = 0; a < 8; a++)
    for (let b = 0; b < 8; b++)
      for (let c = 0; c < 8; c++)
        for (let pay = 1; pay <= a + b + c; pay++) {
          const r = distributeUniform([a, b, c], pay);
          assert.equal(
            r.reduce((n, x) => n + x, 0),
            pay,
          );
          r.forEach((n, i) => assert.ok(n >= 0 && n <= [a, b, c][i]));
          const open = r.filter((n, i) => n < [a, b, c][i]);
          if (open.length) assert.ok(Math.max(...open) - Math.min(...open) <= 1);
        }
  for (const [balances, amount] of [
    [[1], 2],
    [[1], 0],
    [[], 1],
    [[1], 0.5],
    [[-1], 1],
  ])
    assert.throws(() => distributeUniform(balances, amount));
});
