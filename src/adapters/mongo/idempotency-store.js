export function createIdempotencyStore(db) {
  return {
    get: (tx, key) =>
      db
        .collection('idempotency')
        .findOne({ businessId: tx.businessId, key }, { session: tx.session }),
    save: (tx, record) =>
      db
        .collection('idempotency')
        .insertOne({ ...record, businessId: tx.businessId }, { session: tx.session }),
  };
}
