/**
 * store.ts — the forge's single in-memory store.
 *
 * Every surface (git smart HTTP, REST v3, GraphQL, MCP) reads and writes
 * the same objects, refs, issues and pull requests, so a repo created by
 * one protocol is visible to the others. Nothing is written to disk.
 * All timestamps come from the trial clock (MAKEFUN_TRIAL_NOW), never
 * from the wall clock, so behaviour is deterministic across runs.
 */
import {
  buildCommit,
  buildTree,
  makeObject,
  objectId,
  parseCommit,
  parseTree,
  type CommitInfo,
  type GitObject,
  type TreeEntry,
} from './gitproto.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** The well-known empty-tree object id (sha1 of `tree 0\0`). */
export const EMPTY_TREE_OID = objectId('tree', Buffer.alloc(0));

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAtSec: number;
  updatedAtSec: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  createdAtSec: number;
  updatedAtSec: number;
  closedAtSec: number | null;
  seq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAtSec: number;
  updatedAtSec: number;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAtSec: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  seq: number;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  mode: string;
  oldOid?: string;
  newOid?: string;
}

export function globalId(type: string, ...parts: Array<string | number>): string {
  return Buffer.from([type, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const segs = text.split(':');
    if (segs.length < 2) return null;
    return { type: segs[0], parts: segs.slice(1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.id, pull.number);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return globalId('IssueComment', repo.id, issue.number, comment.id);
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextObjectId = 1;
  nextCommentId = 1;
  nextLabelId = 1;
  seq = 0;
  trialNowSec: number;

  constructor(trialNowSec: number) {
    this.trialNowSec = trialNowSec > 0 ? trialNowSec : 1700000000;
  }

  nowIso(): string {
    return new Date(this.trialNowSec * 1000).toISOString();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // ------------------------------------------------------------------ repos
  createRepo(
    name: string,
    opts: { description?: string; isPrivate?: boolean; defaultBranch?: string },
  ): { repo: Repo } | { error: string } {
    if (this.repos.has(name)) return { error: 'Repository already exists' };
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? DEFAULT_BRANCH,
      createdAtSec: this.trialNowSec,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.nextSeq(),
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return { repo };
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------- git objects
  putObject(repo: Repo, obj: GitObject): string {
    const oid = objectId(obj.type, obj.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    return oid;
  }

  putObjects(repo: Repo, entries: Map<string, GitObject>): void {
    for (const [oid, obj] of entries) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Peel a tag (possibly nested) to its commit, or return the oid itself. */
  resolveCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    for (let i = 0; i < 16; i++) {
      const obj = repo.objects.get(current);
      if (obj === undefined) return undefined;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        if (match === null) return undefined;
        current = match[1];
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  getCommitInfo(repo: Repo, oid: string): CommitInfo | undefined {
    const commitOid = this.resolveCommit(repo, oid);
    if (commitOid === undefined) return undefined;
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data);
  }

  parentsOf(repo: Repo, commitOid: string): string[] {
    const info = this.getCommitInfo(repo, commitOid);
    return info === undefined ? [] : info.parents;
  }

  /**
   * Breadth-first walk from `tips` following parents. `maxDepth` limits how
   * deep the walk goes (tip = depth 1); `stopAt` lists commits whose parents
   * are never followed (old shallow boundaries: the commit itself is
   * included, its parents are not). Returns the commits in BFS order with
   * their depths.
   */
  walkCommits(
    repo: Repo,
    tips: string[],
    opts: { maxDepth?: number; stopAt?: Set<string> } = {},
  ): { included: string[]; depth: Map<string, number> } {
    const included: string[] = [];
    const depth = new Map<string, number>();
    const queue: Array<{ oid: string; d: number }> = [];
    let head = 0;
    for (const tip of tips) {
      const commitOid = this.resolveCommit(repo, tip);
      if (commitOid === undefined) continue;
      if (!depth.has(commitOid)) {
        depth.set(commitOid, 1);
        queue.push({ oid: commitOid, d: 1 });
      }
    }
    while (head < queue.length) {
      const { oid, d } = queue[head] as { oid: string; d: number };
      head += 1;
      included.push(oid);
      if (opts.maxDepth !== undefined && d >= opts.maxDepth) continue;
      if (opts.stopAt !== undefined && opts.stopAt.has(oid)) continue;
      for (const parent of this.parentsOf(repo, oid)) {
        const parentCommit = this.resolveCommit(repo, parent);
        if (parentCommit === undefined) continue;
        if (!depth.has(parentCommit)) {
          depth.set(parentCommit, d + 1);
          queue.push({ oid: parentCommit, d: d + 1 });
        }
      }
    }
    return { included, depth };
  }

  /**
   * Objects reachable from `oids`: each object plus its tree/blob closure.
   * Commit parents are NOT followed — the caller supplies exactly the
   * commits it wants (the BFS in walkCommits already returns ancestors
   * when they are wanted). Following parents here would pull a depth-1
   * fetch's whole history into the pack and cancel a deepen fetch.
   */
  collectObjects(repo: Repo, oids: string[]): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const visitObject = (oid: string): void => {
      if (out.has(oid)) return;
      const obj = repo.objects.get(oid);
      if (obj === undefined) return;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        visitObject(info.tree);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) visitObject(entry.oid);
      } else if (obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        if (match !== null) visitObject(match[1]);
      }
    };
    for (const oid of oids) visitObject(oid);
    return out;
  }

  // ------------------------------------------------------------------- trees
  flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
    const build = (paths: Array<{ segments: string[]; mode: string; oid: string }>): string => {
      const entries: TreeEntry[] = [];
      const byTop = new Map<string, Array<{ segments: string[]; mode: string; oid: string }>>();
      for (const p of paths) {
        const top = p.segments[0];
        const rest = p.segments.slice(1);
        if (rest.length === 0) {
          entries.push({ mode: p.mode, name: top, oid: p.oid });
        } else {
          if (!byTop.has(top)) byTop.set(top, []);
          byTop.get(top)?.push({ segments: rest, mode: p.mode, oid: p.oid });
        }
      }
      for (const [top, sub] of byTop) {
        const subTreeOid = build(sub);
        entries.push({ mode: '40000', name: top, oid: subTreeOid });
      }
      const treeData = buildTree(entries);
      const { oid, obj } = makeObject('tree', treeData);
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      return oid;
    };
    const paths = [...flat.entries()].map(([path, v]) => ({
      segments: path.split('/'),
      mode: v.mode,
      oid: v.oid,
    }));
    return build(paths);
  }

  setFileInTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string, mode = '100644'): string {
    const flat = baseTreeOid === null ? new Map<string, { mode: string; oid: string }>() : this.flattenTree(repo, baseTreeOid);
    flat.set(path, { mode, oid: blobOid });
    return this.buildTreeFromFlat(repo, flat);
  }

  deleteFileFromTree(repo: Repo, baseTreeOid: string, path: string): string {
    const flat = this.flattenTree(repo, baseTreeOid);
    flat.delete(path);
    return this.buildTreeFromFlat(repo, flat);
  }

  getBlobAtTree(repo: Repo, treeOid: string | null, path: string): { oid: string; data: Buffer } | undefined {
    if (treeOid === null) return undefined;
    const flat = this.flattenTree(repo, treeOid);
    const entry = flat.get(path);
    if (entry === undefined) return undefined;
    const obj = repo.objects.get(entry.oid);
    if (obj === undefined || obj.type !== 'blob') return undefined;
    return { oid: entry.oid, data: obj.data };
  }

  /** Direct children of `path` ('/'-separated, '' = root) at a ref tip. */
  listDirAtRef(
    repo: Repo,
    ref: string,
    path: string,
  ): Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string; size?: number }> | undefined {
    const tip = repo.refs.get(ref);
    if (tip === undefined) return undefined;
    const info = this.getCommitInfo(repo, tip);
    if (info === undefined) return undefined;
    let treeOid = info.tree;
    const segments = path === '' ? [] : path.split('/').filter((s) => s !== '');
    for (const segment of segments) {
      const obj = repo.objects.get(treeOid);
      if (obj === undefined || obj.type !== 'tree') return undefined;
      const entry = parseTree(obj.data).find((e) => e.name === segment);
      if (entry === undefined || entry.mode !== '40000') return undefined;
      treeOid = entry.oid;
    }
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const out: Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string; size?: number }> = [];
    for (const entry of parseTree(obj.data)) {
      const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.mode === '40000') {
        out.push({ name: entry.name, path: childPath, type: 'dir', oid: entry.oid });
      } else {
        const blob = repo.objects.get(entry.oid);
        out.push({
          name: entry.name,
          path: childPath,
          type: 'file',
          oid: entry.oid,
          size: blob !== undefined && blob.type === 'blob' ? blob.data.length : 0,
        });
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  getBlobAtRef(repo: Repo, ref: string, path: string): { oid: string; data: Buffer } | undefined {
    const tip = repo.refs.get(ref);
    if (tip === undefined) return undefined;
    const info = this.getCommitInfo(repo, tip);
    if (info === undefined) return undefined;
    return this.getBlobAtTree(repo, info.tree, path);
  }

  // ------------------------------------------------------------ commit makers
  makeCommit(
    repo: Repo,
    opts: { tree: string; parents: string[]; message: string },
  ): string {
    const data = buildCommit({
      tree: opts.tree,
      parents: opts.parents,
      message: opts.message,
      authorName: VIEWER_NAME,
      authorEmail: VIEWER_EMAIL,
      committerName: VIEWER_NAME,
      committerEmail: VIEWER_EMAIL,
      timestampSec: this.trialNowSec,
    });
    const { oid, obj } = makeObject('commit', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    return oid;
  }

  /**
   * Commit `content` as `path` on `branch`, parented on `parentTip`
   * (undefined for the first commit). Returns the new commit and blob ids.
   */
  createFileCommit(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    parentTip: string | undefined,
  ): { commitOid: string; blobOid: string; isNewFile: boolean } {
    const { oid: blobOid, obj } = makeObject('blob', content);
    if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, obj);
    const baseTree = parentTip === undefined ? null : (this.getCommitInfo(repo, parentTip)?.tree ?? null);
    const isNewFile = this.getBlobAtTree(repo, baseTree, path) === undefined;
    const newTree = this.setFileInTree(repo, baseTree, path, blobOid);
    const commitOid = this.makeCommit(repo, {
      tree: newTree,
      parents: parentTip === undefined ? [] : [parentTip],
      message,
    });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid, blobOid, isNewFile };
  }

  deleteFileCommit(
    repo: Repo,
    branch: string,
    path: string,
    message: string,
    parentTip: string,
  ): { commitOid: string } | { error: string } {
    const baseTree = this.getCommitInfo(repo, parentTip)?.tree;
    if (baseTree === undefined) return { error: 'branch has no commits' };
    if (this.getBlobAtTree(repo, baseTree, path) === undefined) return { error: 'file does not exist' };
    const newTree = this.deleteFileFromTree(repo, baseTree, path);
    const commitOid = this.makeCommit(repo, { tree: newTree, parents: [parentTip], message });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid };
  }

  // ------------------------------------------------------------------ labels
  createLabel(repo: Repo, name: string, color?: string, description?: string): { label: Label } | { error: string } {
    if (repo.labels.has(name)) return { error: 'Label already exists' };
    const label: Label = {
      id: this.nextLabelId,
      name,
      color: color ?? 'ededed',
      description: description ?? '',
    };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return { label };
  }

  // ------------------------------------------------------------------ issues
  createIssue(
    repo: Repo,
    title: string,
    body: string,
    labelNames: string[],
  ): { issue: Issue } | { error: string } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { error: `Label does not exist: ${name}` };
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: this.nextObjectId,
      number,
      title,
      body,
      state: 'open',
      labelNames: [...labelNames],
      createdAtSec: this.trialNowSec,
      updatedAtSec: this.trialNowSec,
      closedAtSec: null,
      seq: this.nextSeq(),
      comments: [],
    };
    this.nextObjectId += 1;
    repo.issues.set(number, issue);
    return { issue };
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = {
      id: this.nextCommentId,
      body,
      createdAtSec: this.trialNowSec,
      updatedAtSec: this.trialNowSec,
    };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------- pulls
  createPull(
    repo: Repo,
    title: string,
    head: string,
    base: string,
    body: string,
  ): { pull: Pull } | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined) return { error: `Head branch does not exist: ${head}` };
    if (baseTip === undefined) return { error: `Base branch does not exist: ${base}` };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return { error: 'A pull request already exists for these branches' };
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      id: this.nextObjectId,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAtSec: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      createdAtSec: this.trialNowSec,
      updatedAtSec: this.trialNowSec,
      seq: this.nextSeq(),
    };
    this.nextObjectId += 1;
    repo.pulls.set(number, pull);
    return { pull };
  }

  // ------------------------------------------------------------------- merges
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stack: string[] = [];
    const aCommit = this.resolveCommit(repo, a);
    if (aCommit !== undefined) stack.push(aCommit);
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (ancestorsA.has(cur)) continue;
      ancestorsA.add(cur);
      for (const parent of this.parentsOf(repo, cur)) {
        const pc = this.resolveCommit(repo, parent);
        if (pc !== undefined) stack.push(pc);
      }
    }
    const seen = new Set<string>();
    const queue: string[] = [];
    let head = 0;
    const bCommit = this.resolveCommit(repo, b);
    if (bCommit !== undefined) queue.push(bCommit);
    while (head < queue.length) {
      const cur = queue[head] as string;
      head += 1;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (ancestorsA.has(cur)) return cur;
      for (const parent of this.parentsOf(repo, cur)) {
        const pc = this.resolveCommit(repo, parent);
        if (pc !== undefined) queue.push(pc);
      }
    }
    return null;
  }

  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): DiffEntry[] {
    const base = baseTreeOid === null ? new Map<string, { mode: string; oid: string }>() : this.flattenTree(repo, baseTreeOid);
    const head = headTreeOid === null ? new Map<string, { mode: string; oid: string }>() : this.flattenTree(repo, headTreeOid);
    const out: DiffEntry[] = [];
    for (const [path, b] of base) {
      const h = head.get(path);
      if (h === undefined) out.push({ path, status: 'removed', mode: b.mode, oldOid: b.oid });
      else if (h.oid !== b.oid) out.push({ path, status: 'modified', mode: h.mode, oldOid: b.oid, newOid: h.oid });
    }
    for (const [path, h] of head) {
      if (!base.has(path)) out.push({ path, status: 'added', mode: h.mode, newOid: h.oid });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /**
   * Three-way merge analysis of `headTip` into `baseTip`. Returns whether
   * the merge is clean and, when it is, the tree the merge would produce.
   */
  threeWay(repo: Repo, baseTip: string, headTip: string): {
    mergeable: boolean;
    conflicts: string[];
    mergedTreeOid: string | null;
    headChanges: DiffEntry[];
  } {
    const baseInfo = this.getCommitInfo(repo, baseTip);
    const headInfo = this.getCommitInfo(repo, headTip);
    const mb = this.mergeBase(repo, headTip, baseTip);
    const mbTree = mb === null ? null : (this.getCommitInfo(repo, mb)?.tree ?? null);
    const headChanges = this.diffTrees(repo, mbTree, headInfo?.tree ?? null);
    const baseChanges = this.diffTrees(repo, mbTree, baseInfo?.tree ?? null);
    const baseByPath = new Map(baseChanges.map((c) => [c.path, c]));
    const conflicts: string[] = [];
    for (const hc of headChanges) {
      const bc = baseByPath.get(hc.path);
      if (bc === undefined) continue;
      const headResult = hc.status === 'removed' ? null : hc.newOid;
      const baseResult = bc.status === 'removed' ? null : bc.newOid;
      if (headResult !== baseResult) conflicts.push(hc.path);
    }
    let mergedTreeOid: string | null = null;
    if (conflicts.length === 0) {
      const flat = baseInfo === undefined ? new Map<string, { mode: string; oid: string }>() : this.flattenTree(repo, baseInfo.tree);
      for (const hc of headChanges) {
        if (hc.status === 'removed') flat.delete(hc.path);
        else if (hc.newOid !== undefined) flat.set(hc.path, { mode: hc.mode, oid: hc.newOid });
      }
      mergedTreeOid = this.buildTreeFromFlat(repo, flat);
    }
    return { mergeable: conflicts.length === 0, conflicts, mergedTreeOid, headChanges };
  }

  /**
   * Squash-merge an open pull request onto its base branch. Creates one
   * commit (parent = base tip, tree = merged tree, message = PR title).
   */
  squashMerge(repo: Repo, pull: Pull): { sha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'Pull request is already closed' };
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined) return { error: 'Head branch does not exist' };
    if (baseTip === undefined) return { error: 'Base branch does not exist' };
    const analysis = this.threeWay(repo, baseTip, headTip);
    if (!analysis.mergeable || analysis.mergedTreeOid === null) {
      return { error: `Merge conflict in: ${analysis.conflicts.join(', ')}` };
    }
    const sha = this.makeCommit(repo, {
      tree: analysis.mergedTreeOid,
      parents: [baseTip],
      message: pull.title,
    });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAtSec = this.trialNowSec;
    pull.mergeCommitSha = sha;
    pull.updatedAtSec = this.trialNowSec;
    return { sha };
  }

  /** Mergeable state for a pull request, computed on read. */
  mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.merged) return 'MERGEABLE';
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    return this.threeWay(repo, baseTip, headTip).mergeable ? 'MERGEABLE' : 'CONFLICTING';
  }
}
