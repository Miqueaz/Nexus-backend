import { z, text, notes, money, amount, id, date, revision } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
export function createFinanceService({ commands, finance, financialManagement }) {
  return {
    createWallet(ctx, input) {
      const d = z
        .strictObject({
          name: text,
          kind: z.enum(['cash', 'bank', 'card']).default('bank'),
          openingBalanceMinor: money.default(0),
          allowNegative: z.boolean().default(false),
        })
        .parse(input);
      return commands.run(ctx, 'wallet.created', d, async (tx) => {
        const wallet = await tx.insert('wallets', {
          name: d.name,
          kind: d.kind,
          allowNegative: d.allowNegative,
          balanceMinor: 0,
          archived: false,
        });
        if (d.openingBalanceMinor)
          await finance.post(tx, {
            walletId: wallet._id,
            amountMinor: d.openingBalanceMinor,
            kind: 'opening',
            category: 'opening',
            operatingMinor: 0,
            description: 'Saldo inicial',
          });
        return tx.get('wallets', wallet._id);
      });
    },
    updateWallet(ctx, walletId, input) {
      id.parse(walletId);
      const d = z
        .strictObject({
          name: text.optional(),
          kind: z.enum(['cash', 'bank', 'card']).optional(),
          archived: z.boolean().optional(),
          revision,
        })
        .parse(input);
      return commands.run(ctx, 'wallet.updated', { walletId, ...d }, async (tx) => {
        const wallet = await tx.get('wallets', walletId);
        if (d.archived === true) await financialManagement.assertWalletEmpty(tx, wallet);
        return tx.update('wallets', walletId, d.revision, d);
      });
    },
    record(ctx, input) {
      const d = z
        .strictObject({
          walletId: id,
          kind: z.enum(['income', 'expense']),
          amountMinor: amount,
          category: text,
          description: notes,
          occurredOn: date.optional(),
        })
        .parse(input);
      ensure(
        !d.occurredOn || d.occurredOn <= new Date().toISOString().slice(0, 10),
        422,
        'FUTURE_MOVEMENT',
        'Registra movimientos futuros en calendario',
      );
      return commands.run(ctx, 'finance.movement.created', d, (tx) =>
        finance.post(tx, {
          ...d,
          amountMinor: d.kind === 'expense' ? -d.amountMinor : d.amountMinor,
          operatingMinor: d.kind === 'expense' ? -d.amountMinor : d.amountMinor,
        }),
      );
    },
    transfer(ctx, input) {
      const d = z
        .strictObject({ fromWalletId: id, toWalletId: id, amountMinor: amount, description: notes })
        .parse(input);
      ensure(
        d.fromWalletId !== d.toWalletId,
        422,
        'SAME_WALLET',
        'Selecciona dos carteras diferentes',
      );
      return commands.run(ctx, 'finance.transfer.created', d, async (tx) => {
        const from = await finance.post(tx, {
          walletId: d.fromWalletId,
          amountMinor: -d.amountMinor,
          kind: 'transfer',
          category: 'transfer',
          operatingMinor: 0,
          description: d.description,
        });
        const to = await finance.post(tx, {
          walletId: d.toWalletId,
          amountMinor: d.amountMinor,
          kind: 'transfer',
          category: 'transfer',
          operatingMinor: 0,
          description: d.description,
          reference: from._id,
        });
        return { from, to };
      });
    },
  };
}
