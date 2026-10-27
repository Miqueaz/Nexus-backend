import { ensure } from '../../core/errors.js';
import { id, revision, z } from '../../core/validation.js';
import { calculateCommissions, commissionsInput } from './commissions.js';
import { randomUUID } from 'node:crypto';
import { saleSchema } from './schemas.js';
import { totals } from '../../core/money.js';
export function createSalesService({ commands, inventory, finance, contacts, commissionWallets }) {
  async function createInTx(tx, input) {
    ensure(
      !input.customerId || !input.customerName,
      422,
      'CUSTOMER_CHOICE',
      'Selecciona un contacto o escribe un nombre de cliente',
    );
    const customer = input.customerId
      ? await contacts.assertCustomer(tx, input.customerId)
      : input.customerName
        ? { name: input.customerName }
        : null;
    const lines = await inventory.prepare(tx, input.lines);
    const commercial = totals(lines, input.discount);
    const commissions = await calculateCommissions(
      tx,
      input.commissions || [],
      { ...commercial, lines },
      contacts,
    );
    const saleId = randomUUID();
    commissions.commissions = await commissionWallets.prepare(tx, commissions.commissions);
    await inventory.consume(tx, lines, saleId);
    const sale = await tx.insert(
      'sales',
      {
        ...input,
        lines,
        customer: customer ?? null,
        ...commercial,
        ...commissions,
        commissionAllocations: [
          ...commissions.commissions.reduce(
            (map, c) => map.set(c.walletId, (map.get(c.walletId) || 0) + c.amountMinor),
            new Map(),
          ),
        ].map(([walletId, amountMinor]) => ({ walletId, amountMinor })),
        status: 'completed',
      },
      saleId,
    );
    // Valida la cartera incluso si la venta termina en cero por el descuento.
    await finance.post(tx, {
      walletId: input.walletId,
      amountMinor: sale.totalMinor,
      kind: 'sale',
      category: 'sales',
      operatingMinor: sale.totalMinor,
      description: input.description,
      reference: sale._id,
    });
    await commissionWallets.settle(
      tx,
      { ...sale, commissionAllocations: [] },
      commissions.commissions,
    );
    return sale;
  }
  return {
    createInTx,
    setCommissions(ctx, saleId, input) {
      id.parse(saleId);
      const data = z.strictObject({ revision, commissions: commissionsInput }).parse(input);
      return commands.run(ctx, 'sale.commissions.updated', { saleId, ...data }, async (tx) => {
        const sale = await tx.get('sales', saleId);
        const result = await calculateCommissions(tx, data.commissions, sale, contacts);
        result.commissions = await commissionWallets.prepare(tx, result.commissions);
        result.commissionAllocations = await commissionWallets.settle(tx, sale, result.commissions);
        return tx.update('sales', saleId, data.revision, result);
      });
    },
    create(ctx, input) {
      const d = saleSchema.parse(input);
      return commands.run(ctx, 'sale.created', d, (tx) => createInTx(tx, d));
    },
  };
}
