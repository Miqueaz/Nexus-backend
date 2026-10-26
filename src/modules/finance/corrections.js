import { z, id, revision, text, notes, amount, date } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { safeInteger } from '../../core/money.js';
const replacement = z.strictObject({
  walletId: id,
  kind: z.enum(['income', 'expense', 'transfer']),
  amountMinor: amount,
  category: text,
  description: notes,
  occurredOn: date,
  toWalletId: id.optional(),
});
const correction = z.strictObject({ revision, reason: text, replacement: replacement.optional() });
const active = (r) => !r.correctionStatus && r.entryRole !== 'reversal';

// Only ledger status changes. Original amounts, dates, references and concepts are immutable.
export function createMovementCorrections({ commands }) {
  async function group(tx, movement) {
    if (movement.kind !== 'transfer') return [movement];
    const from =
      movement.amountMinor < 0 ? movement : await tx.get('movements', movement.reference);
    const partners = await tx.find('movements', { reference: from._id, kind: 'transfer' });
    const to = partners.find((r) => r.amountMinor > 0 && active(r));
    ensure(
      from.amountMinor < 0 && to && active(from),
      409,
      'TRANSFER_LINK',
      'No se pudo resolver la transferencia completa',
    );
    return [from, to];
  }
  async function chain(tx, selected) {
    const rootId =
      selected.rootMovementId ||
      (selected.kind === 'transfer' && selected.amountMinor > 0
        ? selected.reference
        : selected._id);
    // One business-scoped query loads only this correction chain.
    const root = await tx.get('movements', rootId),
      rows = [root];
    const related = new Map(
      (await tx.find('movements', { rootMovementId: rootId })).map((r) => [r._id, r]),
    );
    let current = root;
    for (let n = 0; current.adjustmentMovementId && n < 200; n++) {
      current = related.get(current.adjustmentMovementId);
      ensure(current, 409, 'HISTORY_LINK', 'El historial está incompleto; recarga los datos');
      rows.push(current);
    }
    return { rootId, rows };
  }
  return {
    history(ctx, movementId) {
      id.parse(movementId);
      return commands.read(
        ctx,
        async (tx) => {
          const selected = await tx.get('movements', movementId);
          const result = await chain(tx, selected);
          return { ...result, selectedId: movementId };
        },
        { module: 'finance' },
      );
    },
    correct(ctx, movementId, input, cancel = false) {
      id.parse(movementId);
      const d = correction.parse(input);
      ensure(
        cancel ? !d.replacement : !!d.replacement,
        422,
        'REPLACEMENT_REQUIRED',
        'Envía los datos del ajuste o cancela sin reemplazo',
      );
      ensure(
        !d.replacement || d.replacement.occurredOn <= new Date().toISOString().slice(0, 10),
        422,
        'FUTURE_MOVEMENT',
        'No se permiten movimientos futuros',
      );
      return commands.run(
        ctx,
        cancel ? 'finance.movement.cancelled' : 'finance.movement.corrected',
        { movementId, ...d },
        async (tx) => {
          const selected = await tx.get('movements', movementId);
          ensure(
            selected.revision === d.revision,
            409,
            'REVISION_CONFLICT',
            'El movimiento cambió; recarga su versión',
          );
          ensure(
            active(selected),
            409,
            'MOVEMENT_SUPERSEDED',
            'Este movimiento ya fue ajustado o cancelado; abre su historial',
          );
          ensure(
            ['income', 'expense', 'transfer'].includes(selected.kind) &&
              (selected.kind === 'transfer' || !selected.reference),
            422,
            'SOURCE_MOVEMENT',
            'Este movimiento pertenece a una venta, crédito o abono. Debe corregirse desde su operación de origen',
          );
          const originals = await group(tx, selected),
            root = originals[0];
          const rootId = root.rootMovementId || root._id;
          ensure(
            (await chain(tx, root)).rows.length < 200,
            422,
            'HISTORY_LIMIT',
            'Se alcanzó el límite de ajustes de este movimiento',
          );
          const p = d.replacement;
          ensure(
            !p ||
              (root.kind === 'transfer'
                ? p.kind === 'transfer' && p.toWalletId && p.toWalletId !== p.walletId
                : p.kind !== 'transfer' && !p.toWalletId),
            422,
            'MOVEMENT_KIND',
            'Una transferencia requiere dos carteras distintas y conserva su tipo',
          );
          const changes = originals.map((r) => ({
            walletId: r.walletId,
            amountMinor: -r.amountMinor,
            operatingMinor: -(r.operatingMinor || 0),
            kind: r.kind,
            category: r.category,
            description: 'Reversión: ' + (r.description || r.category),
            occurredOn: new Date().toISOString().slice(0, 10),
            reference: r._id,
            entryRole: 'reversal',
            reversedAmountMinor: r.amountMinor,
            rootMovementId: rootId,
            previousMovementId: r._id,
          }));
          const adjustmentStart = changes.length;
          if (p) {
            const signed = p.kind === 'income' ? p.amountMinor : -p.amountMinor;
            changes.push({
              walletId: p.walletId,
              amountMinor: signed,
              operatingMinor: p.kind === 'transfer' ? 0 : signed,
              kind: p.kind,
              category: p.kind === 'transfer' ? 'transfer' : p.category,
              description: p.description,
              occurredOn: p.occurredOn,
              entryRole: 'adjustment',
              rootMovementId: rootId,
              previousMovementId: root._id,
            });
            if (p.kind === 'transfer')
              changes.push({
                ...changes.at(-1),
                walletId: p.toWalletId,
                amountMinor: p.amountMinor,
              });
          }
          // Validate final balances, not a temporary reversal that may go below zero.
          const deltas = new Map();
          for (const c of changes)
            deltas.set(c.walletId, safeInteger((deltas.get(c.walletId) || 0) + c.amountMinor));
          const wallets = new Map();
          for (const [walletId, delta] of deltas) {
            const wallet = await tx.get('wallets', walletId),
              balanceMinor = safeInteger(wallet.balanceMinor + delta);
            ensure(
              !p || ![p.walletId, p.toWalletId].includes(walletId) || !wallet.archived,
              422,
              'WALLET_ARCHIVED',
              'La cartera de destino está archivada',
            );
            ensure(
              wallet.allowNegative || balanceMinor >= 0,
              422,
              'INSUFFICIENT_FUNDS',
              'El ajuste dejaría una cartera sin saldo suficiente',
            );
            wallets.set(walletId, { ...wallet, balanceMinor });
          }
          const inserted = [];
          for (let i = 0; i < changes.length; i++) {
            const c = changes[i];
            if (p?.kind === 'transfer' && i === adjustmentStart + 1)
              c.reference = inserted[adjustmentStart]._id;
            inserted.push(
              await tx.insert('movements', {
                ...c,
                balanceAfterMinor: wallets.get(c.walletId).balanceMinor,
                changeReason: d.reason,
                adjustmentReason: d.reason,
                createdBy: ctx.userId,
                changedBy: ctx.userId,
              }),
            );
          }
          for (const wallet of wallets.values())
            await tx.update('wallets', wallet._id, wallet.revision, {
              balanceMinor: wallet.balanceMinor,
            });
          for (let i = 0; i < originals.length; i++) {
            const original = originals[i];
            await tx.update('movements', original._id, original.revision, {
              correctionStatus: cancel ? 'cancelled' : 'edited',
              changeReason: d.reason,
              changedBy: ctx.userId,
              changedAt: new Date(),
              reversalMovementId: inserted[i]._id,
              ...(p ? { adjustmentMovementId: inserted[adjustmentStart + i]._id } : {}),
            });
          }
          return {
            original: await tx.get('movements', selected._id),
            reversals: inserted.slice(0, adjustmentStart),
            adjustments: inserted.slice(adjustmentStart),
          };
        },
      );
    },
  };
}
