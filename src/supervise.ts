import type { ChildProcess } from 'node:child_process';
import { consoleLogger, type Logger } from './log.js';

export interface SuperviseOptions {
  /** Log label. */
  label: string;
  /** Starts the process; called once up front and again for every restart. */
  spawn: () => ChildProcess;
  /** Delay before each consecutive restart; the last value repeats. Default 1s doubling to 30s. */
  backoffMs?: number[];
  /** A process that stays up this long resets the backoff and restart count. Default 60s. */
  resetAfterMs?: number;
  /** Consecutive restarts before giving up. Default unlimited. */
  maxRestarts?: number;
  /** Sees every new process, e.g. to rewrite a pid file. */
  onSpawn?: (child: ChildProcess) => void;
  log?: Logger;
}

export interface Supervised {
  /** The current process; replaced on every restart. */
  readonly child: ChildProcess;
  /** Stops restarting, signals the current process and resolves once it exits. */
  stop: (signal?: NodeJS.Signals) => Promise<void>;
}

const DEFAULT_BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** Keeps a long-running child alive: an exit that `stop()` didn't ask for
 *  respawns it after a backoff. For services that have no readiness contract
 *  of their own (workers, queue listeners); `startWhisper` supervises itself. */
export function supervise(opts: SuperviseOptions): Supervised {
  const log = opts.log ?? consoleLogger;
  const backoff = opts.backoffMs?.length ? opts.backoffMs : DEFAULT_BACKOFF;
  const resetAfterMs = opts.resetAfterMs ?? 60_000;
  const maxRestarts = opts.maxRestarts ?? Infinity;

  let stopping = false;
  let restarts = 0;
  let timer: NodeJS.Timeout | undefined;
  let child!: ChildProcess;

  const launch = () => {
    const proc = opts.spawn();
    child = proc;
    const startedAt = Date.now();
    opts.onSpawn?.(proc);
    proc.on('exit', (code, signal) => {
      if (stopping || proc !== child) return;
      if (Date.now() - startedAt >= resetAfterMs) restarts = 0;
      if (restarts >= maxRestarts) {
        log('error', opts.label, `exited (code ${code}, signal ${signal}); gave up after ${restarts} restarts`);
        return;
      }
      const delay = backoff[Math.min(restarts, backoff.length - 1)];
      restarts += 1;
      log('warn', opts.label, `exited (code ${code}, signal ${signal}); restarting in ${delay / 1000}s`);
      timer = setTimeout(() => {
        timer = undefined;
        if (!stopping) launch();
      }, delay);
    });
  };
  launch();

  return {
    get child() {
      return child;
    },
    stop: (signal = 'SIGTERM') => {
      stopping = true;
      if (timer) clearTimeout(timer);
      const proc = child;
      if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill(signal);
      });
    },
  };
}
