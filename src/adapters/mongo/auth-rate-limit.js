import { createHash } from 'node:crypto';
const windowMs = 15 * 60 * 1000;
/** Límite global por IP y ventana; _id único garantiza un solo contador entre Workers. */
export function createMongoAuthLimiter(db, { now = Date.now } = {}) {
  const collection = db.collection('authRateLimits');
  return async (request) => {
    const time = now();
    const expiresAt = (Math.floor(time / windowMs) + 1) * windowMs;
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    const hash = createHash('sha256').update(ip).digest('hex');
    const _id = `${expiresAt}:${hash}`;
    const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(expiresAt) } };
    let row;
    try {
      row = await collection.findOneAndUpdate({ _id }, update, {
        upsert: true,
        returnDocument: 'after',
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      // Dos invocaciones pueden intentar crear la primera fila simultáneamente.
      row = await collection.findOneAndUpdate({ _id }, update, { returnDocument: 'after' });
    }
    if (!row) throw new Error('Auth limit counter unavailable');
    return { count: row.count, retryAfter: Math.max(1, Math.ceil((expiresAt - time) / 1000)) };
  };
}
