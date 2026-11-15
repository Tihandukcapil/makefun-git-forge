/**
 * app.ts — the forge HTTP server.
 *
 * One process, one in-memory Store, four surfaces:
 *   GET  /healthz            liveness (no auth)
 *   POST /mcp                Model Context Protocol (JSON-RPC 2.0)
 *   POST /api/graphql        GraphQL v4
 *   /api/v3/*                GitHub REST v3 (auth required)
 *   /{owner}/{repo}.git/*    git smart HTTP (no auth)
 * Anything else is a JSON 404. No surface ever answers with HTML, and an
 * unexpected error is a JSON 500, never a crash.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { parseUrl, sendJson, sendJsonError, type Ctx } from './http.ts';

export interface ForgeOptions {
  /** Trial clock in whole seconds (0 = unset; the Store falls back to a fixed epoch). */
  trialNowSec: number;
  /** The Bearer token the suite sends (MAKEFUN_SHOP_TOKEN). */
  shopToken: string;
}

export function createApp(options: ForgeOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const store = new Store(options.trialNowSec);
  const ctx: Ctx = { store, shopToken: options.shopToken, reqCounter: { n: 0 } };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = parseUrl(req.url ?? '/');
      const method = req.method ?? 'GET';

      if (url.path === '/healthz' && method === 'GET') {
        sendJson(ctx, res, 200, { ok: true });
        return;
      }
      if (url.path === '/mcp' && method === 'POST') {
        await handleMcp(ctx, req, res);
        return;
      }
      if (url.path === '/api/graphql' && method === 'POST') {
        await handleGraphQL(ctx, req, res);
        return;
      }
      if (url.path === '/api/v3' || url.path.startsWith('/api/v3/')) {
        await handleRest(ctx, req, res, url);
        return;
      }
      if (await handleGit(ctx, req, res, url)) {
        return;
      }
      sendJsonError(ctx, res, 404, 'Not Found');
    } catch (err) {
      console.error('forge request error', err);
      if (!res.headersSent) {
        sendJsonError(ctx, res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } else {
        try {
          res.end();
        } catch {
          // Already closed; nothing more to do.
        }
      }
    }
  };
}
