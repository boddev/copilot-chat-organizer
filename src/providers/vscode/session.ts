// Reads VS Code chat session files.
//
// Two formats exist side by side in <User>/workspaceStorage/<hash>/chatSessions and
// <User>/globalStorage/emptyWindowChatSessions:
// - <sessionId>.json:  the whole serialized session (version 3): sessionId, creationDate,
//   lastMessageDate, customTitle?, requests[] ...
// - <sessionId>.jsonl: a mutation log. The first line is {"kind":0,"v":<state>} and each
//   following line mutates that state at path "k":
//     kind 1: set the value "v" at k
//     kind 2: truncate the array at k to length "i" (when given), then push the items of "v"
//     kind 3: delete the property at k
//   Replaying every line yields the same object the .json format stores (minus
//   lastMessageDate, which then only lives in the chat index).
import fs from 'node:fs';

export type JsonObject = Record<string, unknown>;
export type SessionFormat = 'json' | 'jsonl';
export type PathKey = string | number;

export interface MutationEntry {
  kind: number;
  k?: PathKey[];
  v?: unknown;
  i?: number;
}

export interface SessionSummary {
  sessionId?: string;
  creationDate?: number;
  lastMessageDate?: number;
  customTitle?: string;
  requestCount: number;
  firstRequestText?: string;
  firstRequestAt?: number;
  lastRequestAt?: number;
  /** Some log lines could not be parsed (e.g. a torn last line). */
  partial?: boolean;
}

export interface LoadedSession {
  session: JsonObject;
  format: SessionFormat;
  partial: boolean;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CHUNK_SIZE = 4 * 1024 * 1024;
const MIN_CHUNK_SIZE = 64 * 1024;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatOf(file: string): SessionFormat | undefined {
  if (file.endsWith('.jsonl')) return 'jsonl';
  if (file.endsWith('.json')) return 'json';
  return undefined;
}

// ---- mutation log -------------------------------------------------------------------

function validKey(key: unknown): key is PathKey {
  return (typeof key === 'string' && !UNSAFE_KEYS.has(key)) || (typeof key === 'number' && Number.isInteger(key) && key >= 0);
}

function child(container: unknown, key: PathKey): unknown {
  if (Array.isArray(container)) return typeof key === 'number' ? container[key] : undefined;
  if (isObject(container) && typeof key === 'string') return Object.hasOwn(container, key) ? container[key] : undefined;
  return undefined;
}

function assign(container: unknown, key: PathKey, value: unknown): boolean {
  if (Array.isArray(container) && typeof key === 'number') {
    container[key] = value;
    return true;
  }
  if (isObject(container) && typeof key === 'string') {
    container[key] = value;
    return true;
  }
  return false;
}

function valueAt(state: unknown, keys: PathKey[]): unknown {
  let cur = state;
  for (const key of keys) {
    if (!validKey(key)) return undefined;
    cur = child(cur, key);
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Walks to `keys`, creating missing objects/arrays on the way. */
function containerAt(state: unknown, keys: PathKey[]): unknown {
  let cur = state;
  for (let n = 0; n < keys.length; n++) {
    const key = keys[n];
    if (!validKey(key)) return undefined;
    let next = child(cur, key);
    if (typeof next !== 'object' || next === null) {
      next = typeof keys[n + 1] === 'number' ? [] : {};
      if (!assign(cur, key, next)) return undefined;
    }
    cur = next;
  }
  return cur;
}

/** Applies one mutation-log entry and returns the (possibly replaced) state. */
export function applyMutation(state: unknown, entry: MutationEntry): unknown {
  const keys = Array.isArray(entry.k) ? entry.k : [];
  switch (entry.kind) {
    case 0:
      return entry.v;
    case 1: {
      if (!keys.length) return entry.v;
      const last = keys[keys.length - 1];
      if (!validKey(last)) return state;
      assign(containerAt(state, keys.slice(0, -1)), last, entry.v);
      return state;
    }
    case 2: {
      let arr = valueAt(state, keys);
      if (!Array.isArray(arr)) {
        if (arr !== undefined && arr !== null) return state;
        if (!keys.length) return state;
        const last = keys[keys.length - 1];
        arr = [];
        if (!validKey(last) || !assign(containerAt(state, keys.slice(0, -1)), last, arr)) return state;
      }
      const list = arr as unknown[];
      if (typeof entry.i === 'number' && entry.i >= 0 && entry.i < list.length) list.length = entry.i;
      if (Array.isArray(entry.v)) for (const item of entry.v) list.push(item);
      return state;
    }
    case 3: {
      if (!keys.length) return state;
      const parent = valueAt(state, keys.slice(0, -1));
      const last = keys[keys.length - 1];
      if (Array.isArray(parent) && typeof last === 'number') parent.splice(last, 1);
      else if (isObject(parent) && typeof last === 'string' && !UNSAFE_KEYS.has(last)) delete parent[last];
      return state;
    }
    default:
      return state;
  }
}

function asEntry(value: unknown): MutationEntry | undefined {
  if (!isObject(value) || typeof value.kind !== 'number') return undefined;
  return value as unknown as MutationEntry;
}

// ---- line reader ----------------------------------------------------------------------

/** Calls `onLine` for every non-empty line, reading the file in chunks (no full-file string). */
export async function forEachLine(file: string, onLine: (line: Buffer) => void): Promise<void> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const chunkSize = Math.max(MIN_CHUNK_SIZE, Math.min(CHUNK_SIZE, size + 1));
    let pending: Buffer[] = [];
    const emit = (line: Buffer): void => {
      let end = line.length;
      if (end && line[end - 1] === 13) end--;
      if (end) onLine(end === line.length ? line : line.subarray(0, end));
    };
    for (;;) {
      const chunk = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, null);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      let start = 0;
      let nl = data.indexOf(10, start);
      while (nl !== -1) {
        const piece = data.subarray(start, nl);
        if (pending.length) {
          pending.push(piece);
          emit(Buffer.concat(pending));
          pending = [];
        } else {
          emit(piece);
        }
        start = nl + 1;
        nl = data.indexOf(10, start);
      }
      if (start < data.length) pending.push(data.subarray(start));
    }
    if (pending.length) emit(pending.length === 1 ? pending[0] : Buffer.concat(pending));
  } finally {
    await handle.close();
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---- full read ------------------------------------------------------------------------

/** Loads and (for .jsonl) reconstructs a complete session object. */
export async function readSessionFile(file: string): Promise<LoadedSession> {
  const format = formatOf(file);
  if (format === 'json') {
    const parsed: unknown = JSON.parse(stripBom(await fs.promises.readFile(file, 'utf8')));
    if (!isObject(parsed)) throw new Error('chat session file is not a JSON object');
    return { session: parsed, format, partial: false };
  }
  if (format !== 'jsonl') throw new Error(`unsupported chat session file: ${file}`);
  let state: unknown;
  let partial = false;
  let first = true;
  await forEachLine(file, (line) => {
    const text = first ? stripBom(line.toString('utf8')) : line.toString('utf8');
    first = false;
    let entry: MutationEntry | undefined;
    try {
      entry = asEntry(JSON.parse(text));
    } catch {
      partial = true;
      return;
    }
    if (!entry) {
      partial = true;
      return;
    }
    state = applyMutation(state, entry);
  });
  if (!isObject(state)) throw new Error('chat session log has no initial state');
  return { session: state, format, partial };
}

// ---- summaries (fast path for listing) ---------------------------------------------------

export function requestText(request: unknown): string {
  if (!isObject(request)) return '';
  const message = request.message;
  if (typeof message === 'string') return message;
  if (!isObject(message)) return '';
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.parts)) {
    return message.parts.map((p) => (isObject(p) && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

export function requestsOf(session: JsonObject): JsonObject[] {
  return Array.isArray(session.requests) ? session.requests.filter(isObject) : [];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function summarize(session: JsonObject, partial = false): SessionSummary {
  const requests = requestsOf(session);
  const first = requests[0];
  let lastRequestAt: number | undefined;
  for (const r of requests) {
    const t = num(r.timestamp);
    if (t !== undefined && (lastRequestAt === undefined || t > lastRequestAt)) lastRequestAt = t;
  }
  return {
    sessionId: str(session.sessionId),
    creationDate: num(session.creationDate),
    lastMessageDate: num(session.lastMessageDate),
    customTitle: str(session.customTitle),
    requestCount: requests.length,
    firstRequestText: first ? requestText(first) : undefined,
    firstRequestAt: first ? num(first.timestamp) : undefined,
    lastRequestAt,
    partial: partial || undefined,
  };
}

/** Keeps only what listing needs from a request (drops responses, tool data, ...). */
function slimRequest(request: unknown): unknown {
  if (!isObject(request)) return request;
  return { message: { text: requestText(request) }, timestamp: request.timestamp };
}

function slimState(state: unknown): unknown {
  if (!isObject(state)) return state;
  return {
    sessionId: state.sessionId,
    creationDate: state.creationDate,
    lastMessageDate: state.lastMessageDate,
    customTitle: state.customTitle,
    requests: Array.isArray(state.requests) ? state.requests.map(slimRequest) : [],
  };
}

const SUMMARY_TOP_KEYS = new Set(['sessionId', 'creationDate', 'lastMessageDate', 'customTitle', 'requests']);

/** Whether a mutation at `keys` can change anything `summarize` reads. */
function mattersForSummary(keys: PathKey[]): boolean {
  if (!keys.length) return true;
  if (typeof keys[0] !== 'string' || !SUMMARY_TOP_KEYS.has(keys[0])) return false;
  if (keys[0] !== 'requests' || keys.length <= 2) return true;
  return keys[2] === 'message' || keys[2] === 'timestamp';
}

/** Rewrites an entry so that it applies to the slim state used for summaries. */
function slimEntry(entry: MutationEntry): MutationEntry {
  const keys = Array.isArray(entry.k) ? entry.k : [];
  if (entry.kind === 0 || (entry.kind === 1 && !keys.length)) return { ...entry, v: slimState(entry.v) };
  if (keys.length === 1 && keys[0] === 'requests') {
    if (entry.kind === 2 && Array.isArray(entry.v)) return { ...entry, v: entry.v.map(slimRequest) };
    if (entry.kind === 1 && Array.isArray(entry.v)) return { ...entry, v: entry.v.map(slimRequest) };
  }
  if (keys.length === 2 && keys[0] === 'requests' && entry.kind === 1) return { ...entry, v: slimRequest(entry.v) };
  return entry;
}

// {"kind":<n>,"k":[...]  -- VS Code writes "kind" first, then "k", then "v" (and "i").
const LINE_PREFIX = /^\{"kind":(\d+)(?:,"k":(\[[^\]]*\]))?/;
const PREFIX_BYTES = 512;

/** Decides from the start of a log line whether it must be parsed for a summary. */
function prefixVerdict(line: Buffer): 'parse' | 'skip' {
  const m = LINE_PREFIX.exec(line.toString('utf8', 0, Math.min(line.length, PREFIX_BYTES)));
  if (!m) return 'parse';
  if (m[1] === '0' || m[2] === undefined) return 'parse';
  try {
    const keys: unknown = JSON.parse(m[2]);
    if (!Array.isArray(keys)) return 'parse';
    return mattersForSummary(keys as PathKey[]) ? 'parse' : 'skip';
  } catch {
    return 'parse';
  }
}

/**
 * Summarizes a session file for listing. For .jsonl logs only the lines that touch the
 * title, dates and request messages are parsed; response streaming lines (the bulk of the
 * file) are skipped without decoding them.
 */
export async function summarizeSessionFile(file: string): Promise<SessionSummary> {
  const format = formatOf(file);
  if (format === 'json') {
    const { session } = await readSessionFile(file);
    return summarize(session);
  }
  if (format !== 'jsonl') throw new Error(`unsupported chat session file: ${file}`);
  let state: unknown;
  let partial = false;
  await forEachLine(file, (line) => {
    if (prefixVerdict(line) === 'skip') return;
    let entry: MutationEntry | undefined;
    try {
      entry = asEntry(JSON.parse(stripBom(line.toString('utf8'))));
    } catch {
      partial = true;
      return;
    }
    if (!entry) {
      partial = true;
      return;
    }
    if (entry.kind !== 0 && !mattersForSummary(Array.isArray(entry.k) ? entry.k : [])) return;
    state = applyMutation(state, slimEntry(entry));
  });
  if (!isObject(state)) throw new Error('chat session log has no initial state');
  return summarize(state, partial);
}
