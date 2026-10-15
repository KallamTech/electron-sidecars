import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { supervise } from '../src/supervise.js';

const quiet = () => {};
const node = (code: string) => spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('respawns a process that exits on its own', async () => {
  const spawned: ChildProcess[] = [];
  const s = supervise({
    label: 't',
    spawn: () => node(spawned.length < 2 ? 'process.exit(1)' : 'setInterval(() => {}, 1000)'),
    onSpawn: (c) => spawned.push(c),
    backoffMs: [20],
    log: quiet,
  });
  await sleep(1_000);
  assert.equal(spawned.length, 3);
  assert.equal(s.child, spawned[2]);
  assert.equal(s.child.exitCode, null);
  await s.stop();
});

test('stop() kills the current process and never respawns', async () => {
  let count = 0;
  const s = supervise({
    label: 't',
    spawn: () => node('setInterval(() => {}, 1000)'),
    onSpawn: () => count++,
    backoffMs: [10],
    log: quiet,
  });
  await sleep(200);
  await s.stop();
  assert.notEqual(s.child.signalCode ?? s.child.exitCode, null);
  await sleep(200);
  assert.equal(count, 1);
});

test('stop() during a backoff cancels the pending restart', async () => {
  let count = 0;
  const s = supervise({
    label: 't',
    spawn: () => node('process.exit(1)'),
    onSpawn: () => count++,
    backoffMs: [300],
    log: quiet,
  });
  await sleep(150);
  await s.stop();
  await sleep(400);
  assert.equal(count, 1);
});

test('gives up after maxRestarts consecutive crashes', async () => {
  let count = 0;
  const s = supervise({
    label: 't',
    spawn: () => node('process.exit(1)'),
    onSpawn: () => count++,
    backoffMs: [10],
    maxRestarts: 2,
    log: quiet,
  });
  await sleep(1_000);
  assert.equal(count, 3);
  await s.stop();
});
