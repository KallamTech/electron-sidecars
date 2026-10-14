import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

/**
 * Where a bundled resource lives: `process.resourcesPath/<...segments>` when
 * packaged (ship it via electron-builder `extraResources`), else
 * `<devRoot>/<...segments>`.
 */
export function resourcePath(devRoot: string, ...segments: string[]): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...segments)
    : path.join(devRoot, ...segments);
}

/** `<userData>/<...segments>` — the per-user writable data root. */
export function dataPath(...segments: string[]): string {
  return path.join(app.getPath('userData'), ...segments);
}

/**
 * Stops sidecars before the app exits. `before-quit` is held until `stop`
 * resolves — Postgres runs detached (pg_ctl), and an unclean exit leaves a
 * postmaster on the data dir. SIGTERM/SIGINT don't fire `before-quit` on their
 * own, so they're routed through app.quit(). SIGKILL can't be caught;
 * startPostgres self-heals a stale postmaster on the next launch.
 */
export function stopOnQuit(stop: () => Promise<void> | void): void {
  let quitting = false;
  app.on('before-quit', async (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    try {
      await stop();
    } catch (e) {
      console.error('[sidecars] stop failed:', e);
    }
    app.quit();
  });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => app.quit());
}

/**
 * A random hex secret that survives restarts: generated once, stored under
 * userData encrypted with safeStorage (the macOS Keychain / Windows DPAPI /
 * libsecret). Use it for `startPostgres({ password })`. Throws when safeStorage
 * has no backend rather than writing the secret in plaintext.
 */
export function persistentSecret(name: string): string {
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error(`unsafe secret name: ${name}`);
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage is unavailable; refusing to store a plaintext secret');
  }
  const file = dataPath(`${name}.secret`);
  if (existsSync(file)) return safeStorage.decryptString(readFileSync(file));
  const secret = randomBytes(24).toString('hex');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, safeStorage.encryptString(secret), { mode: 0o600 });
  return secret;
}
