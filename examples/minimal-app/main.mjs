// Boots Postgres+pgvector, PostgREST and Redis, then shows their status.
// Binaries: `npm run bin` (→ ./pg, ./bin). Packaged: ship pg/, bin/, db/ as extraResources.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { startPostgres, startPostgrest, startRedis } from '@kallamtech/local-ai-stack';
import { dataPath, persistentSecret, resourcePath, stopOnQuit } from '@kallamtech/local-ai-stack/electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const res = (...p) => resourcePath(here, ...p);

let pg, rest, redis;
stopOnQuit(async () => {
  rest?.stop();
  redis?.stop();
  await pg?.stop();
});

function getJson(socketPath, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ socketPath, path: p }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

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
      password: persistentSecret('postgres'),
      schema: {
        prelude: [res('db', 'prelude.sql')],
        migrationsDir: res('db', 'migrations'),
        postlude: [res('db', 'postlude.sql')],
        searchPath: 'public, extensions',
      },
    });
    // PostgREST's login role gets a fresh password every launch.
    const authenticatorPw = randomBytes(24).toString('hex');
    await pg.setPassword('authenticator', authenticatorPw);
    [rest, redis] = await Promise.all([
      // Demo only: anonymous access is acceptable because the socket is
      // reachable by this OS user alone. A real app puts its own
      // authenticating proxy (or a jwtSecret) in front of this.
      startPostgrest({
        bin: res('bin', 'postgrest'),
        dbUri: pg.url('authenticator', authenticatorPw),
        anonRole: 'web_anon',
        allowAnonymous: true,
        unixSocket: path.join(app.getPath('temp'), 'sidecars-demo', 'postgrest.sock'),
        extraSearchPath: ['public', 'extensions'],
        schemaChanged: pg.schemaChanged,
      }),
      startRedis({
        bin: res('bin', 'redis-server'),
        dataDir: dataPath('redis'),
        password: randomBytes(24).toString('hex'),
      }),
    ]);
    const notes = await getJson(rest.socketPath, '/notes?select=id,body,embedding');
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    await win.loadURL(
      page(`<h1>All sidecars up</h1>
        <ul>
          <li>Postgres: <code>127.0.0.1:${pg.port}</code> (scram-sha-256)${pg.initialized ? ' (new cluster)' : ''}</li>
          <li>PostgREST: <code>${esc(rest.socketPath)}</code> (unix socket)</li>
          <li>Redis: <code>127.0.0.1:${redis.port}</code> (password)</li>
        </ul>
        <h2>GET /notes</h2><pre>${esc(JSON.stringify(notes, null, 2))}</pre>`),
    );
  } catch (e) {
    await win.loadURL(page(`<h1>Startup failed</h1><pre>${String(e?.stack ?? e).replace(/</g, '&lt;')}</pre>`));
  }
});

app.on('window-all-closed', () => app.quit());
