// Boots Postgres+pgvector, PostgREST and Redis, then shows their status.
// Binaries: `npm run bin` (→ ./pg, ./bin). Packaged: ship pg/, bin/, db/ as extraResources.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { startPostgres, startPostgrest, startRedis } from '@kallamtech/electron-sidecars';
import { dataPath, resourcePath, stopOnQuit } from '@kallamtech/electron-sidecars/electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const res = (...p) => resourcePath(here, ...p);

let pg, rest, redis;
stopOnQuit(async () => {
  rest?.stop();
  redis?.stop();
  await pg?.stop();
});

function page(body) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>sidecars</title>
     <body style="font:14px system-ui;margin:2rem;max-width:44rem">${body}</body>`,
  )}`;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 760, height: 520 });
  await win.loadURL(page('<p>Starting…</p>'));
  try {
    pg = await startPostgres({
      binDir: res('pg', 'bin'),
      dataDir: dataPath('pgdata'),
      database: 'app',
      schema: {
        prelude: [res('db', 'prelude.sql')],
        migrationsDir: res('db', 'migrations'),
        postlude: [res('db', 'postlude.sql')],
        searchPath: 'public, extensions',
      },
    });
    [rest, redis] = await Promise.all([
      startPostgrest({
        bin: res('bin', 'postgrest'),
        dbUri: pg.url('authenticator'),
        anonRole: 'web_anon',
        extraSearchPath: ['public', 'extensions'],
        schemaChanged: pg.schemaChanged,
      }),
      startRedis({ bin: res('bin', 'redis-server'), dataDir: dataPath('redis') }),
    ]);
    const notes = await (await fetch(`${rest.url}/notes?select=id,body,embedding`)).json();
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    await win.loadURL(
      page(`<h1>All sidecars up</h1>
        <ul>
          <li>Postgres: <code>${esc(pg.url())}</code>${pg.initialized ? ' (new cluster)' : ''}</li>
          <li>PostgREST: <code>${esc(rest.url)}</code></li>
          <li>Redis: <code>${esc(redis.url)}</code></li>
        </ul>
        <h2>GET /notes</h2><pre>${esc(JSON.stringify(notes, null, 2))}</pre>`),
    );
  } catch (e) {
    await win.loadURL(page(`<h1>Startup failed</h1><pre>${String(e?.stack ?? e).replace(/</g, '&lt;')}</pre>`));
  }
});

app.on('window-all-closed', () => app.quit());
