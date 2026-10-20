import { saleSchema } from './schemas.js';
import { totals } from '../../core/money.js';
export function createSalesService({ commands, inventory, finance, contacts }) {
  async function createInTx(tx, input) {
    const customer = await contacts.assertCustomer(tx, input.customerId);
    const lines = await inventory.prepare(tx, input.lines);
    const sale = await tx.insert('sales', {
      ...input,
      lines,
      customer: customer ?? null,
      ...totals(lines, input.discount),
      status: 'completed',
    });
    await inventory.consume(tx, lines, sale._id);
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
    return sale;
  }
  return {
    createInTx,
    create(ctx, input) {
      const d = saleSchema.parse(input);
      return commands.run(ctx, 'sale.created', d, (tx) => createInTx(tx, d));
    },
  };
}
