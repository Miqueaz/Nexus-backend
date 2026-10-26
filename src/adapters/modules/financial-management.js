import { ensure } from '../../core/errors.js';

// Comparte la consulta de obligaciones sin acoplar los servicios entre sí.
export function createFinancialManagementAdapter() {
  const hasPendingDebt = (debts) =>
    debts.some(
      (d) =>
        !d.correctionStatus &&
        d.principalMinor + d.feeMinor - d.paidPrincipalMinor - d.paidFeeMinor > 0,
    );
  return {
    async assertWalletEmpty(tx, wallet) {
      ensure(
        wallet.balanceMinor === 0,
        409,
        'WALLET_HAS_BALANCE',
        'Para editar o eliminar la cuenta, su saldo debe ser cero',
      );
      const debts = await tx.find('debts', { walletId: wallet._id, kind: 'credit' });
      ensure(
        !hasPendingDebt(debts),
        409,
        'WALLET_HAS_DEBT',
        'Liquida los créditos vinculados antes de editar o eliminar la cuenta',
      );
    },
    async assertLineEmpty(tx, line) {
      const debts = await tx.find('debts', { creditLineId: line._id });
      ensure(
        !hasPendingDebt(debts),
        409,
        'CREDIT_LINE_HAS_DEBT',
        'Liquida el capital y los cargos pendientes antes de editar o eliminar la línea',
      );
    },
  };
}
