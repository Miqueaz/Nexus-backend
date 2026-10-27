import { createHash } from 'node:crypto';
import { ensure } from '../../core/errors.js';
import { safeInteger } from '../../core/money.js';

// Sales and Contacts share wallet allocation through this transactional adapter.
export function createCommissionWallets({ moduleAccess }) {
  async function resolve(tx, { contactId, name, walletId, newContact = false }, manage = false) {
    const contact = contactId && !newContact ? await tx.get('contacts', contactId) : null;
    const chosen = walletId || (walletId !== null && contact?.commissionProfile?.walletId);
    if (manage) await moduleAccess.assertAction(tx, 'wallet.created');
    if (chosen) {
      const wallet = await tx.get('wallets', chosen);
      ensure(
        !wallet.archived,
        422,
        'WALLET_ARCHIVED',
        'La cartera del comisionista está archivada',
      );
      return wallet;
    }
    const identity = contactId
      ? 'contact:' + contactId
      : 'name:' + name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
    const hash = createHash('sha256')
      .update(tx.businessId + ':commission:' + identity)
      .digest('hex');
    const key = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    let wallet = (await tx.find('wallets', { _id: key }))[0];
    if (!wallet) {
      // Serialize auto-creation, including concurrent sales for a free-name commissioner.
      const business = await tx.get('businesses', tx.businessId);
      await tx.update('businesses', business._id, business.revision, {});
      wallet = await tx.insert(
        'wallets',
        {
          name: ('Comisionista · ' + (contact?.name || name)).slice(0, 200),
          kind: 'cash',
          allowNegative: false,
          balanceMinor: 0,
          archived: false,
          commissionIdentity: identity,
          ...(contactId ? { commissionContactId: contactId } : {}),
        },
        key,
      );
    }
    ensure(
      !wallet.archived,
      422,
      'WALLET_ARCHIVED',
      'Restaura o asigna otra cartera al comisionista',
    );
    return wallet;
  }
  async function prepare(tx, commissions) {
    const result = [];
    for (const c of commissions) {
      const wallet = await resolve(tx, c);
      result.push({ ...c, walletId: wallet._id, walletName: wallet.name });
    }
    return result;
  }
  async function settle(tx, sale, commissions) {
    const amounts = new Map();
    for (const c of commissions)
      amounts.set(c.walletId, safeInteger((amounts.get(c.walletId) || 0) + c.amountMinor));
    const previous = new Map(
      (sale.commissionAllocations || []).map((a) => [a.walletId, a.amountMinor]),
    );
    const changes = [];
    for (const walletId of new Set([...previous.keys(), ...amounts.keys()])) {
      const delta = safeInteger((amounts.get(walletId) || 0) - (previous.get(walletId) || 0));
      if (delta && walletId !== sale.walletId)
        changes.push({
          from: delta > 0 ? sale.walletId : walletId,
          to: delta > 0 ? walletId : sale.walletId,
          amount: Math.abs(delta),
        });
    }
    const deltas = new Map();
    for (const c of changes)
      for (const [id, n] of [
        [c.from, -c.amount],
        [c.to, c.amount],
      ])
        deltas.set(id, safeInteger((deltas.get(id) || 0) + n));
    const balances = new Map();
    for (const [id, delta] of deltas) {
      const wallet = await tx.get('wallets', id),
        balanceMinor = safeInteger(wallet.balanceMinor + delta);
      ensure(
        !wallet.archived,
        422,
        'WALLET_ARCHIVED',
        'Restaura la cartera antes de ajustar sus comisiones',
      );
      ensure(
        wallet.allowNegative || balanceMinor >= 0,
        422,
        'INSUFFICIENT_FUNDS',
        'Saldo insuficiente para distribuir o ajustar las comisiones',
      );
      balances.set(id, balanceMinor);
      await tx.update('wallets', id, wallet.revision, { balanceMinor });
    }
    for (const c of changes) {
      const data = {
        kind: 'transfer',
        category: 'commissions',
        operatingMinor: 0,
        description: 'Comisión de venta · ' + sale._id,
        saleId: sale._id,
        commissionSettlement: true,
        occurredOn: new Date().toISOString().slice(0, 10),
      };
      const from = await tx.insert('movements', {
        ...data,
        walletId: c.from,
        amountMinor: -c.amount,
        balanceAfterMinor: balances.get(c.from),
      });
      await tx.insert('movements', {
        ...data,
        walletId: c.to,
        amountMinor: c.amount,
        balanceAfterMinor: balances.get(c.to),
        reference: from._id,
      });
    }
    return [...amounts].map(([walletId, amountMinor]) => ({ walletId, amountMinor }));
  }
  return { resolve, prepare, settle };
}
