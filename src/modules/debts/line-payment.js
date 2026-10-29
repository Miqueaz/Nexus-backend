/** Equal shares in integer cents; small balances release their excess to other debts. */
export function distributeUniform(balances, amountMinor) {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    balances.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    amountMinor > balances.reduce((n, b) => n + b, 0)
  )
    throw new RangeError('Abono inválido');
  const portions = balances.map(() => 0);
  let left = amountMinor,
    active = balances.map((n, i) => i).filter((i) => balances[i] > 0);
  while (left) {
    const share = Math.floor(left / active.length);
    if (!share) {
      for (const i of active) {
        if (!left) break;
        portions[i]++;
        left--;
      }
      break;
    }
    for (const i of active) {
      const payment = Math.min(share, balances[i] - portions[i]);
      portions[i] += payment;
      left -= payment;
    }
    active = active.filter((i) => portions[i] < balances[i]);
  }
  return portions;
}
