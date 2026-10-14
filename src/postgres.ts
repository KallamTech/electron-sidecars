import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { consoleLogger, EXE, type Logger } from './log.js';
import { applySchema, ensureDatabase, schemaFingerprint, type SchemaOptions } from './migrate.js';
import { LOOPBACK, waitForPort } from './net.js';

const execFileAsync = promisify(execFile);

export interface PostgresOptions {
  /** Directory holding `postgres`, `initdb`, `pg_ctl`. */
  binDir: string;
  /** Cluster data directory; created and initdb'd on first run. */
  dataDir: string;
  /** App database, created if missing. */
  database: string;
  /** Default 54332 — away from 5432 and Supabase's 54322 so a dev stack doesn't collide. */
  port?: number;
  /** Cluster superuser created by initdb. Default `postgres`. */
  superuser?: string;
  /** Unix socket dir. Default `/tmp` (data dirs under userData are too deep
   *  for the 103-byte socket path limit). `null` disables unix sockets.
   *  Ignored on Windows. */
  socketDir?: string | null;
  /** Extra server GUCs, e.g. `{ wal_level: 'logical' }` for logical decoding. */
  settings?: Record<string, string>;
  /** Applied on first run and whenever its fingerprint changes. */
  schema?: SchemaOptions;
  log?: Logger;
}

export interface PostgresEndpoint {
  port: number;
  dataDir: string;
  database: string;
  /** DSN for `role` (default superuser) on the app database. */
  url: (role?: string) => string;
  /** This launch (re)applied the schema — dependents that cache it
   *  (PostgREST builds its schema cache at startup) must refresh. */
  schemaChanged: boolean;
  /** Whether this launch ran initdb. */
  initialized: boolean;
  stop: () => Promise<void>;
}

export function pgBin(binDir: string, name: string): string {
  return path.join(binDir, `${name}${EXE}`);
}

export function initdbArgs(dataDir: string, superuser: string): string[] {
  // trust auth: loopback-only, single-user.
  return ['-D', dataDir, '-U', superuser, '--no-locale', '-E', 'UTF8', '-A', 'trust'];
}

export function serverOptions(
  port: number,
  socketDir: string | null,
  settings: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): string {
  const parts = [`-p ${port}`, `-c listen_addresses=${LOOPBACK}`];
  // Windows Postgres has no unix sockets.
  if (platform !== 'win32') parts.push(`-c unix_socket_directories=${socketDir ?? "''"}`);
  for (const [k, v] of Object.entries(settings)) {
    if (!/^[a-z_.]+$/i.test(k) || /[\s'"\\]/.test(v)) throw new Error(`unsafe setting ${k}=${v}`);
    parts.push(`-c ${k}=${v}`);
  }
  return parts.join(' ');
}

export function pgCtlStartArgs(dataDir: string, options: string): string[] {
  // -l is required: without it the detached postmaster inherits pg_ctl's stdio
  // pipes and holds them open, so execFile never sees EOF and waits out its
  // whole timeout on every launch.
  return ['-D', dataDir, '-l', path.join(dataDir, 'startup.log'), '-o', options, '-w', '-t', '60', 'start'];
}

async function pgCtlStop(binDir: string, dataDir: string): Promise<void> {
  await execFileAsync(pgBin(binDir, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], {
    timeout: 90_000,
  });
}

// A force-quit app leaves its detached postmaster running, and the next launch
// fails with "another server might be running". Stop it if pg_ctl sees it,
// otherwise drop a stale postmaster.pid.
async function clearStale(binDir: string, dataDir: string, log: Logger): Promise<void> {
  let running = false;
  try {
    await execFileAsync(pgBin(binDir, 'pg_ctl'), ['status', '-D', dataDir]);
    running = true;
  } catch {
    running = false;
  }
  if (running) {
    log('info', 'postgres', `stopping orphaned server on ${dataDir}`);
    await pgCtlStop(binDir, dataDir);
    return;
  }
  const pidFile = path.join(dataDir, 'postmaster.pid');
  if (existsSync(pidFile)) {
    log('info', 'postgres', 'removing stale postmaster.pid');
    await rm(pidFile, { force: true });
  }
}

export async function startPostgres(opts: PostgresOptions): Promise<PostgresEndpoint> {
  const {
    binDir,
    dataDir,
    database,
    port = 54332,
    superuser = 'postgres',
    socketDir = '/tmp',
    settings = {},
    log = consoleLogger,
  } = opts;

  if (!existsSync(pgBin(binDir, 'postgres'))) {
    throw new Error(`Postgres not found at ${pgBin(binDir, 'postgres')}.`);
  }

  const url = (role = superuser, db = database) => `postgresql://${role}@${LOOPBACK}:${port}/${db}`;
  const stop = async () => {
    try {
      await pgCtlStop(binDir, dataDir);
    } catch (e) {
      log('error', 'postgres', `stop failed: ${e}`);
    }
  };

  const initialized = !existsSync(path.join(dataDir, 'PG_VERSION'));
  if (initialized) {
    log('info', 'postgres', `initializing cluster at ${dataDir}`);
    await mkdir(dataDir, { recursive: true });
    await execFileAsync(pgBin(binDir, 'initdb'), initdbArgs(dataDir, superuser), { timeout: 120_000 });
  } else {
    await clearStale(binDir, dataDir, log);
  }

  // pg_ctl -l appends; only the current boot matters.
  await rm(path.join(dataDir, 'startup.log'), { force: true });
  await execFileAsync(
    pgBin(binDir, 'pg_ctl'),
    pgCtlStartArgs(dataDir, serverOptions(port, socketDir, settings)),
    { timeout: 90_000 },
  );

  let schemaChanged = false;
  // pg_ctl started a detached postmaster: if anything below throws before the
  // caller holds the endpoint, nobody would stop it and the next launch would
  // trip over it. Stop it here so failures are self-clearing.
  try {
    await waitForPort(port, 30_000, { label: 'postgres' });
    const created = await ensureDatabase(url(superuser, 'postgres'), database);
    if (opts.schema) {
      const stampPath = path.join(dataDir, '.sidecars-schema-version');
      const version = await schemaFingerprint(opts.schema);
      const applied = existsSync(stampPath) ? (await readFile(stampPath, 'utf8')).trim() : '';
      if (created || applied !== version) {
        log('info', 'postgres', `applying schema (${version})`);
        const n = await applySchema(url(), opts.schema, (m) => log('info', 'migrate', m));
        log('info', 'migrate', `done: ${n} migrations applied`);
        await writeFile(stampPath, version);
        schemaChanged = true;
      }
    }
  } catch (e) {
    await stop();
    throw e;
  }

  log('info', 'postgres', `ready at ${url()}`);
  return { port, dataDir, database, url: (role) => url(role), schemaChanged, initialized, stop };
}
