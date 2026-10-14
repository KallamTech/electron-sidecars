import type { ChildProcess } from 'node:child_process';

/** Receives every log line, prefixed by service label. Default: console. */
export type Logger = (level: 'info' | 'warn' | 'error', label: string, message: string) => void;

export const consoleLogger: Logger = (level, label, message) => {
  console[level === 'info' ? 'log' : level](`[${label}] ${message}`);
};

/** Child stdout/stderr go straight through (prefixed) so crashes are diagnosable. */
export function pipeOutput(child: ChildProcess, label: string): void {
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${label}] ${d}`));
}

export const EXE = process.platform === 'win32' ? '.exe' : '';
