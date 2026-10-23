import { AppError } from '../../core/errors.js';
export const collections = [
  'organizations',
  'organizationMembers',
  'organizationRoles',
  'documents',
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
  'creditStatements',
  'debts',
  'debtPayments',
];
export async function connectDatabase(
  config,
  {
    initializeIndexes = true,
    migrateIfNeeded = false,
    poolSize = 20,
    monitoringMode = 'auto',
    appName = 'nexo-backend',
  } = {},
) {
  // El driver genera valores aleatorios al importarse: cargarlo dentro de una solicitud Workers.
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(config.mongoUri, {
    appName,
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: poolSize,
    maxConnecting: 1,
    serverMonitoringMode: monitoringMode,
    minPoolSize: 0,
    maxIdleTimeMS: 20000,
  });
  const db = client.db(config.mongoDb);
  try {
    await client.connect();
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid')
      throw new Error('MongoDB debe ser un replica set o clúster sharded para transacciones');
    if (initializeIndexes) await ensureIndexes(db);
    else {
      try {
        await assertDatabasePrepared(db);
      } catch (error) {
        if (!migrateIfNeeded || error.code !== 'DATABASE_NOT_PREPARED') throw error;
        // Preparación idempotente de una base nueva; nunca elimina datos ni índices.
        await ensureIndexes(db);
        await assertDatabasePrepared(db);
      }
    }
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
    'authChallenges',
    'authRateLimits',
  ]) {
    if (!(await db.listCollections({ name }, { nameOnly: true }).hasNext()))
      try {
        await db.createCollection(name);
      } catch (error) {
        if (error.code !== 48) throw error;
      }
  }
  for (const name of collections)
    await db.collection(name).createIndex({ businessId: 1, createdAt: -1, _id: -1 });
  await db.collection('documents').createIndex({ businessId: 1, updatedAt: -1, _id: -1 });
  await db
    .collection('creditStatements')
    .createIndex({ businessId: 1, creditLineId: 1, cutoffOn: 1 }, { unique: true });
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db
    .collection('users')
    .createIndex(
      { googleSub: 1 },
      { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } },
    );
  await db.collection('authChallenges').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('authRateLimits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('memberships').createIndex({ businessId: 1, userId: 1 }, { unique: true });
  await db.collection('memberships').createIndex({ userId: 1 });
  await db
    .collection('organizationMembers')
    .createIndex({ businessId: 1, userId: 1 }, { unique: true });
  await db.collection('organizationMembers').createIndex({ userId: 1, state: 1 });
  await db.collection('businesses').createIndex({ organizationId: 1 });
  await db.collection('memberships').createIndex({ organizationId: 1, customRoleId: 1, role: 1 });
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

/** Verifica las restricciones de consistencia sin crear índices desde Workers. */
export async function assertDatabasePrepared(db) {
  const required = [
    ['organizationMembers', { businessId: 1, userId: 1 }],
    ['creditStatements', { businessId: 1, creditLineId: 1, cutoffOn: 1 }],
    ['users', { email: 1 }],
    ['users', { googleSub: 1 }],
    ['memberships', { businessId: 1, userId: 1 }],
    ['idempotency', { businessId: 1, key: 1 }],
    ['items', { businessId: 1, sku: 1 }],
    ['sales', { businessId: 1, quoteId: 1 }],
  ];
  try {
    const authLimitIndexes = await db.collection('authRateLimits').listIndexes().toArray();
    if (!authLimitIndexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0))
      throw new Error('Missing auth rate limit TTL index');
    const docIndexes = await db.collection('documents').listIndexes().toArray();
    if (
      !docIndexes.some(
        (index) =>
          JSON.stringify(index.key) === JSON.stringify({ businessId: 1, updatedAt: -1, _id: -1 }),
      )
    )
      throw new Error('Missing Docs index');
    for (const [name, key] of required) {
      const indexes = await db.collection(name).listIndexes().toArray();
      const index = indexes.find((i) => i.unique && JSON.stringify(i.key) === JSON.stringify(key));
      if (!index) throw new Error('Missing unique index');
      const partialField = key.googleSub
        ? 'googleSub'
        : name === 'items'
          ? 'sku'
          : name === 'sales'
            ? 'quoteId'
            : null;
      if (partialField && index.partialFilterExpression?.[partialField]?.$type !== 'string')
        throw new Error('Incorrect partial index');
    }
  } catch {
    throw new AppError(
      503,
      'DATABASE_NOT_PREPARED',
      'Ejecuta npm run db:migrate antes de iniciar Workers',
    );
  }
}
