/**
 * graphql.ts — GraphQL v4 for the forge.
 *
 * A small hand-written parser (lexer + recursive descent) and executor for
 * the subset the suite sends: queries, mutations, variables, aliases,
 * inline fragments, __type introspection, and batched arrays. No library.
 * Every resolver reads the same shared Store as REST and git.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commentGlobalId,
  decodeGlobalId,
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
import { isAuthed, readBody, sendJson, sendJsonError, type Ctx } from './http.ts';

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

// ------------------------------------------------------------------- tokenizer
type TokenType =
  | 'braceL' | 'braceR' | 'parenL' | 'parenR' | 'bracketL' | 'bracketR'
  | 'colon' | 'dollar' | 'bang' | 'equals' | 'at' | 'spread'
  | 'name' | 'string' | 'int' | 'float';

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (ch === '{') { tokens.push({ type: 'braceL', value: '{' }); i += 1; continue; }
    if (ch === '}') { tokens.push({ type: 'braceR', value: '}' }); i += 1; continue; }
    if (ch === '(') { tokens.push({ type: 'parenL', value: '(' }); i += 1; continue; }
    if (ch === ')') { tokens.push({ type: 'parenR', value: ')' }); i += 1; continue; }
    if (ch === '[') { tokens.push({ type: 'bracketL', value: '[' }); i += 1; continue; }
    if (ch === ']') { tokens.push({ type: 'bracketR', value: ']' }); i += 1; continue; }
    if (ch === ':') { tokens.push({ type: 'colon', value: ':' }); i += 1; continue; }
    if (ch === '$') { tokens.push({ type: 'dollar', value: '$' }); i += 1; continue; }
    if (ch === '!') { tokens.push({ type: 'bang', value: '!' }); i += 1; continue; }
    if (ch === '=') { tokens.push({ type: 'equals', value: '=' }); i += 1; continue; }
    if (ch === '@') { tokens.push({ type: 'at', value: '@' }); i += 1; continue; }
    if (ch === '.' && input.slice(i, i + 3) === '...') { tokens.push({ type: 'spread', value: '...' }); i += 3; continue; }
    if (ch === '"') {
      // String with escapes; block strings (""") are not used by the suite.
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        const value = end === -1 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ type: 'string', value });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u' && j + 5 < input.length) {
            value += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (j < input.length && input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (j < input.length && (input[j] === 'e' || input[j] === 'E')) {
        isFloat = true;
        j += 1;
        if (j < input.length && (input[j] === '+' || input[j] === '-')) j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j])) j += 1;
      tokens.push({ type: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------- parser
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet?: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition?: string;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: Array<{ name: string; defaultValue?: ValueNode }>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expect(type: TokenType, value?: string): Token {
    const token = this.next();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? type} but got ${token.value}`);
    }
    return token;
  }

  private skipDirectives(): void {
    while (this.peek()?.type === 'at') {
      this.next();
      this.next(); // directive name
      if (this.peek()?.type === 'parenL') this.parseArguments();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.type === 'braceL') {
        operations.push({
          kind: 'query',
          variableDefinitions: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.type === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        let name: string | undefined;
        const nextToken = this.peek();
        if (nextToken?.type === 'name') {
          name = this.next().value;
        }
        const variableDefinitions = this.parseVariableDefinitions();
        const selectionSet = this.parseSelectionSet();
        operations.push({ kind, name, variableDefinitions, selectionSet });
        continue;
      }
      if (token.type === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expect('name').value;
        this.expect('name', 'on');
        this.next(); // type name
        const selectionSet = this.parseSelectionSet();
        fragments.set(name, selectionSet);
        continue;
      }
      throw new Error(`unexpected token ${token.value} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const defs: Array<{ name: string; defaultValue?: ValueNode }> = [];
    if (this.peek()?.type !== 'parenL') return defs;
    this.next();
    while (this.peek()?.type !== 'parenR') {
      this.expect('dollar');
      const name = this.expect('name').value;
      this.expect('colon');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek()?.type === 'equals') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expect('parenR');
    return defs;
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.type === 'bracketL') {
      this.next();
      this.parseType();
      this.expect('bracketR');
    } else {
      this.expect('name');
    }
    if (this.peek()?.type === 'bang') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('braceL');
    const selections: SelectionNode[] = [];
    while (this.peek()?.type !== 'braceR') {
      selections.push(this.parseSelection());
    }
    this.expect('braceR');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek()?.type === 'spread') {
      this.next();
      const token = this.peek();
      if (token?.type === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token?.type === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', selectionSet: this.parseSelectionSet() };
    }
    const first = this.expect('name');
    let alias: string | undefined;
    let name = first.value;
    if (this.peek()?.type === 'colon') {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek()?.type === 'braceL') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.type !== 'parenL') return args;
    this.next();
    while (this.peek()?.type !== 'parenR') {
      const name = this.expect('name').value;
      this.expect('colon');
      const value = this.parseValue();
      args.push({ name, value });
    }
    this.expect('parenR');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.type === 'dollar') {
      return { kind: 'variable', name: this.expect('name').value };
    }
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.type === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.type === 'bracketL') {
      const values: ValueNode[] = [];
      while (this.peek()?.type !== 'bracketR') values.push(this.parseValue());
      this.expect('bracketR');
      return { kind: 'list', values };
    }
    if (token.type === 'braceL') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek()?.type !== 'braceR') {
        const name = this.expect('name').value;
        this.expect('colon');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('braceR');
      return { kind: 'object', fields };
    }
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------- executor
interface GQLContext {
  store: Store;
  errors: Array<{ message: string }>;
}

interface FieldDef {
  type: string;
  list?: boolean;
  resolve: (parent: any, args: Record<string, unknown>, gql: GQLContext) => unknown;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
}

function prop(name: string): FieldDef['resolve'] {
  return (parent: any) => parent[name] ?? null;
}

function userNode(): Record<string, unknown> {
  return {
    __typename: 'User',
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

function repoNode(repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    repo,
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    createdAt: iso(repo.createdAtSec),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    repo,
    issue,
    id: issueGlobalId(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: iso(issue.createdAtSec),
    updatedAt: iso(issue.updatedAtSec),
    closedAt: issue.closedAtSec === null ? null : iso(issue.closedAtSec),
  };
}

function pullNode(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    repo,
    pull,
    id: pullGlobalId(repo, pull),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergedAt: pull.mergedAtSec === null ? null : iso(pull.mergedAtSec),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: store.mergeableState(repo, pull),
    createdAt: iso(pull.createdAtSec),
    updatedAt: iso(pull.updatedAtSec),
  };
}

function commentNode(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    __typename: 'IssueComment',
    repo,
    issue,
    comment,
    id: commentGlobalId(repo, issue, comment),
    databaseId: comment.id,
    body: comment.body,
    createdAt: iso(comment.createdAtSec),
    updatedAt: iso(comment.updatedAtSec),
  };
}

function labelNode(repo: Repo, label: Label): Record<string, unknown> {
  return {
    __typename: 'Label',
    repo,
    label,
    id: String(label.id),
    name: label.name,
    color: label.color,
    description: label.description,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(String(number), 'utf8').toString('base64');
}

function cursorToNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const n = Number.parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function issueConnection(
  store: Store,
  repo: Repo,
  args: Record<string, unknown>,
): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    issues = issues.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const descending = orderBy !== undefined && String(orderBy.direction ?? '').toUpperCase() === 'DESC';
  issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  const after = cursorToNumber(args.after);
  if (after !== null) {
    issues = issues.filter((i) => (descending ? i.number < after : i.number > after));
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, Math.max(0, first));
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueNode(repo, i)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorFor(page[0].number) : null,
      endCursor,
    },
    totalCount: issues.length,
  };
}

function pullConnection(
  store: Store,
  repo: Repo,
  args: Record<string, unknown>,
): Record<string, unknown> {
  let pulls = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    pulls = pulls.filter((p) => wanted.has(p.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const descending = orderBy !== undefined && String(orderBy.direction ?? '').toUpperCase() === 'DESC';
  pulls.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  const after = cursorToNumber(args.after);
  if (after !== null) {
    pulls = pulls.filter((p) => (descending ? p.number < after : p.number > after));
  }
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, Math.max(0, first));
  const hasNextPage = pulls.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => pullNode(store, repo, p)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorFor(page[0].number) : null,
      endCursor,
    },
    totalCount: pulls.length,
  };
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

function nodeById(store: Store, id: unknown): Record<string, unknown> | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const [first, second, third] = decoded.parts;
  if (decoded.type === 'Repository') {
    const repo = findRepoById(store, Number.parseInt(first, 10));
    return repo === undefined ? null : repoNode(repo);
  }
  if (decoded.type === 'Issue') {
    const repo = findRepoById(store, Number.parseInt(first, 10));
    const issue = repo?.issues.get(Number.parseInt(second, 10));
    return repo === undefined || issue === undefined ? null : issueNode(repo, issue);
  }
  if (decoded.type === 'PullRequest') {
    const repo = findRepoById(store, Number.parseInt(first, 10));
    const pull = repo?.pulls.get(Number.parseInt(second, 10));
    return repo === undefined || pull === undefined ? null : pullNode(store, repo, pull);
  }
  if (decoded.type === 'IssueComment') {
    const repo = findRepoById(store, Number.parseInt(first, 10));
    const issue = repo?.issues.get(Number.parseInt(second, 10));
    const comment = issue?.comments.find((c) => c.id === Number.parseInt(third, 10));
    return repo === undefined || issue === undefined || comment === undefined
      ? null
      : commentNode(repo, issue, comment);
  }
  return null;
}

// Schema field lists (for __type introspection).
const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt'],
  SearchType: [],
};
const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function typeInfoNode(name: string): Record<string, unknown> | null {
  const fields = SCHEMA_FIELDS[name];
  const enumValues = SCHEMA_ENUMS[name];
  if (fields === undefined && enumValues === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
    description: null,
    fields: (fields ?? []).map((f) => ({ __typename: '__Field', name: f, description: null })),
    enumValues: (enumValues ?? []).map((v) => ({ __typename: '__EnumValue', name: v, description: null })),
  };
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User', resolve: () => userNode() },
      repository: {
        type: 'Repository',
        resolve: (_parent, args, gql) => {
          const owner = args.owner as string | undefined;
          const name = args.name as string | undefined;
          if (owner !== VIEWER_LOGIN || typeof name !== 'string') return null;
          const repo = gql.store.getRepo(name);
          return repo === undefined ? null : repoNode(repo);
        },
      },
      node: {
        type: 'Node',
        resolve: (_parent, args, gql) => nodeById(gql.store, args.id),
      },
      __type: {
        type: '__Type',
        resolve: (_parent, args) => typeInfoNode(args.name as string),
      },
      __schema: {
        type: '__Schema',
        resolve: () => ({ __typename: '__Schema', description: null }),
      },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      login: { type: 'String', resolve: prop('login') },
      id: { type: 'Int', resolve: prop('id') },
      name: { type: 'String', resolve: prop('name') },
      email: { type: 'String', resolve: prop('email') },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: prop('id') },
      databaseId: { type: 'Int', resolve: prop('databaseId') },
      name: { type: 'String', resolve: prop('name') },
      nameWithOwner: { type: 'String', resolve: prop('nameWithOwner') },
      description: { type: 'String', resolve: prop('description') },
      createdAt: { type: 'String', resolve: prop('createdAt') },
      owner: { type: 'User', resolve: () => userNode() },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (parent) => {
          const repo = (parent as { repo: Repo }).repo;
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch, target: { oid: tip } };
        },
      },
      viewerPermission: { type: 'RepositoryPermission', resolve: prop('viewerPermission') },
      hasIssuesEnabled: { type: 'Boolean', resolve: prop('hasIssuesEnabled') },
      issue: {
        type: 'Issue',
        resolve: (parent, args) => {
          const repo = (parent as { repo: Repo }).repo;
          const issue = repo.issues.get(args.number as number);
          return issue === undefined ? null : issueNode(repo, issue);
        },
      },
      issues: {
        type: 'IssueConnection',
        resolve: (parent, args, gql) => issueConnection(gql.store, (parent as { repo: Repo }).repo, args),
      },
      pullRequests: {
        type: 'PullRequestConnection',
        resolve: (parent, args, gql) => pullConnection(gql.store, (parent as { repo: Repo }).repo, args),
      },
      pullRequest: {
        type: 'PullRequest',
        resolve: (parent, args, gql) => {
          const repo = (parent as { repo: Repo }).repo;
          const pull = repo.pulls.get(args.number as number);
          return pull === undefined ? null : pullNode(gql.store, repo, pull);
        },
      },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: prop('name') },
      target: { type: 'GitObject', resolve: prop('target') },
    },
  },
  GitObject: {
    kind: 'OBJECT',
    fields: {
      oid: { type: 'String', resolve: prop('oid') },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: prop('id') },
      databaseId: { type: 'Int', resolve: prop('databaseId') },
      number: { type: 'Int', resolve: prop('number') },
      title: { type: 'String', resolve: prop('title') },
      body: { type: 'String', resolve: prop('body') },
      state: { type: 'IssueState', resolve: prop('state') },
      createdAt: { type: 'String', resolve: prop('createdAt') },
      updatedAt: { type: 'String', resolve: prop('updatedAt') },
      closedAt: { type: 'String', resolve: prop('closedAt') },
      author: { type: 'User', resolve: () => userNode() },
      labels: {
        type: 'Label',
        list: true,
        resolve: (parent) => {
          const { repo, issue } = parent as { repo: Repo; issue: Issue };
          return issue.labelNames
            .map((name) => repo.labels.get(name))
            .filter((l): l is NonNullable<typeof l> => l !== undefined)
            .map((l) => labelNode(repo, l));
        },
      },
      comments: {
        type: 'IssueCommentConnection',
        resolve: (parent) => {
          const { repo, issue } = parent as { repo: Repo; issue: Issue };
          return {
            __typename: 'IssueCommentConnection',
            nodes: issue.comments.map((c) => commentNode(repo, issue, c)),
            totalCount: issue.comments.length,
          };
        },
      },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: 'Issue', list: true, resolve: prop('nodes') },
      pageInfo: { type: 'PageInfo', resolve: prop('pageInfo') },
      totalCount: { type: 'Int', resolve: prop('totalCount') },
    },
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: 'IssueComment', list: true, resolve: prop('nodes') },
      totalCount: { type: 'Int', resolve: prop('totalCount') },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: prop('id') },
      databaseId: { type: 'Int', resolve: prop('databaseId') },
      body: { type: 'String', resolve: prop('body') },
      createdAt: { type: 'String', resolve: prop('createdAt') },
      updatedAt: { type: 'String', resolve: prop('updatedAt') },
      author: { type: 'User', resolve: () => userNode() },
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: prop('id') },
      name: { type: 'String', resolve: prop('name') },
      color: { type: 'String', resolve: prop('color') },
      description: { type: 'String', resolve: prop('description') },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean', resolve: prop('hasNextPage') },
      hasPreviousPage: { type: 'Boolean', resolve: prop('hasPreviousPage') },
      startCursor: { type: 'String', resolve: prop('startCursor') },
      endCursor: { type: 'String', resolve: prop('endCursor') },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: prop('id') },
      databaseId: { type: 'Int', resolve: prop('databaseId') },
      number: { type: 'Int', resolve: prop('number') },
      title: { type: 'String', resolve: prop('title') },
      body: { type: 'String', resolve: prop('body') },
      state: { type: 'PullRequestState', resolve: prop('state') },
      merged: { type: 'Boolean', resolve: prop('merged') },
      mergedAt: { type: 'String', resolve: prop('mergedAt') },
      mergeCommit: {
        type: 'Commit',
        resolve: (parent) => {
          const pull = (parent as { pull: Pull }).pull;
          return pull.mergeCommitSha === null
            ? null
            : { __typename: 'Commit', oid: pull.mergeCommitSha };
        },
      },
      headRefName: { type: 'String', resolve: prop('headRefName') },
      baseRefName: { type: 'String', resolve: prop('baseRefName') },
      mergeable: { type: 'MergeableState', resolve: prop('mergeable') },
      createdAt: { type: 'String', resolve: prop('createdAt') },
      updatedAt: { type: 'String', resolve: prop('updatedAt') },
      author: { type: 'User', resolve: () => userNode() },
      files: {
        type: 'PullRequestChangedFileConnection',
        resolve: (parent, args, gql) => {
          const { repo, pull } = parent as { repo: Repo; pull: Pull };
          const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
          const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
          if (headTip === undefined || baseTip === undefined) {
            return { __typename: 'PullRequestChangedFileConnection', nodes: [] };
          }
          const mb = gql.store.mergeBase(repo, headTip, baseTip);
          const mbTree = mb === null ? null : (gql.store.getCommitInfo(repo, mb)?.tree ?? null);
          const headTree = gql.store.getCommitInfo(repo, headTip)?.tree ?? null;
          const changes = gql.store.diffTrees(repo, mbTree, headTree);
          const first = typeof args.first === 'number' ? args.first : changes.length;
          const nodes = changes.slice(0, Math.max(0, first)).map((c) => ({
            __typename: 'PullRequestChangedFile',
            path: c.path,
            additions: 0,
            deletions: 0,
            changeType: c.status === 'modified' ? 'MODIFIED' : c.status === 'added' ? 'ADDED' : 'REMOVED',
          }));
          // Line counts, as in REST.
          for (const node of nodes) {
            const change = changes.find((c) => c.path === node.path);
            if (change === undefined) continue;
            if (change.status === 'added' && change.newOid !== undefined) {
              const obj = repo.objects.get(change.newOid);
              node.additions = obj !== undefined && obj.type === 'blob' ? countBlobLines(obj.data) : 0;
            } else if (change.status === 'removed' && change.oldOid !== undefined) {
              const obj = repo.objects.get(change.oldOid);
              node.deletions = obj !== undefined && obj.type === 'blob' ? countBlobLines(obj.data) : 0;
            } else if (change.status === 'modified' && change.oldOid !== undefined && change.newOid !== undefined) {
              const oldObj = repo.objects.get(change.oldOid);
              const newObj = repo.objects.get(change.newOid);
              const oldLines = oldObj !== undefined && oldObj.type === 'blob' ? oldObj.data.toString('utf8').split('\n') : [];
              const newLines = newObj !== undefined && newObj.type === 'blob' ? newObj.data.toString('utf8').split('\n') : [];
              const diff = lineDiff(oldLines, newLines);
              node.additions = diff.added;
              node.deletions = diff.removed;
            }
          }
          return { __typename: 'PullRequestChangedFileConnection', nodes };
        },
      },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: 'PullRequest', list: true, resolve: prop('nodes') },
      pageInfo: { type: 'PageInfo', resolve: prop('pageInfo') },
      totalCount: { type: 'Int', resolve: prop('totalCount') },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: 'PullRequestChangedFile', list: true, resolve: prop('nodes') },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String', resolve: prop('path') },
      additions: { type: 'Int', resolve: prop('additions') },
      deletions: { type: 'Int', resolve: prop('deletions') },
      changeType: { type: 'String', resolve: prop('changeType') },
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      oid: { type: 'String', resolve: prop('oid') },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        resolve: (_parent, args, gql) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
          if (decoded === null || decoded.type !== 'Repository') throw new Error('repositoryId does not identify a repository');
          const repo = findRepoById(gql.store, Number.parseInt(decoded.parts[0], 10));
          if (repo === undefined) throw new Error('repository not found');
          const title = input.title as string | undefined;
          if (typeof title !== 'string' || title === '') throw new Error('title is required');
          const result = gql.store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
          if ('error' in result) throw new Error(result.error);
          return { __typename: 'CreateIssuePayload', repo, issue: result.issue };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        resolve: (_parent, args, gql) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
          if (decoded === null || decoded.type !== 'Issue') throw new Error('issueId does not identify an issue');
          const repo = findRepoById(gql.store, Number.parseInt(decoded.parts[0], 10));
          const issue = repo?.issues.get(Number.parseInt(decoded.parts[1], 10));
          if (repo === undefined || issue === undefined) throw new Error('issue not found');
          issue.state = 'closed';
          issue.closedAtSec = gql.store.trialNowSec;
          issue.updatedAtSec = gql.store.trialNowSec;
          return { __typename: 'CloseIssuePayload', repo, issue };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        resolve: (_parent, args, gql) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
          if (decoded === null || decoded.type !== 'Repository') throw new Error('repositoryId does not identify a repository');
          const repo = findRepoById(gql.store, Number.parseInt(decoded.parts[0], 10));
          if (repo === undefined) throw new Error('repository not found');
          const title = input.title as string | undefined;
          const head = input.headRefName as string | undefined;
          const base = input.baseRefName as string | undefined;
          if (typeof title !== 'string' || title === '' || typeof head !== 'string' || typeof base !== 'string') {
            throw new Error('title, headRefName and baseRefName are required');
          }
          const result = gql.store.createPull(repo, title, head, base, typeof input.body === 'string' ? input.body : '');
          if ('error' in result) throw new Error(result.error);
          return { __typename: 'CreatePullRequestPayload', repo, pull: result.pull };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        resolve: (_parent, args, gql) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
          if (decoded === null || decoded.type !== 'PullRequest') throw new Error('pullRequestId does not identify a pull request');
          const repo = findRepoById(gql.store, Number.parseInt(decoded.parts[0], 10));
          const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1], 10));
          if (repo === undefined || pull === undefined) throw new Error('pull request not found');
          const result = gql.store.squashMerge(repo, pull);
          if ('error' in result) throw new Error(result.error);
          return { __typename: 'MergePullRequestPayload', repo, pull };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        resolve: (_parent, args, gql) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
          if (decoded === null || decoded.type !== 'Issue') throw new Error('subjectId does not identify an issue');
          const repo = findRepoById(gql.store, Number.parseInt(decoded.parts[0], 10));
          const issue = repo?.issues.get(Number.parseInt(decoded.parts[1], 10));
          if (repo === undefined || issue === undefined) throw new Error('issue not found');
          const body = input.body as string | undefined;
          if (typeof body !== 'string' || body === '') throw new Error('body is required');
          const comment = gql.store.createComment(repo, issue, body);
          return {
            __typename: 'AddCommentPayload',
            commentEdge: { __typename: 'IssueCommentEdge', node: commentNode(repo, issue, comment) },
          };
        },
      },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: {
        type: 'Issue',
        resolve: (parent) => {
          const { repo, issue } = parent as { repo: Repo; issue: Issue };
          return issueNode(repo, issue);
        },
      },
    },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: {
        type: 'Issue',
        resolve: (parent) => {
          const { repo, issue } = parent as { repo: Repo; issue: Issue };
          return issueNode(repo, issue);
        },
      },
    },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: {
        type: 'PullRequest',
        resolve: (parent, _args, gql) => {
          const { repo, pull } = parent as { repo: Repo; pull: Pull };
          return pullNode(gql.store, repo, pull);
        },
      },
    },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: {
        type: 'PullRequest',
        resolve: (parent, _args, gql) => {
          const { repo, pull } = parent as { repo: Repo; pull: Pull };
          return pullNode(gql.store, repo, pull);
        },
      },
    },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: { type: 'IssueCommentEdge', resolve: prop('commentEdge') },
    },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'IssueComment', resolve: prop('node') },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: prop('name') },
      kind: { type: 'String', resolve: prop('kind') },
      description: { type: 'String', resolve: prop('description') },
      fields: { type: '__Field', list: true, resolve: prop('fields') },
      enumValues: { type: '__EnumValue', list: true, resolve: prop('enumValues') },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: prop('name') },
      description: { type: 'String', resolve: prop('description') },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: prop('name') },
      description: { type: 'String', resolve: prop('description') },
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      description: { type: 'String', resolve: prop('description') },
    },
  },
};

function countBlobLines(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

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

// ------------------------------------------------------------------ execution
function typeNameOf(node: unknown): string | null {
  if (node !== null && typeof node === 'object' && '__typename' in (node as Record<string, unknown>)) {
    return (node as Record<string, unknown>).__typename as string;
  }
  return null;
}

function executeSelectionSet(
  selections: SelectionNode[],
  parentType: string,
  parentValue: unknown,
  variables: Record<string, unknown>,
  fragments: Map<string, SelectionNode[]>,
  gql: GQLContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA[parentType];
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) continue;
      Object.assign(out, executeSelectionSet(fragment, parentType, parentValue, variables, fragments, gql));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== parentType) continue;
      Object.assign(out, executeSelectionSet(selection.selectionSet, parentType, parentValue, variables, fragments, gql));
      continue;
    }
    // Field.
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const fieldDef = typeDef?.fields?.[selection.name];
    if (fieldDef === undefined) {
      gql.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, variables);
    let value: unknown;
    try {
      value = fieldDef.resolve(parentValue, args, gql);
    } catch (err) {
      gql.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (selection.selectionSet === undefined) {
      out[responseKey] = value;
      continue;
    }
    if (fieldDef.list === true && Array.isArray(value)) {
      out[responseKey] = value.map((item) => {
        if (item === null || item === undefined) return null;
        const childType = typeNameOf(item) ?? fieldDef.type;
        return executeSelectionSet(selection.selectionSet as SelectionNode[], childType, item, variables, fragments, gql);
      });
      continue;
    }
    const childType = typeNameOf(value) ?? fieldDef.type;
    out[responseKey] = executeSelectionSet(selection.selectionSet, childType, value, variables, fragments, gql);
  }
  return out;
}

function executeOperation(
  operation: OperationNode,
  document: DocumentNode,
  variables: Record<string, unknown>,
  store: Store,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const gql: GQLContext = { store, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const rootValue = { __typename: rootType };
  const data = executeSelectionSet(operation.selectionSet, rootType, rootValue, variables, document.fragments, gql);
  if (gql.errors.length > 0) {
    return { data: null, errors: gql.errors };
  }
  return { data, errors: [] };
}

export async function handleGraphQL(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthed(ctx, req)) {
    sendJsonError(ctx, res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(ctx, res, 400, { errors: [{ message: 'Request body must be valid JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    const obj = (entry ?? {}) as Record<string, unknown>;
    const query = obj.query;
    if (typeof query !== 'string' || query === '') {
      return { errors: [{ message: 'Request must include a query string' }] };
    }
    const variables = (obj.variables ?? {}) as Record<string, unknown>;
    const operationName = obj.operationName as string | undefined;
    let document: DocumentNode;
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (document.operations.length === 0) {
      return { errors: [{ message: 'Document contains no operations' }] };
    }
    let operation = document.operations[0];
    if (operationName !== undefined) {
      const found = document.operations.find((op) => op.name === operationName);
      if (found === undefined) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
      operation = found;
    }
    const result = executeOperation(operation, document, variables, ctx.store);
    if (result.errors.length > 0) {
      return { data: result.data, errors: result.errors };
    }
    return { data: result.data };
  };
  if (Array.isArray(body)) {
    sendJson(ctx, res, 200, body.map((entry) => runOne(entry)));
    return;
  }
  sendJson(ctx, res, 200, runOne(body));
}
