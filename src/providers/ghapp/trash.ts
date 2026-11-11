// Organizer trash for CLI-only sessions. A trashed session is one folder:
//   <trashDir>/<safeName(id)>/meta.json        what was deleted, from where, when
//   <trashDir>/<safeName(id)>/index-rows.json  every session-store.db row of the session
//   <trashDir>/<safeName(id)>/session-state/   the moved session-state/<id> folder
// App-managed sessions are never touched here; the organizer hands them off to the app.
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readJson, safeName, writeJsonAtomic } from '../../core/store.ts';
import type { Conversation, ItemResult, Progress } from '../../core/types.ts';
import { AppOwnership } from './appdb.ts';
import { lockPidsFrom, moveDir } from './scan.ts';
import { deleteSessionRows, exportSessionRows, insertSessionRows, openStoreWritable } from './storedb.ts';
import type { ExportedSession, IndexRows } from './storedb.ts';
import { compact, errorMessage, isInside, isSafeId, pidAlive } from './util.ts';

export interface GhAppPaths {
  home: string;
  appDb: string;
  storeDb: string;
  stateDir: string;
  trashDir: string;
}

export interface TrashMeta {
  version: 1;
  source: 'ghapp';
  id: string;
  kind: string;
  title: string;
  location?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  home: string;
  originalDir: string;
  hadDir: boolean;
  storeDb: string;
  deletedAt: string;
  rowCounts: Record<string, number>;
  extra?: Record<string, unknown>;
}

export const TRASHABLE_KINDS: ReadonlySet<string> = new Set(['cli-session', 'cli-index-only']);
export const META_FILE = 'meta.json';
export const ROWS_FILE = 'index-rows.json';
export const STATE_DIR = 'session-state';

export function trashFolder(paths: GhAppPaths, id: string): string {
  return path.join(paths.trashDir, safeName(id));
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** Lazily opened, shared read-write connection to session-store.db (undefined when the file is missing). */
class StoreHandle {
  private db?: DatabaseSync;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  get(): DatabaseSync | undefined {
    if (!this.db) {
      if (!exists(this.file)) return undefined;
      try {
        this.db = openStoreWritable(this.file);
      } catch (e) {
        throw new Error(`Could not open the CLI session index (session-store.db): ${errorMessage(e)}`);
      }
    }
    return this.db;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
    this.db = undefined;
  }
}

function rollback(db: DatabaseSync | undefined): void {
  try {
    if (db?.isTransaction) db.exec('ROLLBACK');
  } catch {
    // SQLite may already have rolled back
  }
}

const fail = (id: string, error: string): ItemResult => ({ id, ok: false, error });

export async function trashSessions(paths: GhAppPaths, items: Conversation[], progress?: Progress): Promise<ItemResult[]> {
  if (!items.length) return [];
  if (isInside(paths.trashDir, paths.home) || isInside(paths.home, paths.trashDir)) {
    return items.map((i) => fail(i.id, 'The organizer trash folder overlaps the Copilot home folder; refusing to move sessions'));
  }
  const results: ItemResult[] = [];
  const owner = new AppOwnership(paths.appDb, exists(paths.appDb));
  const store = new StoreHandle(paths.storeDb);
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      progress?.(i, items.length, `Moving to trash: ${item.title}`);
      try {
        results.push(await trashOne(paths, item, owner, store));
      } catch (e) {
        results.push(fail(item.id, errorMessage(e)));
      }
    }
    progress?.(items.length, items.length, 'Moved to trash');
  } finally {
    owner.close();
    store.close();
  }
  return results;
}

async function trashOne(paths: GhAppPaths, item: Conversation, owner: AppOwnership, store: StoreHandle): Promise<ItemResult> {
  const id = item.id;
  if (item.source !== 'ghapp') return fail(id, 'Not a GitHub Copilot app or CLI item');
  if (!isSafeId(id)) return fail(id, 'Invalid session id');
  if (!TRASHABLE_KINDS.has(item.kind)) {
    return fail(
      id,
      item.kind.startsWith('app-')
        ? 'Owned by the GitHub Copilot app — deletion is handed off to the app, not done here'
        : `Items of kind "${item.kind}" cannot be moved to the trash`,
    );
  }
  if (item.deleteMode !== 'trash') return fail(id, item.note ?? 'This item cannot be deleted here');

  // Re-verify everything at delete time: the listing may be stale.
  const refusal = owner.refusal(id);
  if (refusal) return fail(id, refusal);
  const dir = path.join(paths.stateDir, id);
  let hasDir = false;
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return fail(id, 'The session path is not a regular folder');
    hasDir = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return fail(id, `Cannot inspect the session folder: ${errorMessage(e)}`);
  }
  if (item.kind === 'cli-session' && !hasDir) return fail(id, 'The session folder no longer exists; refresh the list');
  if (item.kind === 'cli-index-only' && hasDir) return fail(id, 'A session folder exists for this session now; refresh the list');
  if (hasDir && lockPidsFrom(fs.readdirSync(dir)).some((pid) => pidAlive(pid))) return fail(id, 'In use by a running Copilot process');
  const folder = trashFolder(paths, id);
  if (exists(folder)) return fail(id, 'The organizer trash already holds this session; restore it or empty the trash first');
  const db = store.get();
  if (!db && item.kind === 'cli-index-only') return fail(id, 'The CLI session index (session-store.db) was not found');

  const trashedState = path.join(folder, STATE_DIR);
  let moved = false;
  try {
    let exported: ExportedSession | undefined;
    if (db) {
      db.exec('BEGIN IMMEDIATE');
      exported = exportSessionRows(db, id);
    }
    if (item.kind === 'cli-index-only' && !exported?.total) throw new Error('No index rows were found for this session; refresh the list');
    const rows: IndexRows = exported?.rows ?? { version: 1, sessionId: id, exportedAt: new Date().toISOString(), tables: {} };
    const rowCounts = Object.fromEntries(Object.entries(rows.tables).map(([name, t]) => [name, t.rows.length]));
    const meta: TrashMeta = {
      version: 1,
      source: 'ghapp',
      id,
      kind: item.kind,
      title: item.title,
      location: item.location,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      messageCount: item.messageCount,
      home: paths.home,
      originalDir: dir,
      hadDir: hasDir,
      storeDb: paths.storeDb,
      deletedAt: new Date().toISOString(),
      rowCounts,
      extra: compact({
        branch: item.extra?.branch,
        cwd: item.extra?.cwd,
        repository: item.extra?.repository,
        clientName: item.extra?.clientName,
        hostType: item.extra?.hostType,
      }),
    };
    writeJsonAtomic(path.join(folder, ROWS_FILE), rows);
    writeJsonAtomic(path.join(folder, META_FILE), meta);
    if (hasDir) {
      await moveDir(dir, trashedState);
      moved = true;
    }
    if (db && exported) {
      deleteSessionRows(db, exported);
      db.exec('COMMIT');
    }
    const total = exported?.total ?? 0;
    return { id, ok: true, detail: `Moved to the organizer trash${total ? ` with ${total} index rows` : ''}` };
  } catch (e) {
    const error = errorMessage(e);
    rollback(db);
    if (moved) {
      try {
        await moveDir(trashedState, dir);
      } catch (back) {
        return fail(id, `${error}. The session folder could not be moved back and is kept at ${trashedState} (${errorMessage(back)})`);
      }
    }
    if (exists(trashedState)) return fail(id, `${error}. Part of the session folder is kept at ${trashedState}`);
    fs.rmSync(folder, { recursive: true, force: true });
    return fail(id, error);
  }
}

export async function restoreSessions(paths: GhAppPaths, ids: string[]): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  const store = new StoreHandle(paths.storeDb);
  try {
    for (const id of ids) {
      try {
        results.push(await restoreOne(paths, id, store));
      } catch (e) {
        results.push(fail(id, errorMessage(e)));
      }
    }
  } finally {
    store.close();
  }
  return results;
}

function rowTotal(rows: IndexRows | null): number {
  if (!rows || typeof rows.tables !== 'object' || !rows.tables) return 0;
  return Object.values(rows.tables).reduce((n, t) => n + (Array.isArray(t?.rows) ? t.rows.length : 0), 0);
}

async function restoreOne(paths: GhAppPaths, id: string, store: StoreHandle): Promise<ItemResult> {
  if (!isSafeId(id)) return fail(id, 'Invalid session id');
  const folder = trashFolder(paths, id);
  const meta = readJson<TrashMeta | null>(path.join(folder, META_FILE), null);
  if (!meta || meta.id !== id) return fail(id, 'Not found in the organizer trash');
  if (meta.home && !samePath(meta.home, paths.home)) {
    return fail(id, `This session was deleted from ${meta.home}; restore it with the organizer pointed at that Copilot home`);
  }
  const dest = path.join(paths.stateDir, id);
  const trashedState = path.join(folder, STATE_DIR);
  const hasState = exists(trashedState);
  if (meta.hadDir && !hasState) return fail(id, 'The trashed session folder is missing');
  if (hasState && exists(dest)) return fail(id, 'A session folder with this id already exists; not overwriting it');
  const rows = readJson<IndexRows | null>(path.join(folder, ROWS_FILE), null);
  const expected = Object.values(meta.rowCounts ?? {}).reduce((n, c) => n + Number(c || 0), 0);
  if (expected > 0 && !rows) return fail(id, 'The saved index rows (index-rows.json) are missing or unreadable');
  if (rows && rows.sessionId !== id) return fail(id, 'The saved index rows belong to a different session');
  const total = rowTotal(rows);
  const db = total ? store.get() : undefined;
  if (total && !db) return fail(id, 'The CLI session index (session-store.db) was not found');

  let moved = false;
  let inserted = 0;
  let skipped: string[] = [];
  try {
    if (db && rows) {
      db.exec('BEGIN IMMEDIATE');
      const r = insertSessionRows(db, rows);
      inserted = r.inserted;
      skipped = r.skippedTables;
    }
    if (hasState) {
      await moveDir(trashedState, dest);
      moved = true;
    }
    if (db?.isTransaction) db.exec('COMMIT');
  } catch (e) {
    const error = errorMessage(e);
    rollback(db);
    if (moved) {
      try {
        await moveDir(dest, trashedState);
      } catch (back) {
        return fail(id, `${error}. The session folder was restored to ${dest} but its index rows were not (${errorMessage(back)})`);
      }
    }
    return fail(id, error);
  }
  const notes: string[] = [];
  if (total) notes.push(`${inserted} of ${total} index rows restored`);
  if (skipped.length) notes.push(`tables no longer present: ${skipped.join(', ')}`);
  try {
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    notes.push(`the trash copy could not be removed (${errorMessage(e)})`);
  }
  return { id, ok: true, detail: notes.length ? `Restored; ${notes.join('; ')}` : 'Restored' };
}

export function readTrashMeta(paths: GhAppPaths, id: string): TrashMeta | undefined {
  const meta = readJson<TrashMeta | null>(path.join(trashFolder(paths, id), META_FILE), null);
  return meta && meta.id === id ? meta : undefined;
}

export function readTrashRows(paths: GhAppPaths, id: string): IndexRows | undefined {
  const rows = readJson<IndexRows | null>(path.join(trashFolder(paths, id), ROWS_FILE), null);
  return rows && rows.sessionId === id ? rows : undefined;
}

export function listTrashed(paths: GhAppPaths): Conversation[] {
  let names: string[];
  try {
    names = fs.readdirSync(paths.trashDir);
  } catch {
    return [];
  }
  const items: Conversation[] = [];
  for (const name of names) {
    const folder = path.join(paths.trashDir, name);
    const meta = readJson<TrashMeta | null>(path.join(folder, META_FILE), null);
    if (!meta || meta.source !== 'ghapp' || !isSafeId(meta.id) || safeName(meta.id) !== name) continue;
    const indexRows = Object.values(meta.rowCounts ?? {}).reduce((n, c) => n + Number(c || 0), 0);
    items.push({
      source: 'ghapp',
      id: meta.id,
      kind: meta.kind || 'cli-session',
      title: meta.title || 'Untitled session',
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      location: meta.location,
      messageCount: meta.messageCount,
      status: 'In trash',
      deleteMode: 'none',
      deletedAt: meta.deletedAt || undefined,
      note: 'In the organizer trash; restoring puts the session folder and index rows back',
      extra: compact({
        deletedAt: meta.deletedAt,
        trashPath: folder,
        hasSessionFolder: exists(path.join(folder, STATE_DIR)),
        indexRows,
        originalDir: meta.originalDir,
      }),
    });
  }
  items.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  return items;
}
