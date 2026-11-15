/**
 * git-forge — Make.Fun github-core-clone-01 entry point.
 *
 * Lifecycle (per the competition kit): bind an ephemeral port, register it
 * with the environment, then poll the environment until it reports done.
 * All forge behaviour lives in app.ts; this file only owns the lifecycle
 * (registration, polling, and the exit code).
 *
 * The entrypoint is `main.ts` at the repository root and runs as
 * `node /bot/main.ts` (Node 22, type stripping). It binds 0.0.0.0 so the
 * environment can reach it in both the pod layout (127.0.0.1) and the
 * split layout (entry reached by pod hostname).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? 'http://127.0.0.1:8080';

function readStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** Trial clock in whole seconds, or 0 when MAKEFUN_TRIAL_NOW is unset. */
function readTrialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw === undefined || raw === '') return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postRegister(url: string, port: number): Promise<void> {
  const response = await fetch(`${url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!response.ok) {
    throw new Error(`register failed: HTTP ${response.status}`);
  }
}

async function pollDone(url: string): Promise<void> {
  for (;;) {
    await sleep(500);
    let data: unknown;
    try {
      const response = await fetch(`${url}/done`, { method: 'GET' });
      data = await response.json();
    } catch {
      continue;
    }
    if (data !== null && typeof data === 'object' && (data as { done?: unknown }).done === true) {
      return;
    }
  }
}

async function main(): Promise<void> {
  const app = createApp({
    trialNowSec: readTrialNowSec(),
    shopToken: readStr('MAKEFUN_SHOP_TOKEN', ''),
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void app(req, res);
  });
  // A signal from the harness (or a stray rejected promise) must never kill
  // the forge mid-trial: close cleanly on SIGTERM/SIGINT and keep serving
  // after an unexpected rejection instead of crashing.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.on('unhandledRejection', (error: unknown) => {
    console.error('unhandled rejection', error);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not determine the bound address');
  }
  const port = address.port;
  process.stdout.write(`forge listening on 0.0.0.0:${port}\n`);
  await postRegister(ENV_URL, port);
  await pollDone(ENV_URL);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('forge done\n');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
