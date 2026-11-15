/**
 * git.ts — git smart HTTP (upload-pack v2/v0, receive-pack v0).
 *
 * The forge speaks the wire protocol the kit's git-client expects:
 *  - v2 advertisement with `fetch` + `ls-refs` + `object-format=sha1`
 *  - v2 ls-refs (peel / symrefs / unborn / ref-prefix, server-side filter)
 *  - v2 fetch (ACK/NAK + ready, shallow/unshallow, wanted-refs, sideband
 *    packfile; no packfile section at all when 0 objects are due)
 *  - v0 fetch (bare NAK/ACK/shallow lines + sideband pack)
 *  - v0 receive-pack (report-status-v2, sideband report, fast-forward
 *    enforcement, objects stored even for refused refs)
 * Packs are version 2, plain (0 deltas), trailer SHA-1 verified on read.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  pktDelim,
  pktFlush,
  pktLine,
  parsePktLines,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitproto.ts';
import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';
import { readBody, reply, sendJsonError, type Ctx, type ParsedUrl } from './http.ts';

const AGENT = 'makefun-git-forge/1.0';
const UPLOAD_V2_CAPS = ['agent=' + AGENT, 'ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1'];
const UPLOAD_V0_CAPS = [
  'symref=HEAD:refs/heads/main',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'multi_ack',
  'multi_ack_detailed',
  'shallow',
  'agent=' + AGENT,
];
const RECEIVE_CAPS = [
  'report-status',
  'report-status-v2',
  'side-band-64k',
  'ofs-delta',
  'delete-refs',
  'symref=HEAD:refs/heads/main',
  'agent=' + AGENT,
];
const CT_UPLOAD_ADV = 'application/x-git-upload-pack-advertisement';
const CT_RECEIVE_ADV = 'application/x-git-receive-pack-advertisement';
const CT_UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const CT_RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** A sideband packet: 1 band byte + data, framed as one pkt-line. */
function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

function sidebandPackets(band: 1 | 2, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < data.length; i += CHUNK) {
    out.push(sidebandPacket(band, data.subarray(i, Math.min(data.length, i + CHUNK))));
  }
  return out;
}

/** The peeled commit of an annotated tag ref, or undefined. */
function peeledCommit(store: Store, repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  return store.resolveCommit(repo, oid);
}

function isAnnotatedTag(repo: Repo, oid: string): boolean {
  const obj = repo.objects.get(oid);
  return obj !== undefined && obj.type === 'tag';
}

/** v0 advertisement ref lines (HEAD first, then refs, peeled tags after). */
function v0RefLines(store: Store, repo: Repo, caps: string[]): Buffer[] {
  const lines: Buffer[] = [];
  const capText = caps.join(' ');
  const defaultTip = repo.refs.get('refs/heads/main');
  const refs = store.listRefs(repo);
  if (defaultTip === undefined) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capText}\n`));
    return lines;
  }
  lines.push(pktLine(`${defaultTip} HEAD\0${capText}\n`));
  for (const { name, oid } of refs) {
    lines.push(pktLine(`${oid} ${name}\n`));
    if (isAnnotatedTag(repo, oid)) {
      const peeled = peeledCommit(store, repo, oid);
      if (peeled !== undefined) lines.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  return lines;
}

// ------------------------------------------------------------------ info/refs
async function infoRefs(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string | undefined,
): Promise<void> {
  const repo = owner === VIEWER_LOGIN ? ctx.store.getRepo(repoName) : undefined;
  if (repo === undefined) {
    sendJsonError(ctx, res, 404, 'Not Found');
    return;
  }
  if (service === 'git-upload-pack') {
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush()];
    if (isV2) {
      parts.push(pktLine('version 2\n'));
      for (const cap of UPLOAD_V2_CAPS) parts.push(pktLine(`${cap}\n`));
      parts.push(pktFlush());
    } else {
      parts.push(...v0RefLines(ctx.store, repo, UPLOAD_V0_CAPS));
      parts.push(pktFlush());
    }
    reply(ctx, res, 200, CT_UPLOAD_ADV, Buffer.concat(parts));
    return;
  }
  if (service === 'git-receive-pack') {
    const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
    parts.push(...v0RefLines(ctx.store, repo, RECEIVE_CAPS));
    parts.push(pktFlush());
    reply(ctx, res, 200, CT_RECEIVE_ADV, Buffer.concat(parts));
    return;
  }
  sendJsonError(ctx, res, 400, `Unknown service: ${service ?? ''}`);
}

// ------------------------------------------------------------------- ls-refs
function handleLsRefs(ctx: Ctx, res: ServerResponse, repo: Repo, args: string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const lines: Buffer[] = [];
  const defaultTip = repo.refs.get('refs/heads/main');
  const hasCommits = defaultTip !== undefined;
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (!hasCommits) {
    if (unborn && matches('HEAD')) {
      lines.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  } else {
    if (prefixes.length === 0) {
      let headLine = `${defaultTip} HEAD`;
      if (symrefs) headLine += ' symref-target:refs/heads/main';
      lines.push(pktLine(`${headLine}\n`));
    }
    for (const { name, oid } of ctx.store.listRefs(repo)) {
      if (!matches(name)) continue;
      let line = `${oid} ${name}`;
      if (peel && isAnnotatedTag(repo, oid)) {
        const peeled = peeledCommit(ctx.store, repo, oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
      lines.push(pktLine(`${line}\n`));
    }
  }
  lines.push(pktFlush());
  reply(ctx, res, 200, CT_UPLOAD_RESULT, Buffer.concat(lines));
}

// ---------------------------------------------------------------------- fetch
interface FetchPlan {
  acks: string[];
  shallow: string[];
  unshallow: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
  objects: Map<string, GitObject>;
}

function planFetch(
  store: Store,
  repo: Repo,
  opts: {
    wants: string[];
    haves: string[];
    shallow: string[];
    deepen?: number;
    deepenSince?: number;
    deepenNot?: string[];
  },
): FetchPlan {
  const wantCommits: string[] = [];
  for (const want of opts.wants) {
    const c = store.resolveCommit(repo, want);
    if (c !== undefined) wantCommits.push(c);
  }
  // Commits excluded by deepen-not (reachable from the named refs).
  const excluded = new Set<string>();
  for (const ref of opts.deepenNot ?? []) {
    const tip = repo.refs.get(ref);
    if (tip === undefined) continue;
    const walk = store.walkCommits(repo, [tip]);
    for (const c of walk.included) excluded.add(c);
  }
  // Included commits: BFS from the wants, honouring the depth limit and
  // the time cutoff. Boundary commits stay in the pack (git's deepen rule).
  const included: string[] = [];
  const depth = new Map<string, number>();
  const queue: Array<{ oid: string; d: number }> = [];
  for (const w of wantCommits) {
    if (!depth.has(w)) {
      depth.set(w, 1);
      queue.push({ oid: w, d: 1 });
    }
  }
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const { oid, d } = queue.shift() as { oid: string; d: number };
    if (excluded.has(oid)) continue;
    included.push(oid);
    const info = store.getCommitInfo(repo, oid);
    const isBoundary =
      (opts.deepen !== undefined && d >= opts.deepen) ||
      (opts.deepenSince !== undefined && info !== undefined && info.timestampSec <= opts.deepenSince);
    if (isBoundary) {
      boundary.add(oid);
      continue;
    }
    for (const parent of store.parentsOf(repo, oid)) {
      const pc = store.resolveCommit(repo, parent);
      if (pc === undefined || depth.has(pc) || excluded.has(pc)) continue;
      depth.set(pc, d + 1);
      queue.push({ oid: pc, d: d + 1 });
    }
  }
  const includedSet = new Set(included);
  const newShallow = [...boundary].filter((oid) => includedSet.has(oid));
  // Unshallow: old boundary commits now fully present (all parents included).
  const unshallow: string[] = [];
  for (const s of opts.shallow) {
    const sc = store.resolveCommit(repo, s);
    if (sc === undefined || !includedSet.has(sc)) continue;
    const parents = store.parentsOf(repo, sc);
    if (parents.every((p) => includedSet.has(store.resolveCommit(repo, p) ?? ''))) unshallow.push(s);
  }
  // ACKs: haves reachable from the wants, newest first (BFS order).
  // With no haves there can be no ACK: skip the (full-history) walk.
  const acks: string[] = [];
  if (opts.haves.length > 0) {
    const reachable = store.walkCommits(repo, wantCommits);
    const reachableSet = new Set(reachable.included);
    const orderIdx = new Map(reachable.included.map((oid, i) => [oid, i]));
    for (const have of opts.haves) {
      const hc = store.resolveCommit(repo, have);
      if (hc !== undefined && reachableSet.has(hc)) acks.push(have);
    }
    acks.sort((a, b) => {
      const ai = orderIdx.get(store.resolveCommit(repo, a) ?? '') ?? Number.MAX_SAFE_INTEGER;
      const bi = orderIdx.get(store.resolveCommit(repo, b) ?? '') ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  }
  // Excluded objects: reachable from the haves, never descending past an
  // old shallow boundary (its own tree/blob closure IS excluded). The
  // walk already returns every ancestor, so collectObjects must not
  // re-walk parents. A tag the client already has is excluded too.
  const stopAt = new Set<string>();
  for (const s of opts.shallow) {
    const sc = store.resolveCommit(repo, s);
    if (sc !== undefined) stopAt.add(sc);
  }
  const haveWalk = store.walkCommits(repo, opts.haves, { stopAt });
  const excludedObjects = store.collectObjects(repo, haveWalk.included);
  for (const have of opts.haves) {
    const obj = repo.objects.get(have);
    if (obj !== undefined && obj.type === 'tag') excludedObjects.set(have, obj);
  }
  const allObjects = store.collectObjects(repo, included);
  const objects = new Map<string, GitObject>();
  for (const [oid, obj] of allObjects) {
    if (!excludedObjects.has(oid)) objects.set(oid, obj);
  }
  // A wanted tag object is packed itself (its target commit is already in
  // the included set); without this, an annotated tag never reaches a clone.
  for (const want of opts.wants) {
    const obj = repo.objects.get(want);
    if (obj !== undefined && obj.type === 'tag' && !excludedObjects.has(want)) {
      objects.set(want, obj);
    }
  }
  // Wanted refs: refs whose tip is one of the wants.
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const { name, oid } of store.listRefs(repo)) {
    if (opts.wants.includes(oid)) wantedRefs.push({ oid, ref: name });
  }
  return { acks, shallow: newShallow, unshallow, wantedRefs, objects };
}

function packBuffer(objects: Map<string, GitObject>): Buffer {
  const entries = [...objects.entries()].map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data }));
  return writePack(entries);
}

function handleFetchV2(
  ctx: Ctx,
  res: ServerResponse,
  repo: Repo,
  args: string[],
): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  let deepenSince: number | undefined;
  const deepenNot: string[] = [];
  let noProgress = false;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) deepen = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('deepen-since ')) deepenSince = Number.parseInt(arg.slice(13), 10);
    else if (arg.startsWith('deepen-not ')) deepenNot.push(arg.slice(11).trim());
    else if (arg === 'no-progress') noProgress = true;
    else if (arg === 'done') done = true;
  }
  if (wants.length === 0) {
    sendJsonError(ctx, res, 400, 'fetch requires at least one want');
    return;
  }
  for (const want of wants) {
    if (ctx.store.resolveCommit(repo, want) === undefined) {
      sendJsonError(ctx, res, 400, `want object not found: ${want}`);
      return;
    }
  }
  const plan = planFetch(ctx.store, repo, { wants, haves, shallow, deepen, deepenSince, deepenNot });
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  if (done) parts.push(pktLine('ready\n'));
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  if (plan.wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const w of plan.wantedRefs) parts.push(pktLine(`${w.oid} ${w.ref}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.size > 0) {
    parts.push(pktLine('packfile\n'));
    if (!noProgress) {
      parts.push(sidebandPacket(2, Buffer.from(`Counting objects: ${plan.objects.size}, done.\n`, 'utf8')));
    }
    parts.push(...sidebandPackets(1, packBuffer(plan.objects)));
    parts.push(pktFlush());
  } else {
    parts.push(pktFlush());
  }
  reply(ctx, res, 200, CT_UPLOAD_RESULT, Buffer.concat(parts));
}

function handleFetchV0(
  ctx: Ctx,
  res: ServerResponse,
  repo: Repo,
  body: Buffer,
): void {
  // Section 1 (until flush): wants + shallow/deepen. Section 2: haves + done.
  const first = parsePktLines(body, 0);
  if (first.error !== undefined) {
    sendJsonError(ctx, res, 400, first.error);
    return;
  }
  const wants: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  let deepenSince: number | undefined;
  const deepenNot: string[] = [];
  let noProgress = false;
  for (const line of first.lines) {
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const parts = text.split(' ');
      wants.push(parts[1]);
      if (parts.includes('no-progress')) noProgress = true;
    } else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) deepen = Number.parseInt(text.slice(7), 10);
    else if (text.startsWith('deepen-since ')) deepenSince = Number.parseInt(text.slice(13), 10);
    else if (text.startsWith('deepen-not ')) deepenNot.push(text.slice(11).trim());
  }
  const second = parsePktLines(body, first.next);
  if (second.error !== undefined) {
    sendJsonError(ctx, res, 400, second.error);
    return;
  }
  const haves: string[] = [];
  for (const line of second.lines) {
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('have ')) haves.push(text.slice(5).trim());
  }
  if (wants.length === 0) {
    sendJsonError(ctx, res, 400, 'fetch requires at least one want');
    return;
  }
  for (const want of wants) {
    if (ctx.store.resolveCommit(repo, want) === undefined) {
      sendJsonError(ctx, res, 400, `want object not found: ${want}`);
      return;
    }
  }
  const plan = planFetch(ctx.store, repo, { wants, haves, shallow, deepen, deepenSince, deepenNot });
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  if (plan.objects.size > 0) {
    if (!noProgress) {
      parts.push(sidebandPacket(2, Buffer.from(`Counting objects: ${plan.objects.size}, done.\n`, 'utf8')));
    }
    parts.push(...sidebandPackets(1, packBuffer(plan.objects)));
  }
  parts.push(pktFlush());
  reply(ctx, res, 200, CT_UPLOAD_RESULT, Buffer.concat(parts));
}

/** Parse a v2 request body: data lines across delim-separated sections, until flush. */
function parseV2RequestLines(body: Buffer): { lines: string[]; error?: string } {
  const lines: string[] = [];
  let pos = 0;
  while (pos < body.length) {
    const parsed = parsePktLines(body, pos);
    if (parsed.error !== undefined) return { lines, error: parsed.error };
    if (parsed.lines.length === 0) break;
    let terminated = false;
    for (const line of parsed.lines) {
      if (line.kind === 'data') {
        lines.push(line.data.toString('utf8').replace(/\n$/, ''));
      } else if (line.kind === 'flush') {
        terminated = true;
      }
      // A delim is only a section separator: keep reading the next section.
    }
    pos = parsed.next;
    if (terminated) break;
  }
  return { lines };
}

async function handleUploadPack(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2) {
    const parsed = parseV2RequestLines(body);
    if (parsed.error !== undefined) {
      sendJsonError(ctx, res, 400, parsed.error);
      return;
    }
    const dataLines = parsed.lines;
    if (dataLines.length === 0 || !dataLines[0].startsWith('command=')) {
      sendJsonError(ctx, res, 400, 'missing command');
      return;
    }
    const command = dataLines[0].slice('command='.length);
    const args = dataLines.slice(1);
    if (command === 'ls-refs') {
      handleLsRefs(ctx, res, repo, args);
      return;
    }
    if (command === 'fetch') {
      handleFetchV2(ctx, res, repo, args);
      return;
    }
    sendJsonError(ctx, res, 400, `Unknown command: ${command}`);
    return;
  }
  handleFetchV0(ctx, res, repo, body);
}

// ---------------------------------------------------------------- receive-pack
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  const parsed = parsePktLines(body, 0);
  if (parsed.error !== undefined) {
    sendJsonError(ctx, res, 400, parsed.error);
    return;
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const line of parsed.lines) {
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8');
    const nul = text.indexOf('\0');
    const commandText = (nul === -1 ? text : text.slice(0, nul)).replace(/\n$/, '');
    if (nul !== -1) {
      const caps = text.slice(nul + 1).replace(/\n$/, '').split(' ');
      if (caps.includes('side-band-64k')) sideband = true;
    }
    const parts = commandText.split(' ');
    if (parts.length < 3) {
      sendJsonError(ctx, res, 400, `bad receive-pack command: ${JSON.stringify(commandText)}`);
      return;
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) {
    sendJsonError(ctx, res, 400, 'receive-pack requires at least one command');
    return;
  }
  // The pack follows the command flush (raw bytes, not pkt-lined).
  const packBytes = body.subarray(parsed.next);
  const needsObjects = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    const read = readPack(packBytes);
    if (read.error !== undefined) {
      unpackOk = false;
      unpackDetail = read.error;
    } else {
      // Store every pack object, even for refs that will be refused.
      ctx.store.putObjects(repo, read.entries);
    }
  } else if (needsObjects) {
    unpackOk = false;
    unpackDetail = 'missing pack';
  }
  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  if (unpackOk) {
    for (const cmd of commands) {
      const result = applyPushCommand(ctx.store, repo, cmd);
      if (result.ok) reportLines.push(`ok ${cmd.ref}\n`);
      else reportLines.push(`ng ${cmd.ref} ${result.reason}\n`);
    }
  }
  const reportPktLines = Buffer.concat(reportLines.map((l) => pktLine(l)));
  const parts: Buffer[] = [];
  if (sideband) {
    parts.push(...sidebandPackets(1, reportPktLines));
  } else {
    parts.push(reportPktLines);
  }
  parts.push(pktFlush());
  reply(ctx, res, 200, CT_RECEIVE_RESULT, Buffer.concat(parts));
}

function applyPushCommand(store: Store, repo: Repo, cmd: PushCommand): { ok: boolean; reason?: string } {
  if (!cmd.ref.startsWith('refs/')) return { ok: false, reason: 'invalid ref' };
  const current = repo.refs.get(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(cmd.ref);
    return { ok: true };
  }
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    if (!repo.objects.has(cmd.newOid)) return { ok: false, reason: 'object not found' };
    if (cmd.ref.startsWith('refs/heads/') && store.resolveCommit(repo, cmd.newOid) === undefined) {
      return { ok: false, reason: 'object not found' };
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ok: true };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
  if (cmd.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (!repo.objects.has(cmd.newOid)) return { ok: false, reason: 'object not found' };
  if (cmd.ref.startsWith('refs/heads/')) {
    const newCommit = store.resolveCommit(repo, cmd.newOid);
    if (newCommit === undefined) return { ok: false, reason: 'object not found' };
    if (newCommit !== current) {
      // Fast-forward only: the old tip must be an ancestor of the new tip.
      const walk = store.walkCommits(repo, [newCommit]);
      if (!walk.included.includes(current)) return { ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ok: true };
}

// --------------------------------------------------------------------- routing
export async function handleGit(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: ParsedUrl,
): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(url.path);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const rest = match[3];
  const repo = owner === VIEWER_LOGIN ? ctx.store.getRepo(repoName) : undefined;
  if (rest === 'info/refs') {
    await infoRefs(ctx, req, res, owner, repoName, url.query.get('service'));
    return true;
  }
  if (repo === undefined) {
    sendJsonError(ctx, res, 404, 'Not Found');
    return true;
  }
  if (rest === 'git-upload-pack') {
    await handleUploadPack(ctx, req, res, repo);
    return true;
  }
  if (rest === 'git-receive-pack') {
    await handleReceivePack(ctx, req, res, repo);
    return true;
  }
  sendJsonError(ctx, res, 404, 'Not Found');
  return true;
}
