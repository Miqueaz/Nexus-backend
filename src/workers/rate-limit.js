const windowMs = 15 * 60 * 1000;
/** Contador persistente por IP para login/registro, compartido en el DO de identidad. */
export function createAuthLimiter(storage) {
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  );
  storage.sql.exec('CREATE INDEX IF NOT EXISTS auth_limits_expiry ON auth_limits(expires_at)');
  return async (request) => {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
    const hash = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
    const now = Date.now(),
      expiresAt = (Math.floor(now / windowMs) + 1) * windowMs;
    storage.sql.exec('DELETE FROM auth_limits WHERE expires_at <= ?', now);
    const key = `${expiresAt}:${hash}`;
    const { count } = storage.sql
      .exec(
        'INSERT INTO auth_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',
        key,
        expiresAt,
      )
      .one();
    return { count, retryAfter: Math.max(1, Math.ceil((expiresAt - now) / 1000)) };
  };
}
