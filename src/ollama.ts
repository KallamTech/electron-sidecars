import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { consoleLogger, pipeOutput, type Logger } from './log.js';
import { isPortOpen, LOOPBACK } from './net.js';

export interface OllamaOptions {
  /** Path to the `ollama` binary. Its accelerator libs must sit next to it. */
  bin: string;
  /** OLLAMA_MODELS — where pulled models live. */
  modelsDir: string;
  /** Default 11434 (Ollama's standard port, so a user's own Ollama is reused). */
  port?: number;
  /** OLLAMA_KEEP_ALIVE. Default `-1` (keep models resident: no multi-GB
   *  reload after idle). Use e.g. `5m` to bound RAM. */
  keepAlive?: string;
  /** Reuse a responsive Ollama already on the port. Default true. */
  reuseExisting?: boolean;
  readyTimeoutMs?: number;
  log?: Logger;
}

export interface OllamaEndpoint {
  url: string;
  /** False when an existing Ollama was reused (then `stop` is a no-op). */
  ownedByUs: boolean;
  child: ChildProcess | null;
  stop: () => void;
}

function httpGet(urlStr: string, timeoutMs = 3000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

export async function isOllamaResponsive(url: string): Promise<boolean> {
  try {
    return (await httpGet(`${url}/api/tags`)).status === 200;
  } catch {
    return false;
  }
}

export async function startOllama(opts: OllamaOptions): Promise<OllamaEndpoint> {
  const port = opts.port ?? 11434;
  const log = opts.log ?? consoleLogger;
  const url = `http://${LOOPBACK}:${port}`;

  if (opts.reuseExisting !== false && (await isPortOpen(port)) && (await isOllamaResponsive(url))) {
    log('info', 'ollama', `reusing existing instance at ${url}`);
    return { url, ownedByUs: false, child: null, stop: () => {} };
  }

  if (!existsSync(opts.bin)) throw new Error(`Ollama binary not found at ${opts.bin}.`);
  await mkdir(opts.modelsDir, { recursive: true });

  log('info', 'ollama', 'starting');
  const child = spawn(opts.bin, ['serve'], {
    env: {
      ...process.env,
      // Loopback only: binding wider exposes the model to LAN peers.
      OLLAMA_HOST: `${LOOPBACK}:${port}`,
      OLLAMA_MODELS: opts.modelsDir,
      OLLAMA_KEEP_ALIVE: opts.keepAlive ?? '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeOutput(child, 'ollama');
  child.on('exit', (code) => log('error', 'ollama', `exited with code ${code}`));
  const stop = () => {
    if (!child.killed) child.kill();
  };

  const timeoutMs = opts.readyTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOllamaResponsive(url)) {
      log('info', 'ollama', `ready at ${url}`);
      return { url, ownedByUs: true, child, stop };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  // Kill before throwing: a live-but-unresponsive child holding the port
  // would make every later attempt time out the same way.
  stop();
  throw new Error(`Ollama did not become responsive within ${Math.round(timeoutMs / 1000)}s`);
}

/** /api/tags echoes tagged names ("bge-m3:latest"); callers often pass
 *  untagged ones. Compare as `<name>:<tag>`, tag defaulting to `latest`. */
export function normalizeModelId(model: string): string {
  return model.includes(':') ? model : `${model}:latest`;
}

export async function isModelPresent(url: string, model: string): Promise<boolean> {
  try {
    const tags = await httpGet(`${url}/api/tags`);
    if (tags.status !== 200) return false;
    const parsed = JSON.parse(tags.body) as { models?: { name: string }[] };
    const wanted = normalizeModelId(model);
    return parsed.models?.some((m) => normalizeModelId(m.name) === wanted) ?? false;
  } catch {
    return false;
  }
}

export type Progress = (phase: string, fraction: number | undefined) => void;

/** Ollama's raw pull status ("pulling <sha256>", "verifying sha256 digest")
 *  as a plain-language step for a setup UI. */
export function friendlyPullStatus(status: string, label: string): string {
  const s = status.toLowerCase();
  if (s.startsWith('verifying')) return `Verifying ${label}`;
  if (s.startsWith('writing') || s.startsWith('removing') || s === 'success') return `Finishing ${label}`;
  if (s.includes('manifest')) return `Preparing ${label}`;
  if (s.startsWith('pulling') || s.startsWith('downloading')) return `Downloading ${label}`;
  return `Preparing ${label}`;
}

interface PullEvent {
  status?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/** Pulls `model` unless already present, streaming progress. */
export async function ensureModel(
  url: string,
  model: string,
  onProgress: Progress = () => {},
  label = 'AI model',
): Promise<void> {
  if (await isModelPresent(url, model)) {
    onProgress(`${label} ready`, 1);
    return;
  }

  onProgress(`Downloading ${label}…`, 0);
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      `${url}/api/pull`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Ollama pull failed: HTTP ${res.statusCode}`));
        }
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          let nl: number;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let ev: PullEvent;
            try {
              ev = JSON.parse(line) as PullEvent;
            } catch {
              continue;
            }
            if (ev.error) {
              res.destroy();
              return reject(new Error(`Ollama pull: ${ev.error}`));
            }
            const phase = friendlyPullStatus(ev.status ?? '', label);
            if (ev.total && ev.completed != null) {
              const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
              onProgress(`${phase} (${mb(ev.completed)} / ${mb(ev.total)} MB)`, ev.completed / ev.total);
            } else {
              onProgress(phase, undefined);
            }
          }
        });
        res.on('end', () => resolve());
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify({ name: model }));
    req.end();
  });
  onProgress(`${label} ready`, 1);
}
