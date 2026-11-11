// VS Code Copilot Chat: lists the chat sessions VS Code stores on this machine, renders their
// transcripts and moves chats into the organizer's trash (session file + index entry), from
// where they can be restored.
//
// Storage (per edition, under %APPDATA%\Code[ - Insiders]\User):
//   workspaceStorage/<hash>/chatSessions/<sessionId>.json|.jsonl   chats of a folder/workspace
//   workspaceStorage/<hash>/workspace.json                          { folder | workspace: <uri> }
//   workspaceStorage/<hash>/state.vscdb                             index of that workspace's chats
//   globalStorage/emptyWindowChatSessions/<sessionId>.json|.jsonl   chats of empty windows
//   globalStorage/state.vscdb                                       index of empty-window chats
// See session.ts for the file formats and stateDb.ts for the index.
import fs from 'node:fs';
import path from 'node:path';
import type {
  Conversation,
  ItemResult,
  Progress,
  Provider,
  ProviderContext,
  ProviderStatus,
  SourceId,
  Transcript,
} from '../../core/types.ts';
import { toIso } from '../../core/types.ts';
import { readJson, safeName, writeJsonAtomic } from '../../core/store.ts';
import { mapLimit } from '../../lib/async.ts';
import {
  EMPTY_WINDOW,
  defaultRoots,
  describeWorkspaceUri,
  emptyWindowSessionsDir,
  globalStateDb,
  isEmptyWindowHash,
  isInside,
  isSafeSegment,
  makeItemId,
  parseItemId,
  sessionsDir,
  workspaceStorageDir,
  type ParsedItemId,
  type VsCodeRoot,
} from './paths.ts';
import {
  formatOf,
  isObject,
  readSessionFile,
  summarize,
  summarizeSessionFile,
  type JsonObject,
  type SessionSummary,
} from './session.ts';
import { boundRaw, buildTranscriptMessages } from './transcript.ts';
import { CHAT_INDEX_KEY, putIndexEntry, readChatIndex, removeIndexEntry, type ChatIndex } from './stateDb.ts';
import { ProcessDetector } from './running.ts';

export { defaultRoots, makeItemId, parseItemId, type VsCodeRoot } from './paths.ts';
export { ProcessDetector } from './running.ts';

export interface VsCodeProviderOptions {
  /** VS Code "User" folders to read; defaults to every existing Stable/Insiders folder. */
  roots?: Array<{ edition: string; userDir: string }>;
  /** Overrides process detection (tests). */
  isRunning?: (edition: string) => Promise<boolean>;
}

const KIND = 'vscode-chat';
const TITLE_MAX = 140;
const PREVIEW_MAX = 200;
const READ_CONCURRENCY = 6;
const META_FILE = 'meta.json';
/** Titles VS Code stores for chats that have no real title yet. */
const PLACEHOLDER_TITLES = new Set(['', 'new chat']);

interface SessionRef {
  root: VsCodeRoot;
  workspaceHash: string;
  sessionId: string;
  /** Existing session files, .jsonl (current format) first. */
  files: string[];
}

interface WorkspaceInfo {
  location: string;
  uri?: string;
}

interface IndexHit {
  db: string;
  entry: JsonObject;
}

interface TrashedIndexEntry {
  db: string;
  key: string;
  entry: unknown;
  indexVersion?: unknown;
}

interface TrashMeta {
  version: 1;
  source: 'vscode';
  id: string;
  kind: string;
  title: string;
  location?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  preview?: string;
  edition: string;
  workspaceHash: string;
  sessionId: string;
  format?: string;
  deletedAt: string;
  /** False while the move is in progress (or when it was interrupted). */
  complete: boolean;
  /** Session files: original absolute path and file name inside the trash folder. */
  files: Array<{ original: string; name: string }>;
  /** Related per-chat data: original absolute path and path relative to the trash folder. */
  companions: Array<{ original: string; trashed: string }>;
  indexEntries: TrashedIndexEntry[];
}

type RunningCheck = (edition: string) => Promise<boolean>;

export function editionLabel(edition: string): string {
  if (edition === 'stable') return 'VS Code';
  if (edition === 'insiders') return 'VS Code Insiders';
  return `VS Code (${edition})`;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const collapse = (text: unknown): string => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function asMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e11 ? value * 1000 : value;
}

function firstMs(...values: unknown[]): number | undefined {
  for (const v of values) {
    const ms = asMs(v);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

function maxMs(...values: unknown[]): number | undefined {
  let best: number | undefined;
  for (const v of values) {
    const ms = asMs(v);
    if (ms !== undefined && (best === undefined || ms > best)) best = ms;
  }
  return best;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

/** Moves a file or folder; never overwrites. Falls back to copy + delete across volumes. */
function moveSync(from: string, to: string): void {
  if (fs.existsSync(to)) throw new Error(`destination already exists: ${to}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** Removes empty folders below and including `dir`; never removes files. */
function removeEmptyTree(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const e of entries) {
    if (e.isDirectory() && removeEmptyTree(path.join(dir, e.name))) continue;
    empty = false;
  }
  if (!empty) return false;
  try {
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

function normalizeRoots(roots: Array<{ edition: string; userDir: string }>): VsCodeRoot[] {
  const out: VsCodeRoot[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    const base = String(r.edition ?? '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 60) || 'vscode';
    let edition = base;
    for (let n = 2; seen.has(edition); n++) edition = `${base}-${n}`;
    seen.add(edition);
    out.push({ edition, userDir: path.resolve(r.userDir) });
  }
  return out;
}

function indexDbs(ref: { root: VsCodeRoot; workspaceHash: string }): string[] {
  const global = globalStateDb(ref.root);
  if (isEmptyWindowHash(ref.workspaceHash)) return [global];
  return [path.join(workspaceStorageDir(ref.root), ref.workspaceHash, 'state.vscdb'), global];
}

/** Per-chat data kept next to the session (editing snapshots, Copilot extension logs). */
function companionPaths(ref: SessionRef): string[] {
  if (isEmptyWindowHash(ref.workspaceHash)) return [];
  const wsDir = path.join(workspaceStorageDir(ref.root), ref.workspaceHash);
  const sid = ref.sessionId;
  return [
    path.join(wsDir, 'chatEditingSessions', sid),
    path.join(wsDir, 'GitHub.copilot-chat', 'transcripts', `${sid}.jsonl`),
    path.join(wsDir, 'GitHub.copilot-chat', 'debug-logs', sid),
    path.join(wsDir, 'GitHub.copilot-chat', 'chat-session-resources', sid),
  ];
}

function readMeta(dir: string): TrashMeta | undefined {
  const meta = readJson<unknown>(path.join(dir, META_FILE), undefined);
  if (!isObject(meta) || typeof meta.id !== 'string' || !Array.isArray(meta.files)) return undefined;
  if (!Array.isArray(meta.companions)) meta.companions = [];
  if (!Array.isArray(meta.indexEntries)) meta.indexEntries = [];
  return meta as unknown as TrashMeta;
}

export class VsCodeProvider implements Provider {
  readonly id: SourceId = 'vscode';
  readonly label = 'VS Code Copilot Chat';

  private readonly ctx: ProviderContext;
  private readonly configuredRoots: VsCodeRoot[] | undefined;
  private readonly customIsRunning: ((edition: string) => Promise<boolean>) | undefined;
  private readonly detector: ProcessDetector;
  private readonly summaryCache = new Map<string, { size: number; mtimeMs: number; summary: SessionSummary }>();
  private readonly indexCache = new Map<string, { size: number; mtimeMs: number; index: ChatIndex | undefined }>();
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(ctx: ProviderContext, options: VsCodeProviderOptions = {}) {
    this.ctx = ctx;
    this.configuredRoots = options.roots ? normalizeRoots(options.roots) : undefined;
    this.customIsRunning = options.isRunning;
    this.detector = new ProcessDetector({ log: (m) => this.ctx.log(m) });
  }

  // ---- roots and running state ---------------------------------------------------------

  private roots(): VsCodeRoot[] {
    return this.configuredRoots ?? normalizeRoots(defaultRoots());
  }

  private existingRoots(): VsCodeRoot[] {
    return this.roots().filter((r) => isDir(r.userDir));
  }

  private rootFor(edition: string): VsCodeRoot | undefined {
    return this.roots().find((r) => r.edition === edition);
  }

  /** Memoized per call site; `fresh` bypasses the process-list cache (used before writes). */
  private runningChecker(fresh: boolean): RunningCheck {
    const memo = new Map<string, Promise<boolean>>();
    return (edition) => {
      let p = memo.get(edition);
      if (!p) {
        const custom = this.customIsRunning;
        p = custom
          ? Promise.resolve()
              .then(() => custom(edition))
              .then(Boolean, (err: unknown) => {
                this.ctx.log(`running check failed for ${edition} (${errorText(err)}); assuming it is running`);
                return true;
              })
          : this.detector.isRunning(edition, fresh);
        memo.set(edition, p);
      }
      return p;
    };
  }

  /** Serializes deletes and restores. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutations.then(fn, fn);
    this.mutations = run.catch(() => undefined);
    return run;
  }

  async status(): Promise<ProviderStatus> {
    const roots = this.existingRoots();
    if (!roots.length) {
      return { available: false, message: 'No VS Code user data folder found (looked for Code and Code - Insiders)' };
    }
    const check = this.runningChecker(false);
    const running = await Promise.all(roots.map((r) => check(r.edition)));
    const warnings = roots
      .filter((_r, i) => running[i])
      .map((r) => `${editionLabel(r.edition)} is running — deleting is disabled until it is closed`);
    return {
      available: true,
      message: `Reading chats from ${roots.map((r) => editionLabel(r.edition)).join(' and ')}`,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  // ---- discovery -------------------------------------------------------------------------

  private discover(root: VsCodeRoot): SessionRef[] {
    const refs = new Map<string, SessionRef>();
    const scan = (workspaceHash: string, dir: string): void => {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const format = formatOf(name);
        if (!format) continue;
        const sessionId = name.slice(0, -(format.length + 1));
        if (!isSafeSegment(sessionId)) continue;
        const key = `${workspaceHash}:${sessionId}`;
        let ref = refs.get(key);
        if (!ref) {
          ref = { root, workspaceHash, sessionId, files: [] };
          refs.set(key, ref);
        }
        ref.files.push(path.join(dir, name));
      }
    };
    const wsRoot = workspaceStorageDir(root);
    let hashes: fs.Dirent[] = [];
    try {
      hashes = fs.readdirSync(wsRoot, { withFileTypes: true });
    } catch {
      // no workspace storage yet
    }
    for (const d of hashes) {
      if (!d.isDirectory() || d.name === EMPTY_WINDOW || !isSafeSegment(d.name)) continue;
      scan(d.name, path.join(wsRoot, d.name, 'chatSessions'));
    }
    scan(EMPTY_WINDOW, emptyWindowSessionsDir(root));
    for (const ref of refs.values()) ref.files.sort((a, b) => Number(b.endsWith('.jsonl')) - Number(a.endsWith('.jsonl')));
    return [...refs.values()];
  }

  /** Session files for an id, resolved only from the configured roots (never from item data). */
  private resolve(parsed: ParsedItemId): SessionRef | undefined {
    const root = this.rootFor(parsed.edition);
    if (!root) return undefined;
    const dir = sessionsDir(root, parsed.workspaceHash);
    const files = ['.jsonl', '.json'].map((ext) => path.join(dir, parsed.sessionId + ext)).filter(isFile);
    return { root, workspaceHash: parsed.workspaceHash, sessionId: parsed.sessionId, files };
  }

  private readIndexCached(dbFile: string): ChatIndex | undefined {
    let st: fs.Stats;
    try {
      st = fs.statSync(dbFile);
    } catch {
      return undefined;
    }
    const hit = this.indexCache.get(dbFile);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.index;
    try {
      const index = readChatIndex(dbFile);
      this.indexCache.set(dbFile, { size: st.size, mtimeMs: st.mtimeMs, index });
      return index;
    } catch (err) {
      this.ctx.log(`could not read the chat index in ${dbFile}: ${errorText(err)}`);
      return undefined;
    }
  }

  private indexEntryFor(ref: SessionRef): IndexHit | undefined {
    for (const db of indexDbs(ref)) {
      const entry = this.readIndexCached(db)?.entries[ref.sessionId];
      if (entry) return { db, entry };
    }
    return undefined;
  }

  private workspaceInfo(root: VsCodeRoot, workspaceHash: string, cache?: Map<string, WorkspaceInfo>): WorkspaceInfo {
    if (isEmptyWindowHash(workspaceHash)) return { location: 'Empty window' };
    const key = `${root.edition}:${workspaceHash}`;
    const hit = cache?.get(key);
    if (hit) return hit;
    let info: WorkspaceInfo = { location: `Unknown workspace (${workspaceHash})` };
    const ws = readJson<unknown>(path.join(workspaceStorageDir(root), workspaceHash, 'workspace.json'), undefined);
    if (isObject(ws)) {
      for (const k of ['folder', 'workspace', 'configuration']) {
        const uri = ws[k];
        if (typeof uri === 'string' && uri) {
          info = { location: describeWorkspaceUri(uri), uri };
          break;
        }
      }
    }
    cache?.set(key, info);
    return info;
  }

  private async summaryFor(file: string, st: fs.Stats): Promise<SessionSummary> {
    const hit = this.summaryCache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.summary;
    const summary = await summarizeSessionFile(file);
    this.summaryCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, summary });
    return summary;
  }

  /** Listing entry for a session; undefined for empty, untitled sessions and vanished files. */
  private async describe(ref: SessionRef, wsCache?: Map<string, WorkspaceInfo>): Promise<Conversation | undefined> {
    const file = ref.files[0];
    if (!file) return undefined;
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      return undefined;
    }
    let summary: SessionSummary | undefined;
    let error: string | undefined;
    try {
      summary = await this.summaryFor(file, st);
    } catch (err) {
      error = errorText(err);
      this.ctx.log(`could not read ${file}: ${error}`);
      if (st.size === 0) return undefined;
    }
    const customTitle = collapse(summary?.customTitle);
    if (summary && summary.requestCount === 0 && !customTitle) return undefined;

    const hit = this.indexEntryFor(ref);
    const entry = hit?.entry;
    const timing: JsonObject = entry && isObject(entry.timing) ? entry.timing : {};
    const indexTitle = collapse(entry?.title);
    const firstRequest = collapse(summary?.firstRequestText);
    const title =
      clip(customTitle || (PLACEHOLDER_TITLES.has(indexTitle.toLowerCase()) ? '' : indexTitle) || firstRequest, TITLE_MAX) ||
      (error ? 'Unreadable chat' : 'Untitled chat');
    const ws = this.workspaceInfo(ref.root, ref.workspaceHash, wsCache);
    return {
      source: 'vscode',
      id: makeItemId(ref.root.edition, ref.workspaceHash, ref.sessionId),
      kind: KIND,
      title,
      createdAt: toIso(firstMs(summary?.creationDate, timing.created, summary?.firstRequestAt, st.birthtimeMs)),
      updatedAt: toIso(
        maxMs(entry?.lastMessageDate, timing.lastRequestEnded, summary?.lastMessageDate, summary?.lastRequestAt) ?? asMs(st.mtimeMs),
      ),
      location: ws.location,
      messageCount: summary?.requestCount,
      preview: firstRequest ? clip(firstRequest, PREVIEW_MAX) : undefined,
      deleteMode: 'trash',
      note: error ? `Could not read this chat file (${error})` : undefined,
      extra: {
        edition: ref.root.edition,
        workspaceHash: ref.workspaceHash,
        sessionId: ref.sessionId,
        file,
        files: ref.files,
        format: formatOf(file),
        indexed: !!hit,
        indexDb: hit?.db,
        workspaceUri: ws.uri,
        partial: summary?.partial,
      },
    };
  }

  // ---- listing -------------------------------------------------------------------------------

  async list(progress?: Progress): Promise<Conversation[]> {
    const roots = this.existingRoots();
    const check = this.runningChecker(false);
    const running = new Map(roots.map((r) => [r.edition, check(r.edition)] as const));
    progress?.(0, undefined, 'Finding VS Code chats');
    const refs = roots.flatMap((r) => this.discover(r));
    const seen = new Set(refs.map((r) => r.files[0]));
    const wsCache = new Map<string, WorkspaceInfo>();
    let done = 0;
    const described = await mapLimit(refs, READ_CONCURRENCY, async (ref) => {
      try {
        return await this.describe(ref, wsCache);
      } catch (err) {
        this.ctx.log(`skipped ${ref.files[0]}: ${errorText(err)}`);
        return undefined;
      } finally {
        done++;
        progress?.(done, refs.length, `Reading VS Code chats (${done}/${refs.length})`);
      }
    });
    for (const file of this.summaryCache.keys()) if (!seen.has(file)) this.summaryCache.delete(file);

    const items: Conversation[] = [];
    for (const item of described) {
      if (!item) continue;
      const edition = String(item.extra?.edition);
      if (await (running.get(edition) ?? check(edition))) {
        item.deleteMode = 'none';
        item.note = `Close VS Code (${edition}) to delete this chat`;
      }
      items.push(item);
    }
    items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return items;
  }

  // ---- transcript --------------------------------------------------------------------------

  async getTranscript(item: Conversation): Promise<Transcript> {
    const parsed = parseItemId(item.id);
    if (!parsed) throw new Error(`Invalid VS Code chat id: ${item.id}`);
    const notes: string[] = [];
    let file = this.resolve(parsed)?.files[0];
    if (!file) {
      file = this.trashedSessionFile(item.id);
      if (file) notes.push('This chat is in the organizer trash.');
    }
    if (!file) throw new Error('Chat file not found; refresh the list');
    const { session, partial } = await readSessionFile(file);
    if (partial) notes.push('Some lines of the chat log could not be read.');
    const summary = summarize(session);
    const title =
      clip(collapse(summary.customTitle) || collapse(item.title) || collapse(summary.firstRequestText), TITLE_MAX) || 'Untitled chat';
    return {
      source: 'vscode',
      id: item.id,
      title,
      messages: buildTranscriptMessages(session),
      partial: partial || undefined,
      note: notes.length ? notes.join(' ') : undefined,
      raw: boundRaw(session),
    };
  }

  // ---- trash ---------------------------------------------------------------------------------

  private trashItemDir(id: string): string {
    return path.join(this.ctx.trashDir, safeName(id));
  }

  private trashedSessionFile(id: string): string | undefined {
    const dir = this.trashItemDir(id);
    const meta = readMeta(dir);
    if (!meta || meta.id !== id) return undefined;
    for (const f of meta.files) {
      const file = path.join(dir, path.basename(String(f.name)));
      if (formatOf(file) && isFile(file)) return file;
    }
    return undefined;
  }

  /** Moves aside a leftover trash folder without metadata so a new delete can use the name. */
  private clearStaleTrashDir(dir: string): void {
    if (!fs.existsSync(dir) || removeEmptyTree(dir)) return;
    const aside = `${dir}.orphan-${Date.now()}`;
    fs.renameSync(dir, aside);
    this.ctx.log(`moved leftover trash folder to ${aside}`);
  }

  /** Moves files back where they came from; returns false when one could not be moved. */
  private undoMoves(moves: Array<{ from: string; to: string }>): boolean {
    let ok = true;
    for (const m of [...moves].reverse()) {
      try {
        moveSync(m.to, m.from);
      } catch (err) {
        ok = false;
        this.ctx.log(`could not move ${m.to} back to ${m.from}: ${errorText(err)}`);
      }
    }
    return ok;
  }

  private discardTrashDir(dir: string): void {
    try {
      fs.rmSync(path.join(dir, META_FILE), { force: true });
    } catch {
      // keep going
    }
    removeEmptyTree(dir);
  }

  async deleteItems(items: Conversation[], progress?: Progress): Promise<ItemResult[]> {
    return this.exclusive(async () => {
      const running = this.runningChecker(true);
      const results: ItemResult[] = [];
      for (const item of items) {
        progress?.(results.length, items.length, `Moving to trash: ${item.title}`);
        try {
          results.push(await this.trashOne(item, running));
        } catch (err) {
          results.push({ id: item.id, ok: false, error: errorText(err) });
        }
      }
      const ok = results.filter((r) => r.ok).length;
      progress?.(results.length, items.length, `Moved ${ok} of ${items.length} chats to the trash`);
      return results;
    });
  }

  private async trashOne(item: Conversation, running: RunningCheck): Promise<ItemResult> {
    const id = item.id;
    const fail = (error: string, detail?: string): ItemResult => ({ id, ok: false, error, detail });
    if (item.source !== 'vscode') return fail('Not a VS Code chat');
    const parsed = parseItemId(id);
    if (!parsed) return fail('Invalid VS Code chat id');
    const ref = this.resolve(parsed);
    if (!ref) return fail(`${editionLabel(parsed.edition)} is not configured`);
    if (await running(parsed.edition)) {
      return fail('Close VS Code first', `${editionLabel(parsed.edition)} is running; it rewrites its chat index while open.`);
    }
    if (!ref.files.length) return fail('Chat file not found; it may already be deleted');
    const dir = this.trashItemDir(id);
    if (fs.existsSync(path.join(dir, META_FILE))) return fail('Already in the trash');

    const dbs = indexDbs(ref).filter(isFile);
    const indexEntries: TrashedIndexEntry[] = [];
    for (const db of dbs) {
      try {
        const index = readChatIndex(db);
        const entry = index?.entries[ref.sessionId];
        if (entry !== undefined) indexEntries.push({ db, key: CHAT_INDEX_KEY, entry, indexVersion: index?.version });
      } catch (err) {
        return fail('Could not read the VS Code chat index', errorText(err));
      }
    }

    let described: Conversation | undefined;
    try {
      described = await this.describe(ref);
    } catch {
      // fall back to the listed item
    }
    const meta: TrashMeta = {
      version: 1,
      source: 'vscode',
      id,
      kind: KIND,
      title: described?.title ?? item.title ?? 'Untitled chat',
      location: described?.location ?? item.location,
      createdAt: described?.createdAt ?? item.createdAt,
      updatedAt: described?.updatedAt ?? item.updatedAt,
      messageCount: described?.messageCount ?? item.messageCount,
      preview: described?.preview ?? item.preview,
      edition: parsed.edition,
      workspaceHash: parsed.workspaceHash,
      sessionId: parsed.sessionId,
      format: formatOf(ref.files[0]),
      deletedAt: new Date().toISOString(),
      complete: false,
      files: ref.files.map((f) => ({ original: f, name: path.basename(f) })),
      companions: [],
      indexEntries,
    };
    this.clearStaleTrashDir(dir);
    writeJsonAtomic(path.join(dir, META_FILE), meta);

    const moved: Array<{ from: string; to: string }> = [];
    try {
      for (const f of meta.files) {
        const to = path.join(dir, f.name);
        moveSync(f.original, to);
        moved.push({ from: f.original, to });
      }
    } catch (err) {
      if (this.undoMoves(moved)) this.discardTrashDir(dir);
      return fail('Could not move the chat file to the trash', errorText(err));
    }

    const removed: TrashedIndexEntry[] = [];
    try {
      for (const db of dbs) {
        const entry = removeIndexEntry(db, ref.sessionId);
        if (entry === undefined) continue;
        const indexVersion = indexEntries.find((e) => e.db === db)?.indexVersion;
        removed.push({ db, key: CHAT_INDEX_KEY, entry, indexVersion });
      }
    } catch (err) {
      let undone = true;
      for (const r of removed) {
        try {
          putIndexEntry(r.db, ref.sessionId, r.entry, r.indexVersion);
        } catch (e) {
          undone = false;
          this.ctx.log(`could not re-add the index entry of ${id} in ${r.db}: ${errorText(e)}`);
        }
      }
      // When undoing fails the trash folder keeps the files and metadata, so restore still works.
      if (this.undoMoves(moved) && undone) this.discardTrashDir(dir);
      return fail('Could not update the VS Code chat index', errorText(err));
    }

    const companions: TrashMeta['companions'] = [];
    let companionFailures = 0;
    const wsDir = path.join(workspaceStorageDir(ref.root), ref.workspaceHash);
    for (const original of companionPaths(ref)) {
      if (!fs.existsSync(original)) continue;
      const trashed = path.join('companions', path.relative(wsDir, original));
      try {
        moveSync(original, path.join(dir, trashed));
        companions.push({ original, trashed });
      } catch (err) {
        companionFailures++;
        this.ctx.log(`could not move ${original} to the trash: ${errorText(err)}`);
      }
    }

    meta.indexEntries = removed;
    meta.companions = companions;
    meta.complete = true;
    writeJsonAtomic(path.join(dir, META_FILE), meta);
    for (const f of meta.files) this.summaryCache.delete(f.original);
    return {
      id,
      ok: true,
      detail: companionFailures
        ? `Moved to the organizer trash; ${companionFailures} related item(s) stayed in VS Code's folder`
        : 'Moved to the organizer trash',
    };
  }

  async restoreItems(ids: string[]): Promise<ItemResult[]> {
    return this.exclusive(async () => {
      const running = this.runningChecker(true);
      const results: ItemResult[] = [];
      for (const id of ids) {
        try {
          results.push(await this.restoreOne(id, running));
        } catch (err) {
          results.push({ id, ok: false, error: errorText(err) });
        }
      }
      return results;
    });
  }

  private async restoreOne(id: string, running: RunningCheck): Promise<ItemResult> {
    const fail = (error: string, detail?: string): ItemResult => ({ id, ok: false, error, detail });
    const parsed = parseItemId(id);
    if (!parsed) return fail('Invalid VS Code chat id');
    const dir = this.trashItemDir(id);
    const meta = readMeta(dir);
    if (!meta || meta.id !== id) return fail('Not in the trash');
    const root = this.rootFor(parsed.edition);
    if (!root) return fail(`${editionLabel(parsed.edition)} is not configured`);
    if (await running(parsed.edition)) {
      return fail('Close VS Code first', `${editionLabel(parsed.edition)} is running; it rewrites its chat index while open.`);
    }

    // Destinations are rebuilt from the id and the configured root, not taken from the metadata.
    const homeDir = sessionsDir(root, parsed.workspaceHash);
    const allowedNames = new Set([`${parsed.sessionId}.jsonl`, `${parsed.sessionId}.json`]);
    const files: Array<{ from: string; to: string }> = [];
    for (const f of meta.files) {
      const name = String(f.name);
      if (!allowedNames.has(name)) return fail('Invalid trash metadata', `unexpected file name ${name}`);
      files.push({ from: path.join(dir, name), to: path.join(homeDir, name) });
    }
    if (!files.length) return fail('Invalid trash metadata', 'no session file recorded');

    const [wsDb, globalDb] = isEmptyWindowHash(parsed.workspaceHash)
      ? [undefined, globalStateDb(root)]
      : [path.join(workspaceStorageDir(root), parsed.workspaceHash, 'state.vscdb'), globalStateDb(root)];
    const entries: TrashedIndexEntry[] = [];
    for (const e of meta.indexEntries) {
      const db = typeof e.db === 'string' && samePath(e.db, globalDb) ? globalDb : wsDb && typeof e.db === 'string' && samePath(e.db, wsDb) ? wsDb : undefined;
      if (!db || e.key !== CHAT_INDEX_KEY || e.entry === undefined) return fail('Invalid trash metadata', 'unexpected index location');
      entries.push({ ...e, db });
    }
    const companions: Array<{ from: string; to: string }> = [];
    const wsDir = path.join(workspaceStorageDir(root), parsed.workspaceHash);
    for (const c of meta.companions) {
      const from = path.join(dir, String(c.trashed));
      const to = String(c.original);
      if (!isInside(from, [dir]) || !isInside(to, [wsDir])) return fail('Invalid trash metadata', 'unexpected related path');
      companions.push({ from, to });
    }

    for (const f of files) {
      const inTrash = fs.existsSync(f.from);
      const atHome = fs.existsSync(f.to);
      if (inTrash && atHome) return fail('A chat with this id already exists in VS Code', f.to);
      if (!inTrash && !atHome) return fail('The trashed chat file is missing', f.from);
    }
    for (const e of entries) if (!isFile(e.db)) return fail('VS Code state database not found', e.db);

    const moved: Array<{ from: string; to: string }> = [];
    try {
      for (const f of files) {
        if (!fs.existsSync(f.from)) continue; // already back (interrupted delete or restore)
        moveSync(f.from, f.to);
        moved.push(f);
      }
    } catch (err) {
      this.undoMoves(moved);
      return fail('Could not move the chat file back', errorText(err));
    }

    const applied: Array<{ db: string; previous: unknown }> = [];
    try {
      for (const e of entries) {
        applied.push({ db: e.db, previous: putIndexEntry(e.db, parsed.sessionId, e.entry, e.indexVersion ?? 1) });
      }
    } catch (err) {
      for (const a of applied.reverse()) {
        try {
          if (a.previous === undefined) removeIndexEntry(a.db, parsed.sessionId);
          else putIndexEntry(a.db, parsed.sessionId, a.previous);
        } catch (e) {
          this.ctx.log(`could not undo the index change of ${id} in ${a.db}: ${errorText(e)}`);
        }
      }
      this.undoMoves(moved);
      return fail('Could not update the VS Code chat index', errorText(err));
    }

    let left = 0;
    for (const c of companions) {
      if (!fs.existsSync(c.from)) continue;
      try {
        moveSync(c.from, c.to);
      } catch (err) {
        left++;
        this.ctx.log(`could not move ${c.from} back to ${c.to}: ${errorText(err)}`);
      }
    }

    this.discardTrashDir(dir);
    for (const f of files) this.summaryCache.delete(f.to);
    return {
      id,
      ok: true,
      detail: left ? `Restored; ${left} related item(s) were left in the organizer trash folder` : 'Restored to VS Code',
    };
  }

  async listTrash(): Promise<Conversation[]> {
    let names: string[];
    try {
      names = fs.readdirSync(this.ctx.trashDir);
    } catch {
      return [];
    }
    const items: Array<{ item: Conversation; deletedAt: string }> = [];
    for (const name of names) {
      const dir = path.join(this.ctx.trashDir, name);
      const meta = readMeta(dir);
      if (!meta || !parseItemId(meta.id) || !samePath(this.trashItemDir(meta.id), dir)) continue;
      const deletedAt = typeof meta.deletedAt === 'string' ? meta.deletedAt : '';
      items.push({
        deletedAt,
        item: {
          source: 'vscode',
          id: meta.id,
          kind: meta.kind || KIND,
          title: meta.title || 'Untitled chat',
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          location: meta.location,
          messageCount: meta.messageCount,
          preview: meta.preview,
          status: 'In trash',
          deleteMode: 'none',
          deletedAt: deletedAt || undefined,
          note: meta.complete === false ? 'The move to the trash did not finish; restore it to put it back' : undefined,
          extra: {
            edition: meta.edition,
            workspaceHash: meta.workspaceHash,
            sessionId: meta.sessionId,
            format: meta.format,
            deletedAt: meta.deletedAt,
            trashDir: dir,
          },
        },
      });
    }
    items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    return items.map((x) => x.item);
  }
}
