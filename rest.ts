/**
 * rest.ts — GitHub REST v3 surface.
 *
 * Every reply is application/json (never HTML), carries X-GitHub-Request-Id
 * (from http.ts), and uses {message} bodies for 401/404/422 errors.
 * All reads/writes go through the shared Store, so REST, GraphQL, MCP and
 * git all see the same state.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commentGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  baseUrl,
  decodeSegment,
  isAuthed,
  parseIntParam,
  readBody,
  reply,
  sendJson,
  sendJsonError,
  splitPath,
  type Ctx,
  type ParsedUrl,
} from './http.ts';

const SHA40 = /^[0-9a-f]{40}$/;

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function userShape(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

export function repoShape(req: IncomingMessage, repo: Repo): Record<string, unknown> {
  const base = baseUrl(req);
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length +
    [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userShape(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: iso(repo.createdAtSec),
    updated_at: iso(repo.createdAtSec),
    html_url: `${base}/${repo.owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    git_url: `${base}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${repo.owner}:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    topics: [],
  };
}

export function labelShape(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    name: label.name,
    color: label.color,
    description: label.description,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    default: false,
  };
}

export function issueShape(req: IncomingMessage, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labelNames.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name } : labelShape(repo, label);
    }),
    user: userShape(),
    assignee: null,
    created_at: iso(issue.createdAtSec),
    updated_at: iso(issue.updatedAtSec),
    closed_at: issue.closedAtSec === null ? null : iso(issue.closedAtSec),
    comments: issue.comments.length,
    html_url: `${baseUrl(req)}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullShape(ctx: Ctx, req: IncomingMessage, repo: Repo, pull: Pull): Record<string, unknown> {
  const base = baseUrl(req);
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userShape(),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userShape(),
    },
    merged: pull.merged,
    mergeable: ctx.store.mergeableState(repo, pull) === 'MERGEABLE',
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAtSec === null ? null : iso(pull.mergedAtSec),
    created_at: iso(pull.createdAtSec),
    updated_at: iso(pull.updatedAtSec),
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commentShape(req: IncomingMessage, repo: Repo, issue: Issue, comment: { id: number; body: string; createdAtSec: number; updatedAtSec: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, issue, comment),
    body: comment.body,
    user: userShape(),
    created_at: iso(comment.createdAtSec),
    updated_at: iso(comment.updatedAtSec),
    html_url: `${baseUrl(req)}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

/** Paginate a list; returns the page and the Link header value ('' if none). */
function paginate<T>(
  ctx: Ctx,
  req: IncomingMessage,
  path: string,
  query: Map<string, string>,
  items: T[],
): { page: T[]; link: string } {
  const perPage = parseIntParam(query.get('per_page'), 30);
  const pageNum = parseIntParam(query.get('page'), 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const links: string[] = [];
  const base = baseUrl(req);
  if (pageNum < totalPages) {
    links.push(`<${base}${path}?per_page=${perPage}&page=${pageNum + 1}>; rel="next"`);
    links.push(`<${base}${path}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  if (pageNum > 1) {
    links.push(`<${base}${path}?per_page=${perPage}&page=${pageNum - 1}>; rel="prev"`);
    links.push(`<${base}${path}?per_page=${perPage}&page=1>; rel="first"`);
  }
  return { page, link: links.join(', ') };
}

async function readJsonBody(req: IncomingMessage): Promise<{ body: unknown; error?: string }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { body: {} };
  try {
    return { body: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { body: null, error: 'malformed JSON body' };
  }
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** Resolve a repo from the path; sends the 404 when absent. */
function resolveRepo(
  ctx: Ctx,
  res: ServerResponse,
  owner: string,
  repoName: string,
): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    sendJsonError(ctx, res, 404, 'Not Found');
    return null;
  }
  const repo = ctx.store.getRepo(repoName);
  if (repo === undefined) {
    sendJsonError(ctx, res, 404, 'Not Found');
    return null;
  }
  return repo;
}

export async function handleRest(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: ParsedUrl,
): Promise<boolean> {
  if (!url.path.startsWith('/api/v3')) return false;
  // Auth: every /api/v3 route requires a token.
  if (!isAuthed(ctx, req)) {
    sendJsonError(ctx, res, 401, 'Requires authentication');
    return true;
  }
  const method = req.method ?? 'GET';
  const segments = splitPath(url.path).slice(2); // drop 'api','v3'

  // --- top-level routes ---------------------------------------------------
  if (segments.length === 0) {
    if (method !== 'GET') {
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    const base = baseUrl(req);
    sendJson(ctx, res, 200, {
      current_user_url: `${base}/api/v3/user`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') {
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    sendJson(ctx, res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') {
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    sendJson(ctx, res, 200, userShape());
    return true;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = ctx.store.listRepos();
      const { page, link } = paginate(ctx, req, '/api/v3/user/repos', url.query, repos);
      const headers: Record<string, string> = {};
      if (link !== '') headers.link = link;
      sendJson(ctx, res, 200, page.map((r) => repoShape(req, r)), headers);
      return true;
    }
    if (method === 'POST') {
      const { body, error } = await readJsonBody(req);
      if (error !== undefined) {
        sendJsonError(ctx, res, 400, error);
        return true;
      }
      const input = asObject(body);
      if (input === null) {
        sendJsonError(ctx, res, 400, 'request body must be a JSON object');
        return true;
      }
      const name = input.name;
      if (typeof name !== 'string' || name === '') {
        sendJsonError(ctx, res, 422, 'name is required');
        return true;
      }
      const result = ctx.store.createRepo(name, {
        description: typeof input.description === 'string' ? input.description : undefined,
        isPrivate: typeof input.private === 'boolean' ? input.private : undefined,
        defaultBranch: typeof input.default_branch === 'string' ? input.default_branch : undefined,
      });
      if ('error' in result) {
        sendJsonError(ctx, res, 422, result.error);
        return true;
      }
      sendJson(ctx, res, 201, repoShape(req, result.repo));
      return true;
    }
    sendJsonError(ctx, res, 404, 'Not Found');
    return true;
  }

  // --- /repos/{owner}/{repo}/... ------------------------------------------
  if (segments[0] !== 'repos' || segments.length < 3) {
    sendJsonError(ctx, res, 404, 'Not Found');
    return true;
  }
  const owner = decodeSegment(segments[1]);
  const repoName = decodeSegment(segments[2]);
  const rest = segments.slice(3);
  const repo = resolveRepo(ctx, res, owner, repoName);
  if (repo === null) return true;

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, res, 200, repoShape(req, repo));
      return true;
    }
    if (method === 'PATCH') {
      const { body, error } = await readJsonBody(req);
      if (error !== undefined) {
        sendJsonError(ctx, res, 400, error);
        return true;
      }
      const input = asObject(body);
      if (input === null) {
        sendJsonError(ctx, res, 400, 'request body must be a JSON object');
        return true;
      }
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      if (typeof input.name === 'string' && input.name !== '' && input.name !== repo.name) {
        if (ctx.store.getRepo(input.name) !== undefined) {
          sendJsonError(ctx, res, 422, 'Repository already exists');
          return true;
        }
        ctx.store.repos.delete(repo.name);
        repo.name = input.name;
        ctx.store.repos.set(repo.name, repo);
      }
      sendJson(ctx, res, 200, repoShape(req, repo));
      return true;
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo.name);
      reply(ctx, res, 204, 'application/json; charset=utf-8', null);
      return true;
    }
    sendJsonError(ctx, res, 404, 'Not Found');
    return true;
  }

  // /repos/{o}/{r}/branches
  if (rest[0] === 'branches') {
    if (method !== 'GET') {
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 1) {
      const branches: Array<Record<string, unknown>> = [];
      const ordered: string[] = [];
      const defaultRef = `refs/heads/${repo.defaultBranch}`;
      if (repo.refs.has(defaultRef)) ordered.push(repo.defaultBranch);
      for (const { name } of ctx.store.listRefs(repo)) {
        if (!name.startsWith('refs/heads/')) continue;
        const branch = name.slice('refs/heads/'.length);
        if (branch !== repo.defaultBranch) ordered.push(branch);
      }
      for (const branch of ordered) {
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) continue;
        branches.push({ name: branch, commit: { sha }, protected: false });
      }
      sendJson(ctx, res, 200, branches);
      return true;
    }
    const branch = rest.slice(1).map(decodeSegment).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    sendJson(ctx, res, 200, { name: branch, commit: { sha }, protected: false });
    return true;
  }

  // /repos/{o}/{r}/commits
  if (rest[0] === 'commits') {
    if (method !== 'GET' || rest.length !== 1) {
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    const refParam = url.query.get('sha');
    let tip: string | undefined;
    if (refParam !== undefined && refParam !== '') {
      tip = repo.refs.get(`refs/heads/${refParam}`) ?? repo.refs.get(refParam) ?? (SHA40.test(refParam) ? refParam : undefined);
      if (tip === undefined) {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (tip === undefined) {
      sendJson(ctx, res, 200, []);
      return true;
    }
    const walk = ctx.store.walkCommits(repo, [tip]);
    const entries: Array<Record<string, unknown>> = [];
    for (const oid of walk.included) {
      const info = ctx.store.getCommitInfo(repo, oid);
      if (info === undefined) continue;
      entries.push({
        sha: oid,
        commit: {
          message: info.message,
          author: { name: info.authorName, email: info.authorEmail, date: iso(info.timestampSec) },
          committer: { name: info.committerName, email: info.committerEmail, date: iso(info.timestampSec) },
          tree: { sha: info.tree },
        },
        author: { login: VIEWER_LOGIN },
        committer: { login: VIEWER_LOGIN },
        parents: info.parents.map((p) => ({ sha: p })),
      });
    }
    sendJson(ctx, res, 200, entries);
    return true;
  }

  // /repos/{o}/{r}/git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const { body, error } = await readJsonBody(req);
      if (error !== undefined) {
        sendJsonError(ctx, res, 400, error);
        return true;
      }
      const input = asObject(body);
      if (input === null) {
        sendJsonError(ctx, res, 400, 'request body must be a JSON object');
        return true;
      }
      const ref = input.ref;
      const sha = input.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
        sendJsonError(ctx, res, 422, 'ref must start with refs/');
        return true;
      }
      if (typeof sha !== 'string' || !SHA40.test(sha) || !ctx.store.hasObject(repo, sha)) {
        sendJsonError(ctx, res, 422, 'sha does not exist');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJsonError(ctx, res, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      const obj = repo.objects.get(sha);
      sendJson(ctx, res, 201, {
        ref,
        node_id: `REF_${repo.id}_${ref}`,
        url: `${baseUrl(req)}/api/v3/repos/${owner}/${repoName}/git/refs/${ref}`,
        object: { sha, type: obj?.type ?? 'commit', url: '' },
      });
      return true;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).map(decodeSegment).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      const obj = repo.objects.get(sha);
      sendJson(ctx, res, 200, {
        ref,
        node_id: `REF_${repo.id}_${ref}`,
        url: `${baseUrl(req)}/api/v3/repos/${owner}/${repoName}/git/refs/${ref}`,
        object: { sha, type: obj?.type ?? 'commit', url: '' },
      });
      return true;
    }
    sendJsonError(ctx, res, 404, 'Not Found');
    return true;
  }

  // /repos/{o}/{r}/contents/{path}
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map(decodeSegment).join('/');
    const refParam = url.query.get('ref');
    const ref = refParam !== undefined && refParam !== ''
      ? (repo.refs.has(`refs/heads/${refParam}`) ? `refs/heads/${refParam}` : refParam)
      : `refs/heads/${repo.defaultBranch}`;
    if (method === 'GET') {
      const blob = ctx.store.getBlobAtRef(repo, ref, filePath);
      if (blob !== undefined) {
        sendJson(ctx, res, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          content: blob.data.toString('base64'),
          sha: blob.oid,
          url: `${baseUrl(req)}/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
        });
        return true;
      }
      const dir = ctx.store.listDirAtRef(repo, ref, filePath);
      if (dir !== undefined) {
        sendJson(ctx, res, 200, dir.map((e) => ({
          type: e.type,
          name: e.name,
          path: e.path,
          sha: e.oid,
          size: e.size ?? 0,
          url: `${baseUrl(req)}/api/v3/repos/${owner}/${repoName}/contents/${e.path}`,
        })));
        return true;
      }
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    if (method === 'PUT') {
      const { body, error } = await readJsonBody(req);
      if (error !== undefined) {
        sendJsonError(ctx, res, 400, error);
        return true;
      }
      const input = asObject(body);
      if (input === null) {
        sendJsonError(ctx, res, 400, 'request body must be a JSON object');
        return true;
      }
      const message = typeof input.message === 'string' ? input.message : `Update ${filePath}`;
      const contentB64 = input.content;
      if (typeof contentB64 !== 'string') {
        sendJsonError(ctx, res, 422, 'content is required');
        return true;
      }
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      } catch {
        sendJsonError(ctx, res, 422, 'content is not valid base64');
        return true;
      }
      const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      const branchRef = `refs/heads/${branch}`;
      let parentTip = repo.refs.get(branchRef);
      if (parentTip === undefined) {
        // Creating the branch: parent on the default branch tip (or unborn).
        parentTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      const shaParam = input.sha;
      const baseTree = parentTip === undefined ? null : (ctx.store.getCommitInfo(repo, parentTip)?.tree ?? null);
      const existing = ctx.store.getBlobAtTree(repo, baseTree, filePath);
      if (shaParam !== undefined) {
        if (typeof shaParam !== 'string' || existing === undefined || existing.oid !== shaParam) {
          sendJsonError(ctx, res, 409, 'sha does not match the current file');
          return true;
        }
      } else if (existing !== undefined) {
        sendJsonError(ctx, res, 422, 'file already exists');
        return true;
      }
      const result = ctx.store.createFileCommit(repo, branch, filePath, content, message, parentTip);
      sendJson(ctx, res, result.isNewFile ? 201 : 200, {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: result.blobOid,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
        },
        commit: { sha: result.commitOid, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      const { body, error } = await readJsonBody(req);
      if (error !== undefined) {
        sendJsonError(ctx, res, 400, error);
        return true;
      }
      const input = asObject(body);
      if (input === null) {
        sendJsonError(ctx, res, 400, 'request body must be a JSON object');
        return true;
      }
      const message = typeof input.message === 'string' ? input.message : `Delete ${filePath}`;
      const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      const parentTip = repo.refs.get(`refs/heads/${branch}`);
      if (parentTip === undefined) {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      const shaParam = input.sha;
      if (typeof shaParam === 'string') {
        const baseTree = ctx.store.getCommitInfo(repo, parentTip)?.tree ?? null;
        const existing = ctx.store.getBlobAtTree(repo, baseTree, filePath);
        if (existing === undefined || existing.oid !== shaParam) {
          sendJsonError(ctx, res, 409, 'sha does not match the current file');
          return true;
        }
      }
      const result = ctx.store.deleteFileCommit(repo, branch, filePath, message, parentTip);
      if ('error' in result) {
        sendJsonError(ctx, res, 404, result.error);
        return true;
      }
      sendJson(ctx, res, 200, { commit: { sha: result.commitOid, message }, content: null });
      return true;
    }
    sendJsonError(ctx, res, 404, 'Not Found');
    return true;
  }

  // /repos/{o}/{r}/labels
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(ctx, res, 200, [...repo.labels.values()].map((l) => labelShape(repo, l)));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const { body, error } = await readJsonBody(req);
      if (error !== undefined) {
        sendJsonError(ctx, res, 400, error);
        return true;
      }
      const input = asObject(body);
      if (input === null || typeof input.name !== 'string' || input.name === '') {
        sendJsonError(ctx, res, 422, 'name is required');
        return true;
      }
      const result = ctx.store.createLabel(
        repo,
        input.name,
        typeof input.color === 'string' ? input.color : undefined,
        typeof input.description === 'string' ? input.description : undefined,
      );
      if ('error' in result) {
        sendJsonError(ctx, res, 422, result.error);
        return true;
      }
      sendJson(ctx, res, 201, labelShape(repo, result.label));
      return true;
    }
    sendJsonError(ctx, res, 404, 'Not Found');
    return true;
  }

  // /repos/{o}/{r}/issues...
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = url.query.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((i) => i.state === 'open');
        else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
        const sort = url.query.get('sort') ?? 'created';
        const direction = url.query.get('direction') ?? 'desc';
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { page, link } = paginate(ctx, req, `/api/v3/repos/${owner}/${repoName}/issues`, url.query, issues);
        const headers: Record<string, string> = {};
        if (link !== '') headers.link = link;
        sendJson(ctx, res, 200, page.map((i) => issueShape(req, repo, i)), headers);
        return true;
      }
      if (method === 'POST') {
        const { body, error } = await readJsonBody(req);
        if (error !== undefined) {
          sendJsonError(ctx, res, 400, error);
          return true;
        }
        const input = asObject(body);
        if (input === null || typeof input.title !== 'string' || input.title === '') {
          sendJsonError(ctx, res, 422, 'title is required');
          return true;
        }
        const labels = Array.isArray(input.labels)
          ? (input.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as { name?: unknown }).name)).filter((n): n is string => typeof n === 'string')
          : [];
        const result = ctx.store.createIssue(
          repo,
          input.title,
          typeof input.body === 'string' ? input.body : '',
          labels,
        );
        if ('error' in result) {
          sendJsonError(ctx, res, 422, result.error);
          return true;
        }
        sendJson(ctx, res, 201, issueShape(req, repo, result.issue));
        return true;
      }
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    const number = Number.parseInt(rest[1], 10);
    if (!Number.isFinite(number)) {
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (issue === undefined) {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendJson(ctx, res, 200, issueShape(req, repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const { body, error } = await readJsonBody(req);
        if (error !== undefined) {
          sendJsonError(ctx, res, 400, error);
          return true;
        }
        const input = asObject(body);
        if (input === null) {
          sendJsonError(ctx, res, 400, 'request body must be a JSON object');
          return true;
        }
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (typeof input.state === 'string' && (input.state === 'open' || input.state === 'closed')) {
          issue.state = input.state;
          issue.closedAtSec = input.state === 'closed' ? ctx.store.trialNowSec : null;
        }
        issue.updatedAtSec = ctx.store.trialNowSec;
        sendJson(ctx, res, 200, issueShape(req, repo, issue));
        return true;
      }
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendJson(ctx, res, 200, issue.comments.map((c) => commentShape(req, repo, issue, c)));
        return true;
      }
      if (method === 'POST') {
        const { body, error } = await readJsonBody(req);
        if (error !== undefined) {
          sendJsonError(ctx, res, 400, error);
          return true;
        }
        const input = asObject(body);
        if (input === null || typeof input.body !== 'string' || input.body === '') {
          sendJsonError(ctx, res, 422, 'body is required');
          return true;
        }
        const comment = ctx.store.createComment(repo, issue, input.body);
        sendJson(ctx, res, 201, commentShape(req, repo, issue, comment));
        return true;
      }
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    sendJsonError(ctx, res, 404, 'Not Found');
    return true;
  }

  // /repos/{o}/{r}/pulls...
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = url.query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
        pulls.sort((a, b) => b.seq - a.seq);
        const { page, link } = paginate(ctx, req, `/api/v3/repos/${owner}/${repoName}/pulls`, url.query, pulls);
        const headers: Record<string, string> = {};
        if (link !== '') headers.link = link;
        sendJson(ctx, res, 200, page.map((p) => pullShape(ctx, req, repo, p)), headers);
        return true;
      }
      if (method === 'POST') {
        const { body, error } = await readJsonBody(req);
        if (error !== undefined) {
          sendJsonError(ctx, res, 400, error);
          return true;
        }
        const input = asObject(body);
        if (input === null || typeof input.title !== 'string' || input.title === '') {
          sendJsonError(ctx, res, 422, 'title is required');
          return true;
        }
        if (typeof input.head !== 'string' || typeof input.base !== 'string') {
          sendJsonError(ctx, res, 422, 'head and base are required');
          return true;
        }
        const result = ctx.store.createPull(
          repo,
          input.title,
          input.head,
          input.base,
          typeof input.body === 'string' ? input.body : '',
        );
        if ('error' in result) {
          sendJsonError(ctx, res, 422, result.error);
          return true;
        }
        sendJson(ctx, res, 201, pullShape(ctx, req, repo, result.pull));
        return true;
      }
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    const number = Number.parseInt(rest[1], 10);
    if (!Number.isFinite(number)) {
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (pull === undefined) {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendJson(ctx, res, 200, pullShape(ctx, req, repo, pull));
        return true;
      }
      sendJsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (pull === undefined) {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      if (method !== 'GET') {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (headTip === undefined || baseTip === undefined) {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      const mb = ctx.store.mergeBase(repo, headTip, baseTip);
      const mbTree = mb === null ? null : (ctx.store.getCommitInfo(repo, mb)?.tree ?? null);
      const headTree = ctx.store.getCommitInfo(repo, headTip)?.tree ?? null;
      const changes = ctx.store.diffTrees(repo, mbTree, headTree);
      const files = changes.map((c) => {
        let additions = 0;
        let deletions = 0;
        if (c.status === 'added' && c.newOid !== undefined) {
          const obj = repo.objects.get(c.newOid);
          if (obj !== undefined && obj.type === 'blob') additions = countLines(obj.data);
        } else if (c.status === 'removed' && c.oldOid !== undefined) {
          const obj = repo.objects.get(c.oldOid);
          if (obj !== undefined && obj.type === 'blob') deletions = countLines(obj.data);
        } else if (c.status === 'modified' && c.oldOid !== undefined && c.newOid !== undefined) {
          const oldObj = repo.objects.get(c.oldOid);
          const newObj = repo.objects.get(c.newOid);
          const oldLines = oldObj !== undefined && oldObj.type === 'blob' ? oldObj.data.toString('utf8').split('\n') : [];
          const newLines = newObj !== undefined && newObj.type === 'blob' ? newObj.data.toString('utf8').split('\n') : [];
          const { added, removed } = lineDiff(oldLines, newLines);
          additions = added;
          deletions = removed;
        }
        return {
          filename: c.path,
          status: c.status === 'modified' ? 'modified' : c.status,
          additions,
          deletions,
          changes: additions + deletions,
        };
      });
      sendJson(ctx, res, 200, files);
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (pull === undefined) {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      if (method !== 'PUT') {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      const { body, error } = await readJsonBody(req);
      if (error !== undefined) {
        sendJsonError(ctx, res, 400, error);
        return true;
      }
      const input = asObject(body);
      if (input !== null && typeof input.merge_method === 'string' && !['merge', 'squash', 'rebase'].includes(input.merge_method)) {
        sendJsonError(ctx, res, 422, 'unknown merge_method');
        return true;
      }
      if (pull.state !== 'open') {
        sendJsonError(ctx, res, 405, 'Pull request is already closed');
        return true;
      }
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (headTip === undefined || baseTip === undefined) {
        sendJsonError(ctx, res, 404, 'Not Found');
        return true;
      }
      const analysis = ctx.store.threeWay(repo, baseTip, headTip);
      if (!analysis.mergeable) {
        sendJsonError(ctx, res, 405, `Merge conflict in: ${analysis.conflicts.join(', ')}`);
        return true;
      }
      const result = ctx.store.squashMerge(repo, pull);
      if ('error' in result) {
        sendJsonError(ctx, res, 405, result.error);
        return true;
      }
      sendJson(ctx, res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
      return true;
    }
    sendJsonError(ctx, res, 404, 'Not Found');
    return true;
  }

  sendJsonError(ctx, res, 404, 'Not Found');
  return true;
}

function countLines(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

/** Multiset line diff: lines added vs lines removed. */
function lineDiff(oldLines: string[], newLines: string[]): { added: number; removed: number } {
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newLines) {
    const count = oldCounts.get(line) ?? 0;
    if (count > 0) oldCounts.set(line, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of oldCounts.values()) removed += count;
  return { added, removed };
}
