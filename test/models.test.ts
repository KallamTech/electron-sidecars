import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureModel, isModelPresent } from '../src/ollama.js';
import { ensurePinnedModel, type PinnedModel } from '../src/whisper.js';

test('ensurePinnedModel accepts a verified file and refuses non-https downloads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sidecars-model-'));
  const body = 'model-bytes';
  const model: PinnedModel = {
    file: 'm.bin',
    url: 'http://example.invalid/m.bin',
    size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
  await writeFile(path.join(dir, 'm.bin'), body);
  const phases: string[] = [];
  assert.equal(await ensurePinnedModel(model, dir, (p) => phases.push(p)), path.join(dir, 'm.bin'));
  assert.ok(existsSync(path.join(dir, 'm.bin.verified.json')));
  assert.ok(phases.includes('Verifying model'));

  // Marker hit: no re-hash.
  phases.length = 0;
  await ensurePinnedModel(model, dir, (p) => phases.push(p));
  assert.deepEqual(phases, ['model ready']);

  // Same size, different bytes: re-hash fails, file is discarded, download refused.
  await writeFile(path.join(dir, 'm.bin'), 'MODEL-BYTES');
  await assert.rejects(ensurePinnedModel(model, dir), /non-https/);
  assert.equal(existsSync(path.join(dir, 'm.bin')), false);
});

test('ensureModel pulls only when missing, reporting progress', async () => {
  const pulled: string[] = [];
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'present:latest' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      pulled.push(JSON.parse(body).name);
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      res.write(JSON.stringify({ status: 'pulling abc', total: 100, completed: 50 }) + '\n');
      res.end(JSON.stringify({ status: 'success' }) + '\n');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    assert.equal(await isModelPresent(url, 'present'), true);
    await ensureModel(url, 'present');
    assert.deepEqual(pulled, []);

    const fractions: (number | undefined)[] = [];
    await ensureModel(url, 'missing', (_p, f) => fractions.push(f));
    assert.deepEqual(pulled, ['missing']);
    assert.ok(fractions.includes(0.5));
    assert.equal(fractions.at(-1), 1);
  } finally {
    srv.close();
  }
});
