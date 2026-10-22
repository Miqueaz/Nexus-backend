import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestRuntime } from '../../src/workers/request-runtime.js';

const deferred = () => Promise.withResolvers();

test('comparte conexión entre solicitudes concurrentes y cierra solo después de la última', async () => {
  let opened = 0,
    closed = 0;
  const runtime = new RequestRuntime({
    open: async () => ({ id: ++opened }),
    close: async () => {
      closed++;
    },
  });
  const started = deferred(),
    finish = deferred();
  const first = runtime.run(async () => {
    assert.equal((await runtime.get()).id, 1);
    started.resolve();
    await finish.promise;
    assert.equal(closed, 0);
  });
  await started.promise;
  await runtime.run(async () => assert.equal((await runtime.get()).id, 1));
  assert.equal(closed, 0);
  finish.resolve();
  await first;
  assert.equal(closed, 1);
  await runtime.run(async () => assert.equal((await runtime.get()).id, 2));
  assert.equal(closed, 2);
});

test('una solicitud que llega durante el cierre espera y usa una conexión nueva', async () => {
  const closing = deferred(),
    release = deferred();
  let opened = 0;
  const runtime = new RequestRuntime({
    open: async () => ++opened,
    close: async (id) => {
      if (id === 1) {
        closing.resolve();
        await release.promise;
      }
    },
  });
  const first = runtime.run(() => runtime.get());
  await closing.promise;
  const second = runtime.run(() => runtime.get());
  await Promise.resolve();
  assert.equal(opened, 1);
  release.resolve();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
});

test('errores y rutas sin base no dejan recursos abiertos ni anulan respuestas confirmadas', async () => {
  let attempts = 0,
    closed = 0;
  const errors = [];
  const runtime = new RequestRuntime({
    open: async () => {
      if (++attempts === 1) throw new Error('connection failed');
      return {};
    },
    close: async () => {
      closed++;
      throw new Error('close failed');
    },
    onCloseError: (error) => errors.push(error.message),
  });
  await runtime.run(async () => 'health/live');
  assert.equal(attempts, 0);
  await assert.rejects(
    runtime.run(() => runtime.get()),
    /connection failed/,
  );
  assert.equal(closed, 0);
  await assert.rejects(
    runtime.run(async () => {
      await runtime.get();
      throw new Error('request failed');
    }),
    /request failed/,
  );
  assert.equal(
    await runtime.run(async () => {
      await runtime.get();
      return 'committed';
    }),
    'committed',
  );
  assert.equal(closed, 2);
  assert.deepEqual(errors, ['close failed', 'close failed']);
  assert.equal(runtime.pending, null);
  assert.equal(runtime.closing, null);
  assert.equal(runtime.active, 0);
});
