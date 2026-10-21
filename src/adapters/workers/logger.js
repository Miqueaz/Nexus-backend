const levels = ['debug', 'info', 'warn', 'error', 'fatal'];
const secrets = new Set([
  'credential',
  'idtoken',
  'nonce',
  'noncehash',
  'password',
  'passwordhash',
  'accesstoken',
  'token',
  'authorization',
  'cookie',
  'jwtsecret',
  'mongouri',
  'mongo_uri',
  'jwt_secret',
]);
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        secrets.has(key.toLowerCase()) ? '[REDACTED]' : redact(entry),
      ]),
    );
  return value;
}
/** Puerto del logger: JSON a Workers Logs, sin archivos ni transports de Node. */
export function createWorkerLogger(level = 'info', sink = console) {
  return Object.fromEntries(
    levels.map((method, index) => [
      method,
      (data, message) => {
        if (level === 'silent' || index < levels.indexOf(level)) return;
        const record = {
          level: method,
          service: 'nexo-api',
          time: new Date().toISOString(),
          ...redact(data),
          message,
        };
        sink[method === 'fatal' ? 'error' : method](JSON.stringify(record));
      },
    ]),
  );
}
