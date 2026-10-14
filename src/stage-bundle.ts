import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface StageResult {
  dir: string;
  /** Files were just (re)copied: this version is new on disk. Use it to
   *  invalidate "already running" fast paths that would keep old code. */
  freshlyStaged: boolean;
}

const STAMP = '.sidecars-bundle-version';

/**
 * Copies a read-only bundled directory (e.g. inside /Applications/X.app) to a
 * writable location once per app version. The copy goes to a sibling tmp dir
 * and is swapped in by rename, so a crash mid-copy never leaves a half tree
 * that a later launch would trust.
 */
export async function stageBundle(src: string, dest: string, version: string): Promise<StageResult> {
  const stampFile = path.join(dest, STAMP);
  if (existsSync(stampFile)) {
    try {
      if ((await readFile(stampFile, 'utf8')).trim() === version) {
        return { dir: dest, freshlyStaged: false };
      }
    } catch {
      /* re-stage on any read error */
    }
  }

  await mkdir(path.dirname(dest), { recursive: true });
  const staging = `${dest}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await cp(src, staging, { recursive: true });
  // Stamp inside the staged tree, before the swap: dest is never stamped
  // without its full contents.
  await writeFile(path.join(staging, STAMP), version, 'utf8');
  const previous = existsSync(dest) ? `${dest}.old-${process.pid}` : null;
  if (previous) await rename(dest, previous);
  await rename(staging, dest);
  if (previous) rm(previous, { recursive: true, force: true }).catch(() => {});
  return { dir: dest, freshlyStaged: true };
}
