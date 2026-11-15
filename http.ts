/**
 * http.ts — shared HTTP helpers for the forge.
 *
 * Every reply carries a non-empty X-GitHub-Request-Id (a deterministic
 * counter, never a clock or Math.random) and a JSON body for API errors,
 * so no surface ever answers with HTML.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface Ctx {
  store: Store;
  shopToken: string;
  reqCounter: { n: number };
}

export function nextRequestId(ctx: Ctx): string {
  ctx.reqCounter.n += 1;
  return `req-${ctx.reqCounter.n.toString(16).padStart(8, '0')}`;
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(err));
  });
}

/** Send a reply. `body` may be null (empty body, e.g. 204). */
export function reply(
  ctx: Ctx,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer | null,
  extraHeaders: Record<string, string> = {},
): void {
  const headers: Record<string, string> = {
    'x-github-request-id': nextRequestId(ctx),
    ...extraHeaders,
  };
  if (body !== null) {
    headers['content-type'] = contentType;
    headers['content-length'] = String(body.length);
    res.writeHead(status, headers);
    res.end(body);
  } else {
    headers['content-length'] = '0';
    res.writeHead(status, headers);
    res.end();
  }
}

export function sendJson(
  ctx: Ctx,
  res: ServerResponse,
  status: number,
  obj: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  reply(ctx, res, status, 'application/json; charset=utf-8', body, extraHeaders);
}

export function sendJsonError(ctx: Ctx, res: ServerResponse, status: number, message: string): void {
  sendJson(ctx, res, status, { message });
}

/** Authorization: Bearer <MAKEFUN_SHOP_TOKEN> when it is configured, else any non-empty Bearer token. */
export function isAuthed(ctx: Ctx, req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length);
  if (token === '') return false;
  if (ctx.shopToken !== '') return token === ctx.shopToken;
  return true;
}

export interface ParsedUrl {
  path: string;
  query: Map<string, string>;
}

export function parseUrl(rawUrl: string): ParsedUrl {
  const q = rawUrl.indexOf('?');
  const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const query = new Map<string, string>();
  if (q >= 0) {
    const qs = rawUrl.slice(q + 1);
    for (const pair of qs.split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      const value = eq < 0 ? '' : pair.slice(eq + 1);
      try {
        query.set(decodeURIComponent(key), decodeURIComponent(value));
      } catch {
        query.set(key, value);
      }
    }
  }
  return { path, query };
}

/** Absolute base URL for Link headers, derived from the request Host. */
export function baseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

export function parseIntParam(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Split a path into its '/'-separated segments (no leading empty item). */
export function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
