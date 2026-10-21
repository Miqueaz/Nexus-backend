import pino from 'pino';
export function createLogger(level = 'info') {
  return pino({
    level,
    base: { service: 'nexo-api' },
    redact: {
      paths: [
        'credential',
        'idToken',
        'nonce',
        'nonceHash',
        '*.credential',
        '*.idToken',
        '*.nonce',
        'password',
        'passwordHash',
        'accessToken',
        'token',
        'authorization',
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  });
}
