import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { consoleLogger, pipeOutput, type Logger } from './log.js';
import { findListenerPid, isPortOpen, killPid, LOOPBACK, waitForPort } from './net.js';

export type RedisFlavor = 'redis' | 'garnet';

export interface RedisOptions {
  /** `redis-server`, or Microsoft Garnet's `GarnetServer.exe` on Windows
   *  (Redis has no native Windows server; Garnet speaks RESP). */
  bin: string;
  /** Persistence directory (append-only log), created if missing. */
  dataDir: string;
  /** Default 6399 — away from 6379 so a user's own Redis doesn't collide. */
  port?: number;
  /** Default: `garnet` when the binary name contains "garnet", else `redis`. */
  flavor?: RedisFlavor;
  /** Reuse whatever already listens on the port. Default true. */
  reuseExisting?: boolean;
  log?: Logger;
}

export interface RedisEndpoint {
  host: string;
  port: number;
  url: string;
  child: ChildProcess | null;
  adoptedPid: number | null;
  stop: () => void;
}

export function detectFlavor(bin: string): RedisFlavor {
  return /garnet/i.test(path.basename(bin)) ? 'garnet' : 'redis';
}

// Same intent for both: loopback on our port, append-only log so queued jobs
// survive a crash, no RDB snapshots. Garnet spells the flags differently.
export function redisServerArgs(flavor: RedisFlavor, port: number, dataDir: string): string[] {
  if (flavor === 'garnet') {
    return [
      '--port', String(port),
      '--bind', LOOPBACK,
      '--logdir', dataDir,
      '--checkpointdir', dataDir,
      '--aof',
      '--recover',
    ];
  }
  return [
    '--port', String(port),
    '--bind', LOOPBACK,
    '--dir', dataDir,
    '--appendonly', 'yes',
    '--save', '',
  ];
}

export async function startRedis(opts: RedisOptions): Promise<RedisEndpoint> {
  const port = opts.port ?? 6399;
  const log = opts.log ?? consoleLogger;
  const url = `redis://${LOOPBACK}:${port}`;
  const endpoint = (child: ChildProcess | null, adoptedPid: number | null): RedisEndpoint => ({
    host: LOOPBACK,
    port,
    url,
    child,
    adoptedPid,
    stop: () => {
      if (child && !child.killed) child.kill();
      else killPid(adoptedPid);
    },
  });

  if (await isPortOpen(port)) {
    if (opts.reuseExisting === false) throw new Error(`Port ${port} is already in use.`);
    const adoptedPid = await findListenerPid(port);
    log('info', 'redis', `reusing instance already on ${port} (pid=${adoptedPid ?? '?'})`);
    return endpoint(null, adoptedPid);
  }

  if (!existsSync(opts.bin)) throw new Error(`Redis server not found at ${opts.bin}.`);
  await mkdir(opts.dataDir, { recursive: true });

  const flavor = opts.flavor ?? detectFlavor(opts.bin);
  const child = spawn(opts.bin, redisServerArgs(flavor, port, opts.dataDir), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeOutput(child, 'redis');
  child.on('exit', (code) => log('error', 'redis', `exited with code ${code}`));

  try {
    await waitForPort(port, 15_000, { pollIntervalMs: 150, label: 'Redis' });
  } catch (e) {
    child.kill();
    throw e;
  }
  log('info', 'redis', `ready on ${LOOPBACK}:${port}`);
  return endpoint(child, null);
}
