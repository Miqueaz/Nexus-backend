import { MongoClient } from 'mongodb';
export const collections = [
  'businesses',
  'memberships',
  'wallets',
  'movements',
  'inventoryLists',
  'items',
  'stockMovements',
  'contactLists',
  'contacts',
  'sales',
  'quotes',
  'projects',
  'events',
  'projections',
  'creditLines',
  'debts',
  'debtPayments',
];
export async function connectDatabase(config) {
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 20,
  });
  await client.connect();
  const db = client.db(config.mongoDb);
  try {
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid')
      throw new Error('MongoDB debe ser un replica set o clúster sharded para transacciones');
    await ensureIndexes(db);
    return { client, db };
  } catch (error) {
    await client.close();
    throw error;
  }
}
export async function ensureIndexes(db) {
  for (const name of [
    ...collections,
    'audit',
    'idempotency',
    'users',
    'sessions',
    'securityEvents',
  ]) {
    if (!(await db.listCollections({ name }, { nameOnly: true }).hasNext()))
      await db.createCollection(name);
  }
  for (const name of collections)
    await db.collection(name).createIndex({ businessId: 1, createdAt: -1, _id: -1 });
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('memberships').createIndex({ businessId: 1, userId: 1 }, { unique: true });
  await db.collection('memberships').createIndex({ userId: 1 });
  await db.collection('idempotency').createIndex({ businessId: 1, key: 1 }, { unique: true });
  await db.collection('audit').createIndex({ businessId: 1, recordedAt: 1, _id: 1 });
  await db
    .collection('audit')
    .createIndex({ businessId: 1, collection: 1, entityId: 1, recordedAt: -1 });
  await db
    .collection('items')
    .createIndex(
      { businessId: 1, sku: 1 },
      { unique: true, partialFilterExpression: { sku: { $type: 'string' } } },
    );
  await db
    .collection('sales')
    .createIndex(
      { businessId: 1, quoteId: 1 },
      { unique: true, partialFilterExpression: { quoteId: { $type: 'string' } } },
    );
}
