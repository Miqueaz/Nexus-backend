/** Persistencia de identidad y eventos de seguridad, fuera del dominio. */
export function createIdentityStore({ db, client }, session) {
  const options = session ? { session } : {};
  return {
    session,
    findUserByEmail: (email) => db.collection('users').findOne({ email }, options),
    findUserById: (_id) => db.collection('users').findOne({ _id }, options),
    findUserByGoogleSub: (googleSub) => db.collection('users').findOne({ googleSub }, options),
    setGoogleIdentity: (_id, googleSub, googleEmail) =>
      db
        .collection('users')
        .updateOne(
          { _id },
          { $set: { googleSub, googleEmail, googleLinkedAt: new Date() } },
          options,
        ),
    insertGoogleChallenge: (record) => db.collection('authChallenges').insertOne(record, options),
    findGoogleChallenge: (_id, purpose, userId) =>
      db
        .collection('authChallenges')
        .findOne({ _id, purpose, userId, expiresAt: { $gt: new Date() } }, options),
    consumeGoogleChallenge: (_id, purpose, userId) =>
      db
        .collection('authChallenges')
        .findOneAndDelete({ _id, purpose, userId, expiresAt: { $gt: new Date() } }, options),
    insertUser: (user) => db.collection('users').insertOne(user, options),
    insertSession: (record) => db.collection('sessions').insertOne(record, options),
    insertSecurityEvent: (record) => db.collection('securityEvents').insertOne(record, options),
    findActiveSession: (id, userId) =>
      db
        .collection('sessions')
        .findOne(
          { _id: id, userId, expiresAt: { $gt: new Date() }, revokedAt: { $exists: false } },
          options,
        ),
    revokeSession: (id, userId) =>
      db
        .collection('sessions')
        .updateOne({ _id: id, userId }, { $set: { revokedAt: new Date() } }, options),
    async transaction(operation) {
      const session = client.startSession();
      try {
        return await session.withTransaction(
          () => operation(createIdentityStore({ db, client }, session)),
          { writeConcern: { w: 'majority' } },
        );
      } finally {
        await session.endSession();
      }
    },
  };
}
