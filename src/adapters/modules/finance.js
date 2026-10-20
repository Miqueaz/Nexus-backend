import { ensure } from '../../core/errors.js';
import { safeInteger } from '../../core/money.js';
export function createFinanceAdapter() {
  return {
    async post(tx, input) {
      const wallet = await tx.get('wallets', input.walletId);
      ensure(!wallet.archived, 422, 'WALLET_ARCHIVED', 'Cartera archivada');
      const balanceMinor = safeInteger(wallet.balanceMinor + input.amountMinor);
      ensure(
        wallet.allowNegative || balanceMinor >= 0,
        422,
        'INSUFFICIENT_FUNDS',
        'Saldo insuficiente',
      );
      await tx.update('wallets', wallet._id, wallet.revision, { balanceMinor });
      return tx.insert('movements', {
        ...input,
        balanceAfterMinor: balanceMinor,
        occurredOn: input.occurredOn ?? new Date().toISOString().slice(0, 10),
      });
    },
  };
}
