import { z, id, revision } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { totals } from '../../core/money.js';
import { quoteSchema } from '../sales/schemas.js';
export function createQuotesService({ commands, inventory, contacts, sales }) {
  return {
    create(ctx, input) {
      const d = quoteSchema.parse(input);
      return commands.run(ctx, 'quote.created', d, async (tx) => {
        const customer = await contacts.assertCustomer(tx, d.customerId);
        const lines = await inventory.prepare(tx, d.lines);
        return tx.insert('quotes', {
          ...d,
          lines,
          customer: customer ?? null,
          ...totals(lines, d.discount),
          status: 'draft',
        });
      });
    },
    update(ctx, quoteId, input) {
      id.parse(quoteId);
      const d = quoteSchema.extend({ revision }).parse(input);
      return commands.run(ctx, 'quote.updated', { quoteId, ...d }, async (tx) => {
        const quote = await tx.get('quotes', quoteId);
        ensure(
          quote.status === 'draft',
          409,
          'QUOTE_LOCKED',
          'Solo las cotizaciones en borrador se pueden editar',
        );
        const customer = await contacts.assertCustomer(tx, d.customerId);
        const lines = await inventory.prepare(tx, d.lines);
        return tx.update('quotes', quoteId, d.revision, {
          ...d,
          lines,
          customer: customer ?? null,
          ...totals(lines, d.discount),
        });
      });
    },
    status(ctx, quoteId, input) {
      id.parse(quoteId);
      const d = z
        .strictObject({ status: z.enum(['sent', 'accepted', 'cancelled']), revision })
        .parse(input);
      return commands.run(ctx, 'quote.status.updated', { quoteId, ...d }, async (tx) => {
        const q = await tx.get('quotes', quoteId);
        const transitions = {
          draft: ['sent', 'accepted', 'cancelled'],
          sent: ['accepted', 'cancelled'],
          accepted: ['cancelled'],
        };
        ensure(
          transitions[q.status]?.includes(d.status),
          409,
          'INVALID_TRANSITION',
          'Cambio de estado no permitido',
        );
        return tx.update('quotes', quoteId, d.revision, { status: d.status });
      });
    },
    convert(ctx, quoteId, input) {
      id.parse(quoteId);
      const d = z.strictObject({ walletId: id, revision }).parse(input);
      return commands.run(ctx, 'quote.converted', { quoteId, ...d }, async (tx) => {
        const q = await tx.get('quotes', quoteId);
        ensure(
          q.status === 'accepted',
          409,
          'QUOTE_NOT_ACCEPTED',
          'La cotización debe estar aceptada y sin convertir',
        );
        ensure(
          q.expiresOn >= new Date().toISOString().slice(0, 10),
          422,
          'QUOTE_EXPIRED',
          'La cotización venció',
        );
        const sale = await sales.create(tx, {
          walletId: d.walletId,
          customerId: q.customerId,
          lines: q.lines,
          discount: q.discount,
          description: q.notes,
          quoteId,
        });
        await tx.update('quotes', quoteId, d.revision, { status: 'converted', saleId: sale._id });
        return sale;
      });
    },
    clientView(ctx, quoteId) {
      id.parse(quoteId);
      return commands.read(ctx, async (tx) => {
        const q = await tx.get('quotes', quoteId);
        return {
          _id: q._id,
          title: q.title,
          customer: q.customer,
          status: q.status,
          expiresOn: q.expiresOn,
          notes: q.notes,
          discount: q.discount,
          lines: q.lines.map(({ name, unit, quantityMilli, unitPriceMinor }) => ({
            name,
            unit,
            quantityMilli,
            unitPriceMinor,
          })),
          subtotalMinor: q.subtotalMinor,
          discountMinor: q.discountMinor,
          totalMinor: q.totalMinor,
        };
      });
    },
  };
}
