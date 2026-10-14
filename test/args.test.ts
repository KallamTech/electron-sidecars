import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutEnv } from '../src/env.js';
import { friendlyPullStatus, normalizeModelId } from '../src/ollama.js';
import { initdbArgs, pgCtlStartArgs, serverOptions } from '../src/postgres.js';
import { postgrestEnv } from '../src/postgrest.js';
import { detectFlavor, redisServerArgs } from '../src/redis.js';
import { whisperArgs } from '../src/whisper.js';

test('initdb uses trust auth and the given superuser', () => {
  assert.deepEqual(initdbArgs('/d', 'admin'), ['-D', '/d', '-U', 'admin', '--no-locale', '-E', 'UTF8', '-A', 'trust']);
});

test('serverOptions binds loopback, sets socket dir and settings', () => {
  assert.equal(
    serverOptions(5555, '/tmp', { wal_level: 'logical' }, 'darwin'),
    '-p 5555 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp -c wal_level=logical',
  );
  assert.match(serverOptions(5555, null, {}, 'linux'), /unix_socket_directories=''$/);
  assert.doesNotMatch(serverOptions(5555, '/tmp', {}, 'win32'), /unix_socket/);
  assert.throws(() => serverOptions(1, null, { 'bad key': 'x' }), /unsafe/);
  assert.throws(() => serverOptions(1, null, { k: "a' -c x=y" }), /unsafe/);
});

test('pg_ctl start always redirects to a logfile', () => {
  const args = pgCtlStartArgs('/d', '-p 1');
  assert.equal(args[args.indexOf('-l') + 1], '/d/startup.log');
  assert.equal(args.at(-1), 'start');
});

test('redis args per flavor', () => {
  assert.deepEqual(redisServerArgs('redis', 6399, '/r'), [
    '--port', '6399', '--bind', '127.0.0.1', '--dir', '/r', '--appendonly', 'yes', '--save', '',
  ]);
  assert.ok(redisServerArgs('garnet', 6399, '/r').includes('--aof'));
  assert.equal(detectFlavor('/x/garnet/GarnetServer.exe'), 'garnet');
  assert.equal(detectFlavor('/x/redis-server'), 'redis');
});

test('postgrest env', () => {
  const env = postgrestEnv(
    { bin: 'x', dbUri: 'postgresql://authenticator@127.0.0.1:1/app', anonRole: 'web_anon', extraSearchPath: ['public', 'extensions'] },
    3001,
    {},
  );
  assert.equal(env.PGRST_DB_ANON_ROLE, 'web_anon');
  assert.equal(env.PGRST_DB_SCHEMAS, 'public');
  assert.equal(env.PGRST_DB_EXTRA_SEARCH_PATH, 'public, extensions');
  assert.equal(env.PGRST_SERVER_HOST, '127.0.0.1');
  assert.equal(env.PGRST_SERVER_PORT, '3001');
  assert.equal(env.PGRST_JWT_SECRET, undefined);
  assert.equal(env.DYLD_FALLBACK_LIBRARY_PATH, undefined);
  const withJwt = postgrestEnv({ bin: 'x', dbUri: 'u', anonRole: 'a', jwtSecret: 's', libDir: '/lib' }, 1, {});
  assert.equal(withJwt.PGRST_JWT_SECRET, 's');
  assert.equal(withJwt.DYLD_FALLBACK_LIBRARY_PATH, '/lib');
});

test('whisper args put every route behind the secret prefix', () => {
  const args = whisperArgs({ model: '/m.bin' }, 9000, 'abc', '/pub');
  assert.equal(args[args.indexOf('--request-path') + 1], '/abc');
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(args[args.indexOf('--language') + 1], 'auto');
});

test('model ids compare tag-normalized', () => {
  assert.equal(normalizeModelId('bge-m3'), 'bge-m3:latest');
  assert.equal(normalizeModelId('gemma:2b'), 'gemma:2b');
});

test('pull status is human-readable', () => {
  assert.equal(friendlyPullStatus('pulling 3f2a…', 'model'), 'Downloading model');
  assert.equal(friendlyPullStatus('verifying sha256 digest', 'model'), 'Verifying model');
  assert.equal(friendlyPullStatus('pulling manifest', 'model'), 'Preparing model');
  assert.equal(friendlyPullStatus('success', 'model'), 'Finishing model');
});

test('withoutEnv drops keys and prefixes', () => {
  const out = withoutEnv({ A: '1', SECRET: '2', GCP_X: '3', KEEP: '4' }, { keys: ['SECRET'], prefixes: ['GCP_'] });
  assert.deepEqual(out, { A: '1', KEEP: '4' });
});
