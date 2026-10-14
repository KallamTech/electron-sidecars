import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { findFreePort, isPortOpen, waitForPort } from '../src/net.js';

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => s.end());
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

test('findFreePort returns a bindable port', async () => {
  const port = await findFreePort();
  assert.ok(port > 0 && port < 65536);
  const srv = await listen(port);
  srv.close();
});

test('isPortOpen reflects a listener', async () => {
  const port = await findFreePort();
  assert.equal(await isPortOpen(port, 500), false);
  const srv = await listen(port);
  assert.equal(await isPortOpen(port, 500), true);
  srv.close();
});

test('waitForPort resolves once something binds', async () => {
  const port = await findFreePort();
  let srv: net.Server | undefined;
  setTimeout(async () => (srv = await listen(port)), 300);
  await waitForPort(port, 5_000, { pollIntervalMs: 100 });
  srv?.close();
});

test('waitForPort names the service on timeout', async () => {
  const port = await findFreePort();
  await assert.rejects(waitForPort(port, 300, { pollIntervalMs: 100, label: 'thing' }), /^Error: thing did not bind/);
});
