/**
 * gitproto.ts — low-level git protocol primitives.
 *
 * Pure functions over Buffers: object hashing, tree/commit/tag encoding,
 * pkt-line framing, and packfile read/write. No I/O, no store access.
 * Only Node's stdlib (crypto, zlib) is used.
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  timestampSec: number;
  message: string;
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  taggerName: string;
  taggerEmail: string;
  timestampSec: number;
  message: string;
}

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of `<type> <size>\0<data>`. */
export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function makeObject(type: ObjType, data: Buffer): { oid: string; obj: GitObject } {
  return { oid: objectId(type, data), obj: { type, data } };
}

/** Git tree ordering: names compare byte-wise, directories as name + '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('malformed tree: missing mode separator');
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) throw new Error('malformed tree: missing name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function identLine(role: string, name: string, email: string, timestampSec: number): string {
  return `${role} ${name} <${email}> ${timestampSec} +0000\n`;
}

export function buildCommit(info: CommitInfo): Buffer {
  let header = `tree ${info.tree}\n`;
  for (const parent of info.parents) header += `parent ${parent}\n`;
  header += identLine('author', info.authorName, info.authorEmail, info.timestampSec);
  header += identLine('committer', info.committerName, info.committerEmail, info.timestampSec);
  const message = info.message.endsWith('\n') ? info.message : `${info.message}\n`;
  return Buffer.from(`${header}\n${message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  const info: CommitInfo = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    committerName: '',
    committerEmail: '',
    timestampSec: 0,
    message: message.replace(/\n$/, ''),
  };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ') || line.startsWith('committer ')) {
      const role = line.startsWith('author ') ? 'author' : 'committer';
      const rest = line.slice(role.length + 1);
      const lt = rest.lastIndexOf('<');
      const gt = rest.lastIndexOf('>');
      const name = lt > 0 ? rest.slice(0, lt).trim() : rest;
      const email = lt !== -1 && gt > lt ? rest.slice(lt + 1, gt) : '';
      const tail = gt !== -1 ? rest.slice(gt + 1).trim().split(' ') : [];
      const ts = tail.length > 0 ? Number.parseInt(tail[0], 10) : 0;
      if (role === 'author') {
        info.authorName = name;
        info.authorEmail = email;
        info.timestampSec = Number.isFinite(ts) ? ts : 0;
      } else {
        info.committerName = name;
        info.committerEmail = email;
      }
    }
  }
  return info;
}

export function buildTag(info: TagInfo): Buffer {
  let header = `object ${info.object}\ntype ${info.type}\ntag ${info.tag}\n`;
  header += identLine('tagger', info.taggerName, info.taggerEmail, info.timestampSec);
  const message = info.message.endsWith('\n') ? info.message : `${info.message}\n`;
  return Buffer.from(`${header}\n${message}`, 'utf8');
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  const info: TagInfo = {
    object: '',
    type: 'commit',
    tag: '',
    taggerName: '',
    taggerEmail: '',
    timestampSec: 0,
    message: message.replace(/\n$/, ''),
  };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) {
      const rest = line.slice(7);
      const lt = rest.lastIndexOf('<');
      const gt = rest.lastIndexOf('>');
      info.taggerName = lt > 0 ? rest.slice(0, lt).trim() : rest;
      info.taggerEmail = lt !== -1 && gt > lt ? rest.slice(lt + 1, gt) : '';
      const tail = gt !== -1 ? rest.slice(gt + 1).trim().split(' ') : [];
      const ts = tail.length > 0 ? Number.parseInt(tail[0], 10) : 0;
      info.timestampSec = Number.isFinite(ts) ? ts : 0;
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// pkt-line framing (git protocol v0/v2 transport)
// ---------------------------------------------------------------------------

export const PKT_FLUSH = '0000';
export const PKT_DELIM = '0001';
export const PKT_RESPONSE_END = '0002';
export const PKT_LINE_MAX = 65520;

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > PKT_LINE_MAX) throw new Error('pkt-line payload too large');
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from(PKT_FLUSH, 'utf8');
}

export function pktDelim(): Buffer {
  return Buffer.from(PKT_DELIM, 'utf8');
}

export interface PktParsedLine {
  kind: 'data' | 'flush' | 'delim' | 'responseEnd';
  data: Buffer;
}

export interface PktParseResult {
  lines: PktParsedLine[];
  next: number;
  error?: string;
}

/**
 * Parse pkt-lines from `buf` starting at `offset`. Stops at the first
 * flush/delim/response-end marker or at the end of the buffer, and returns
 * the offset just past the marker (or past the last data line).
 */
export function parsePktLines(buf: Buffer, offset = 0): PktParseResult {
  const lines: PktParsedLine[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const lenHex = buf.subarray(pos, pos + 4).toString('utf8');
    const len = Number.parseInt(lenHex, 16);
    if (!Number.isFinite(len)) return { lines, next: pos, error: `invalid pkt-line length ${JSON.stringify(lenHex)}` };
    if (len === 0) return { lines: [...lines, { kind: 'flush', data: Buffer.alloc(0) }], next: pos + 4 };
    if (len === 1) return { lines: [...lines, { kind: 'delim', data: Buffer.alloc(0) }], next: pos + 4 };
    if (len === 2) return { lines: [...lines, { kind: 'responseEnd', data: Buffer.alloc(0) }], next: pos + 4 };
    if (len < 4) return { lines, next: pos, error: `pkt-line length too small: ${len}` };
    if (pos + len > buf.length) return { lines, next: pos, error: 'truncated pkt-line' };
    lines.push({ kind: 'data', data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { lines, next: pos };
}

// ---------------------------------------------------------------------------
// packfiles (plain objects only; deltas are rejected cleanly)
// ---------------------------------------------------------------------------

function encodeObjectHeader(type: ObjType, size: number): Buffer {
  const typeNum = TYPE_NUM[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (remaining & 0x0f) | (typeNum << 4);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let b = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a version-2 packfile with plain (undeltified) objects. */
export function writePack(entries: Array<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  const sorted = [...entries].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const entry of sorted) {
    parts.push(encodeObjectHeader(entry.type, entry.data.length));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

export interface PackReadResult {
  entries: Map<string, GitObject>;
  error?: string;
}

/** Read a packfile. Deltified entries are rejected with a clean error. */
export function readPack(buf: Buffer): PackReadResult {
  const entries = new Map<string, GitObject>();
  if (buf.length < 32) return { entries, error: 'pack too short' };
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') return { entries, error: 'not a packfile' };
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return { entries, error: `unsupported pack version ${version}` };
  const count = buf.readUInt32BE(8);
  let pos = 12;
  for (let i = 0; i < count; i++) {
    if (pos >= buf.length) return { entries, error: 'truncated pack entry' };
    // Object header varint: type in bits 4-6 of the first byte, size in
    // bits 0-3 then 7 bits per following byte (MSB = continuation).
    let byte = buf[pos];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    pos += 1;
    while ((byte & 0x80) !== 0) {
      if (pos >= buf.length) return { entries, error: 'truncated pack object header' };
      byte = buf[pos];
      size |= (byte & 0x7f) << shift;
      shift += 7;
      pos += 1;
    }
    if (typeNum === 6 || typeNum === 7) {
      return { entries, error: 'deltified pack entries are not supported' };
    }
    const type = NUM_TYPE[typeNum];
    if (type === undefined) return { entries, error: `unknown pack object type ${typeNum}` };
    let inflated: Buffer;
    let consumed: number;
    try {
      const out = inflateSync(buf.subarray(pos), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten?: number };
      };
      inflated = out.buffer;
      consumed = out.engine?.bytesWritten ?? 0;
    } catch (err) {
      return { entries, error: `pack inflate failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (consumed <= 0) return { entries, error: 'pack inflate consumed no bytes' };
    if (inflated.length !== size) return { entries, error: `pack object size mismatch (expected ${size}, got ${inflated.length})` };
    const { oid, obj } = makeObject(type, inflated);
    entries.set(oid, obj);
    pos += consumed;
  }
  if (pos + 20 <= buf.length) {
    const trailer = buf.subarray(pos, pos + 20).toString('hex');
    const actual = sha1Hex(buf.subarray(0, pos));
    if (trailer !== actual) return { entries, error: 'pack checksum mismatch' };
  }
  return { entries };
}
