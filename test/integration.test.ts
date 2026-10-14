// Real binaries, gated on env (see README "Running the integration test").
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  findFreePort,
  isPortOpen,
  redisAccepts,
  startPostgres,
  startPostgrest,
  startRedis,
  type PostgresOptions,
} from '../src/index.js';

const { SIDECARS_PG_BINDIR, SIDECARS_POSTGREST_BIN, SIDECARS_REDIS_BIN, SIDECARS_PG_LIBDIR } = process.env;
const db = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'minimal-app', 'db');
const quiet = () => {};
const secret = () => randomBytes(24).toString('hex');

function getViaSocket(socketPath: string, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ socketPath, path: p }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

async function canConnect(connectionString: string): Promise<string | null> {
  const c = new pg.Client({ connectionString });
  try {
    await c.connect();
    await c.end();
    return null;
  } catch (e) {
    // node-pg refuses client-side when the server asks a passwordless client for SCRAM.
    if (/SASL/.test(String(e))) return '28P01';
    return (e as { code?: string }).code ?? String(e);
  }
}

const schema = {
  prelude: [path.join(db, 'prelude.sql')],
  migrationsDir: path.join(db, 'migrations'),
  postlude: [path.join(db, 'postlude.sql')],
  searchPath: 'public, extensions',
};

test('postgres (scram) + pgvector + postgrest (unix socket) + redis (password)', { skip: !SIDECARS_PG_BINDIR && 'set SIDECARS_PG_BINDIR' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidecars-it-'));
  const password = secret();
  const pgOpts: PostgresOptions = {
    binDir: SIDECARS_PG_BINDIR!,
    dataDir: path.join(root, 'pgdata'),
    database: 'app',
    port: await findFreePort(),
    socketDir: null,
    password,
    schema,
    log: quiet,
  };
  let pgEndpoint = await startPostgres(pgOpts);
  const stops: (() => unknown)[] = [() => pgEndpoint.stop()];
  try {
    assert.equal(pgEndpoint.initialized, true);
    assert.equal(pgEndpoint.schemaChanged, true);
    assert.match(await readFile(path.join(pgOpts.dataDir, 'pg_hba.conf'), 'utf8'), /scram-sha-256/);
    assert.equal(await canConnect(`postgresql://postgres@127.0.0.1:${pgOpts.port}/app`), '28P01');
    assert.equal(await canConnect(`postgresql://postgres:wrong@127.0.0.1:${pgOpts.port}/app`), '28P01');
    assert.equal(await canConnect(pgEndpoint.url()), null);

    if (SIDECARS_POSTGREST_BIN) {
      const authPw = secret();
      await pgEndpoint.setPassword('authenticator', authPw);
      const socketPath = path.join(root, 'run', 'postgrest.sock');
      const rest = await startPostgrest({
        bin: SIDECARS_POSTGREST_BIN,
        dbUri: pgEndpoint.url('authenticator', authPw),
        anonRole: 'web_anon',
        allowAnonymous: true,
        unixSocket: socketPath,
        extraSearchPath: ['public', 'extensions'],
        libDir: SIDECARS_PG_LIBDIR,
        log: quiet,
      });
      stops.push(rest.stop);
      assert.equal(rest.port, null);
      assert.equal((await stat(path.dirname(socketPath))).mode & 0o777, 0o700);
      const res = await getViaSocket(socketPath, '/notes?select=body');
      assert.deepEqual(JSON.parse(res.body), [{ body: 'hello from embedded Postgres' }]);
      assert.equal(await isPortOpen(3001), false, 'no TCP listener on the default port');
    }

    if (SIDECARS_REDIS_BIN) {
      const redisPw = secret();
      const redisPort = await findFreePort();
      const redis = await startRedis({ bin: SIDECARS_REDIS_BIN, dataDir: path.join(root, 'redis'), port: redisPort, password: redisPw, log: quiet });
      stops.push(redis.stop);
      assert.equal(await redisAccepts(redisPort, redisPw), true);
      assert.equal(await redisAccepts(redisPort), false, 'unauthenticated PING is refused');
      assert.equal(await redisAccepts(redisPort, 'wrong'), false);
      // Next launch, new password: the leftover instance is replaced, not adopted.
      const nextPw = secret();
      const redis2 = await startRedis({ bin: SIDECARS_REDIS_BIN, dataDir: path.join(root, 'redis'), port: redisPort, password: nextPw, log: quiet });
      stops.push(redis2.stop);
      assert.equal(await redisAccepts(redisPort, nextPw), true);
      assert.equal(await redisAccepts(redisPort, redisPw), false);
    }

    // Second boot: no initdb, no schema re-apply.
    await pgEndpoint.stop();
    pgEndpoint = await startPostgres(pgOpts);
    assert.equal(pgEndpoint.initialized, false);
    assert.equal(pgEndpoint.schemaChanged, false);

    // Lost secret (e.g. reset keychain): the new password is set in single-user mode.
    await pgEndpoint.stop();
    const newPw = secret();
    pgEndpoint = await startPostgres({ ...pgOpts, password: newPw });
    assert.equal(await canConnect(pgEndpoint.url()), null);
    assert.equal(await canConnect(`postgresql://postgres:${password}@127.0.0.1:${pgOpts.port}/app`), '28P01');
  } finally {
    for (const stop of stops.reverse()) await stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing trust-auth cluster is converted to scram', { skip: !SIDECARS_PG_BINDIR && 'set SIDECARS_PG_BINDIR' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidecars-it-'));
  const base: PostgresOptions = {
    binDir: SIDECARS_PG_BINDIR!,
    dataDir: path.join(root, 'pgdata'),
    database: 'app',
    port: await findFreePort(),
    socketDir: null,
    log: quiet,
  };
  try {
    const old = await startPostgres({ ...base, trust: true });
    assert.equal(await canConnect(`postgresql://postgres@127.0.0.1:${base.port}/app`), null);
    await old.stop();

    const password = secret();
    const next = await startPostgres({ ...base, password });
    try {
      assert.equal(next.initialized, false);
      assert.doesNotMatch(await readFile(path.join(base.dataDir, 'pg_hba.conf'), 'utf8'), /^[^#\n]*\btrust\s*$/m);
      assert.equal(await canConnect(`postgresql://postgres@127.0.0.1:${base.port}/app`), '28P01');
      assert.equal(await canConnect(next.url()), null);
    } finally {
      await next.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startPostgres refuses to run without choosing an auth mode', async () => {
  await assert.rejects(
    startPostgres({ binDir: '/nonexistent', dataDir: '/nonexistent', database: 'app' }),
    /password.*trust/,
  );
});
