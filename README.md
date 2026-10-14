# electron-sidecars

Run a full **Postgres + pgvector / PostgREST / Redis / Ollama / whisper.cpp**
stack inside an Electron app — no Docker, nothing for the user to install.

Each service is a native binary you ship in the app bundle, started on
loopback by a small TypeScript function that handles the unglamorous parts:

- **Postgres**: `initdb` on first run, a psql-free migration runner
  (prelude → migrations → postlude, tracked and idempotent), schema
  re-apply only when the inputs change, and self-healing after a force-quit
  (orphaned postmaster / stale `postmaster.pid`).
- **PostgREST**: refuses to hand traffic to a non-PostgREST process on its
  port, restarts an adopted instance when the schema changed (its cache is
  startup-only), and waits for the schema cache — not just the port.
- **Redis**: loopback, append-only persistence; Microsoft Garnet on Windows.
- **Ollama**: reuses a running Ollama, kills a child that never became
  responsive, model pulls with plain-language progress.
- **whisper.cpp server**: every route behind a random per-session path
  (whisper-server sends `Access-Control-Allow-Origin: *`), supervised
  restarts with backoff, stale-process reaping, resumable sha256-pinned
  model download.

Extracted from the [Kallam](https://kallam.ai) desktop app, where it runs the
on-device mode. By Kallam.

## Install

```sh
npm install @kallamtech/electron-sidecars
```

Not on npm yet — until the first release, install from git (builds on install):

```sh
npm install github:KallamTech/electron-sidecars
```

Node ≥ 20. Electron is an optional peer dependency — the main entry point
doesn't import it, so the sidecars also work from plain Node.

## Use

```ts
import { startPostgres, startPostgrest, startRedis } from '@kallamtech/electron-sidecars';
import { dataPath, resourcePath, stopOnQuit } from '@kallamtech/electron-sidecars/electron';

const res = (...p: string[]) => resourcePath(__dirname, ...p); // Resources/ when packaged

const pg = await startPostgres({
  binDir: res('pg', 'bin'),
  dataDir: dataPath('pgdata'),
  database: 'app',
  settings: { wal_level: 'logical' },   // optional GUCs
  schema: {
    prelude: [res('db', 'prelude.sql')],  // roles, schemas, extensions — idempotent
    migrationsDir: res('db', 'migrations'),
    postlude: [res('db', 'postlude.sql')],
    searchPath: 'public, extensions',
  },
});
const rest = await startPostgrest({
  bin: res('bin', 'postgrest'),
  dbUri: pg.url('authenticator'),
  anonRole: 'web_anon',
  extraSearchPath: ['public', 'extensions'],
  schemaChanged: pg.schemaChanged,
});
const redis = await startRedis({ bin: res('bin', 'redis-server'), dataDir: dataPath('redis') });

stopOnQuit(async () => {
  rest.stop();
  redis.stop();
  await pg.stop(); // detached postmaster: await it
});
```

See [`examples/minimal-app`](examples/minimal-app) for a runnable app and the
prelude/migration layout.

### Ollama and whisper

```ts
import { startOllama, ensureModel, startWhisper, ensurePinnedModel,
  WHISPER_LARGE_V3_TURBO_Q5 } from '@kallamtech/electron-sidecars';

const ollama = await startOllama({ bin: res('bin', 'ollama'), modelsDir: dataPath('ollama-models') });
await ensureModel(ollama.url, 'nomic-embed-text', (phase, fraction) => ui.progress(phase, fraction));

const model = await ensurePinnedModel(WHISPER_LARGE_V3_TURBO_Q5, dataPath('whisper-models'));
const whisper = await startWhisper({ bin: res('bin', 'whisper-server'), model, workDir: dataPath('whisper') });
await whisper.ready;
// POST audio to `${whisper.url}/inference`
```

### Migrating from a hosted database

The prelude is where a bare Postgres is made to look like what your
migrations expect, without editing them. For Supabase-generated migrations
that means creating the roles they grant to (`anon`, `authenticated`,
`service_role`, `authenticator`, …), the schemas they assume (`auth`,
`storage`, `extensions`, …) and stubs for hosted-only functions. Extensions a
stock build doesn't have can be dropped from migrations with
`schema.stripExtensions: ['pg_cron', 'pg_net', ...]`.

Migrations are applied in-process as one multi-statement query per file, so
`CREATE INDEX CONCURRENTLY` is not supported in them.

## API

| Function | Returns |
|---|---|
| `startPostgres(opts)` | `{ port, dataDir, database, url(role?), schemaChanged, initialized, stop() }` |
| `startPostgrest(opts)` | `{ url, port, child, adoptedPid, stop() }` |
| `startRedis(opts)` | `{ host, port, url, child, adoptedPid, stop() }` |
| `startOllama(opts)` | `{ url, ownedByUs, child, stop() }` |
| `ensureModel(url, model, onProgress?, label?)` | pulls an Ollama model if missing |
| `startWhisper(opts)` | `{ url, ready, stop() }` |
| `ensurePinnedModel(model, dir, onProgress?, label?)` | path to a verified download |
| `applySchema`, `ensureDatabase`, `schemaFingerprint` | the migration runner, standalone |
| `stageBundle(src, dest, version)` | copy a read-only bundled dir somewhere writable, once per version |
| `isPortOpen`, `waitForPort`, `findFreePort`, `findListenerPid`, `withoutEnv` | helpers |
| `electron`: `resourcePath`, `dataPath`, `stopOnQuit` | Electron-only helpers |

Every option is documented on its TypeScript type. All services bind
`127.0.0.1` only. Every `start*` takes a `log` callback (default: console).

## Bundling the binaries

```sh
bash node_modules/@kallamtech/electron-sidecars/scripts/build-pg-bundle.sh pg
bash node_modules/@kallamtech/electron-sidecars/scripts/build-bin.sh bin postgrest redis ollama whisper
```

- `build-pg-bundle.sh` takes the relocatable Postgres 15 server binaries from
  the [`@embedded-postgres`](https://github.com/leinelissen/embedded-postgres)
  packages and adds pgvector, built from source against a PG15 dev install
  (`PG_CONFIG`; `brew install postgresql@15` on macOS). Windows needs a
  prebuilt `vector.dll` (`SIDECARS_PGVECTOR_DLL`, `SIDECARS_PGVECTOR_SQLDIR`).
- `build-bin.sh` fetches PostgREST and Ollama releases and builds Redis and
  whisper-server from pinned sources. On macOS it rewrites PostgREST's libpq
  install name to `@executable_path/../pg/lib`, so keep `bin/` and `pg/` as
  siblings in Resources.

Ship `pg/` and `bin/` with electron-builder `extraResources`. Signing and
notarizing them is your build's job.

## Platform support

| | status |
|---|---|
| macOS arm64 | **primary target** — what the Kallam on-device desktop build runs on; integration test passes |
| macOS x64 | should work, not tested |
| Linux x64 / arm64 | scripts have asset mappings; not tested end to end |
| Windows x64 | Postgres/PostgREST/Garnet/Ollama mappings exist; whisper not built; not tested end to end |

`findListenerPid` uses `lsof` and returns `null` where it's unavailable.

## Development

```sh
npm install
npm run typecheck && npm run lint && npm test
```

Running the integration test (real binaries, otherwise skipped):

```sh
SIDECARS_PG_BINDIR=pg/bin SIDECARS_PG_LIBDIR=pg/lib \
SIDECARS_POSTGREST_BIN=bin/postgrest SIDECARS_REDIS_BIN=bin/redis-server \
npm test
```

## License

Apache-2.0. Copyright 2026 Kallam. Bundled third-party binaries keep their
own licenses (PostgreSQL, pgvector, PostgREST, Redis, Garnet, Ollama,
whisper.cpp) — check them before you ship.
