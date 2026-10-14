// Real binaries, gated on env (see README "Running the integration test").
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findFreePort, startPostgres, startPostgrest, startRedis } from '../src/index.js';

const { SIDECARS_PG_BINDIR, SIDECARS_POSTGREST_BIN, SIDECARS_REDIS_BIN, SIDECARS_PG_LIBDIR } = process.env;
const db = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'minimal-app', 'db');
const quiet = () => {};

function redisPing(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('PING\r\n'));
    s.once('data', (d) => {
      s.destroy();
      resolve(d.toString().trim());
    });
    s.once('error', reject);
  });
}

test('postgres + pgvector + postgrest + redis', { skip: !SIDECARS_PG_BINDIR && 'set SIDECARS_PG_BINDIR' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidecars-it-'));
  const schema = {
    prelude: [path.join(db, 'prelude.sql')],
    migrationsDir: path.join(db, 'migrations'),
    postlude: [path.join(db, 'postlude.sql')],
    searchPath: 'public, extensions',
  };
  const pgOpts = {
    binDir: SIDECARS_PG_BINDIR!,
    dataDir: path.join(root, 'pgdata'),
    database: 'app',
    port: await findFreePort(),
    socketDir: null,
    schema,
    log: quiet,
  };
  const pg = await startPostgres(pgOpts);
  const stops: (() => unknown)[] = [() => pg.stop()];
  try {
    assert.equal(pg.initialized, true);
    assert.equal(pg.schemaChanged, true);

    if (SIDECARS_POSTGREST_BIN) {
      const rest = await startPostgrest({
        bin: SIDECARS_POSTGREST_BIN,
        dbUri: pg.url('authenticator'),
        anonRole: 'web_anon',
        extraSearchPath: ['public', 'extensions'],
        port: await findFreePort(),
        libDir: SIDECARS_PG_LIBDIR,
        log: quiet,
      });
      stops.push(rest.stop);
      const rows = (await (await fetch(`${rest.url}/notes?select=body`)).json()) as { body: string }[];
      assert.deepEqual(rows, [{ body: 'hello from embedded Postgres' }]);
    }

    if (SIDECARS_REDIS_BIN) {
      const redis = await startRedis({ bin: SIDECARS_REDIS_BIN, dataDir: path.join(root, 'redis'), port: await findFreePort(), log: quiet });
      stops.push(redis.stop);
      assert.equal(await redisPing(redis.port), '+PONG');
    }

    // Second boot on the same data dir: no initdb, no schema re-apply.
    await pg.stop();
    const again = await startPostgres(pgOpts);
    assert.equal(again.initialized, false);
    assert.equal(again.schemaChanged, false);
  } finally {
    for (const stop of stops.reverse()) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
