/** Successful structural checks only. Never retain clients, sessions or I/O promises. */
export function createPreparationCache({ now = Date.now, ttlMs = 300000, maxEntries = 16 } = {}) {
  const verified = new Map();
  return {
    async check(key, prepare, { force = false } = {}) {
      const expiresAt = verified.get(key);
      if (!force && expiresAt !== undefined && expiresAt > now()) return true;
      verified.delete(key);
      try {
        // Each concurrent request owns its preparation work and Mongo sockets.
        await prepare();
        verified.set(key, now() + ttlMs);
        while (verified.size > maxEntries) verified.delete(verified.keys().next().value);
        return false;
      } catch (error) {
        verified.delete(key);
        throw error;
      }
    },
  };
}
