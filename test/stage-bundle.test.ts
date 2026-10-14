import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stageBundle } from '../src/stage-bundle.js';

test('stages once per version and swaps whole trees', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidecars-stage-'));
  const src = path.join(root, 'src');
  const dest = path.join(root, 'data', 'bundle');
  await mkdir(src);
  await writeFile(path.join(src, 'a.txt'), 'v1');

  assert.deepEqual(await stageBundle(src, dest, '1.0.0'), { dir: dest, freshlyStaged: true });
  assert.equal(await readFile(path.join(dest, 'a.txt'), 'utf8'), 'v1');
  assert.equal((await stageBundle(src, dest, '1.0.0')).freshlyStaged, false);

  await writeFile(path.join(src, 'a.txt'), 'v2');
  await writeFile(path.join(dest, 'stale.txt'), 'x');
  assert.equal((await stageBundle(src, dest, '1.0.1')).freshlyStaged, true);
  assert.equal(await readFile(path.join(dest, 'a.txt'), 'utf8'), 'v2');
  assert.equal(existsSync(path.join(dest, 'stale.txt')), false);
});
