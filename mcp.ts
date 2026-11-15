/**
 * mcp.ts — Model Context Protocol endpoint (Streamable HTTP, JSON-RPC 2.0).
 *
 * Plain application/json answers (no SSE). MODERN era (2026-07-28):
 * `server/discover` is the handshake; `initialize` is also answered for
 * legacy clients. Tools act on the same shared Store as REST/GraphQL/git,
 * and tool results carry both content text and structuredContent.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN } from './store.ts';
import { isAuthed, readBody, reply, sendJson, type Ctx } from './http.ts';
import { issueShape, pullShape, repoShape } from './rest.ts';

const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '1.0.0';

/**
 * The tool list is a module-level constant so two tools/list calls return
 * a byte-identical array.
 */
const TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a repository under the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type RpcResult = { result: unknown } | { error: { code: number; message: string } };

function toolResult(value: unknown): RpcResult {
  const text = JSON.stringify(value);
  return {
    result: {
      content: [{ type: 'text', text }],
      structuredContent: value,
    },
  };
}

function toolError(message: string): RpcResult {
  return {
    result: {
      content: [{ type: 'text', text: message }],
      isError: true,
    },
  };
}

function resolveRepo(ctx: Ctx, owner: unknown, repoName: unknown): { repo: import('./store.ts').Repo } | { error: string } {
  if (typeof owner !== 'string' || typeof repoName !== 'string') {
    return { error: 'owner and repo are required' };
  }
  if (owner !== VIEWER_LOGIN) return { error: 'Not Found' };
  const repo = ctx.store.getRepo(repoName);
  if (repo === undefined) return { error: 'Not Found' };
  return { repo };
}

function callTool(ctx: Ctx, req: IncomingMessage, params: Record<string, unknown>): RpcResult {
  const name = params.name as string | undefined;
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (typeof name !== 'string') {
    return { error: { code: -32602, message: 'tools/call requires a tool name' } };
  }
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) {
    return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
  const required = (tool.inputSchema as { required?: string[] }).required ?? [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return { error: { code: -32602, message: `Missing required argument(s): ${missing.join(', ')}` } };
  }

  if (name === 'create_repo') {
    const repoName = args.name as string;
    const result = ctx.store.createRepo(repoName, {
      description: typeof args.description === 'string' ? args.description : undefined,
      isPrivate: typeof args.private === 'boolean' ? args.private : undefined,
    });
    if ('error' in result) return toolError(result.error);
    return toolResult(repoShape(req, result.repo));
  }

  if (name === 'get_repo') {
    const resolved = resolveRepo(ctx, args.owner, args.repo);
    if ('error' in resolved) return toolError(resolved.error);
    return toolResult(repoShape(req, resolved.repo));
  }

  if (name === 'create_issue') {
    const resolved = resolveRepo(ctx, args.owner, args.repo);
    if ('error' in resolved) return toolError(resolved.error);
    const title = args.title as string;
    const result = ctx.store.createIssue(
      resolved.repo,
      title,
      typeof args.body === 'string' ? args.body : '',
      [],
    );
    if ('error' in result) return toolError(result.error);
    return toolResult(issueShape(req, resolved.repo, result.issue));
  }

  if (name === 'list_issues') {
    const resolved = resolveRepo(ctx, args.owner, args.repo);
    if ('error' in resolved) return toolError(resolved.error);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...resolved.repo.issues.values()];
    if (state === 'open') issues = issues.filter((i) => i.state === 'open');
    else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
    issues.sort((a, b) => a.seq - b.seq);
    return toolResult({ issues: issues.map((i) => issueShape(req, resolved.repo, i)) });
  }

  if (name === 'create_pull_request') {
    const resolved = resolveRepo(ctx, args.owner, args.repo);
    if ('error' in resolved) return toolError(resolved.error);
    const result = ctx.store.createPull(
      resolved.repo,
      args.title as string,
      args.head as string,
      args.base as string,
      typeof args.body === 'string' ? args.body : '',
    );
    if ('error' in result) return toolError(result.error);
    return toolResult(pullShape(ctx, req, resolved.repo, result.pull));
  }

  if (name === 'merge_pull_request') {
    const resolved = resolveRepo(ctx, args.owner, args.repo);
    if ('error' in resolved) return toolError(resolved.error);
    const pullNumber = args.pull_number as number;
    const pull = resolved.repo.pulls.get(pullNumber);
    if (pull === undefined) return toolError('Pull request not found');
    const result = ctx.store.squashMerge(resolved.repo, pull);
    if ('error' in result) return toolError(result.error);
    return toolResult(pullShape(ctx, req, resolved.repo, pull));
  }

  return { error: { code: -32601, message: `Unknown tool: ${name}` } };
}

function dispatch(ctx: Ctx, req: IncomingMessage, method: string, params: unknown): RpcResult {
  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return {
      result: {
        serverInfo,
        capabilities: { tools: {} },
        supportedVersions: ['2026-07-28'],
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      },
    };
  }
  if (method === 'initialize') {
    const offered = (params as Record<string, unknown> | null)?.protocolVersion;
    return {
      result: {
        protocolVersion: typeof offered === 'string' ? offered : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (method === 'ping') {
    return { result: {} };
  }
  if (method === 'tools/list') {
    return { result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const paramsObj = (params ?? {}) as Record<string, unknown>;
    return callTool(ctx, req, paramsObj);
  }
  return { error: { code: -32601, message: `Method not found: ${method}` } };
}

export async function handleMcp(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(ctx, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(ctx, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const record = body as Record<string, unknown>;
  const id = record.id;
  if (!isAuthed(ctx, req)) {
    sendJson(ctx, res, 401, {
      jsonrpc: '2.0',
      id: id === undefined ? null : id,
      error: { code: -32000, message: 'Unauthorized' },
    });
    return;
  }
  const method = record.method;
  if (typeof method !== 'string') {
    if (id === undefined) {
      // A notification with no method: acknowledge silently.
      reply(ctx, res, 202, 'application/json; charset=utf-8', null);
      return;
    }
    sendJson(ctx, res, 200, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  if (id === undefined) {
    // Notification (no id): acknowledge, no body.
    reply(ctx, res, 202, 'application/json; charset=utf-8', null);
    return;
  }
  const result = dispatch(ctx, req, method, record.params);
  if ('error' in result) {
    sendJson(ctx, res, 200, { jsonrpc: '2.0', id, error: result.error });
  } else {
    sendJson(ctx, res, 200, { jsonrpc: '2.0', id, result: result.result });
  }
}
