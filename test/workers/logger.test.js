import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerLogger } from '../../src/adapters/workers/logger.js';
test('Logger Workers conserva contexto, respeta nivel y redacta secretos anidados', () => {
  const logs = [];
  const sink = { info: (l) => logs.push(JSON.parse(l)), error: (l) => logs.push(JSON.parse(l)) };
  const logger = createWorkerLogger('info', sink);
  logger.debug({ ignored: true }, 'debug');
  logger.info(
    {
      requestId: 'id',
      headers: { authorization: 'Bearer secret' },
      password: 'secret',
      nested: { mongoUri: 'secret', credential: 'secret', nonce: 'secret' },
    },
    'request',
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].requestId, 'id');
  assert.ok(!JSON.stringify(logs).includes('secret'));
  assert.equal(logs[0].headers.authorization, '[REDACTED]');
});
