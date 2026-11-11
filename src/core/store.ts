// Local, private state for the organizer. Everything lives under the data directory
// (default: <repo>/.data, gitignored) because it can contain conversation content.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Conversation, Project, SourceId } from './types.ts';
import { UserError } from './errors.ts';

export interface Collection {
  id: string;
  name: string;
  color?: string;
  createdAt: string;
}

interface CollectionsFile {
  collections: Collection[];
  /** collectionId -> item keys ("source:id"). */
  members: Record<string, string[]>;
}

export interface HandoffEntry {
  key: string;
  source: SourceId;
  id: string;
  title: string;
  url?: string;
  queuedAt: string;
}

export interface OpLogEntry {
  at: string;
  op: string;
  source?: SourceId;
  target?: string;
  ok: number;
  failed: number;
  details?: unknown;
}

export interface CachedListing {
  fetchedAt: string;
  items: Conversation[];
}

const DEFAULT_TOMBSTONE_TTL_MS = 30 * 60 * 1000;

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

/** File-name-safe rendering of an arbitrary id (keeps it readable, adds a hash for uniqueness). */
export function safeName(id: string): string {
  const readable = id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const hash = crypto.createHash('sha1').update(id).digest('hex').slice(0, 8);
  return `${readable}-${hash}`;
}

export class Store {
  readonly dataDir: string;
  private readonly tombstoneTtlMs: number;

  constructor(dataDir: string, options: { tombstoneTtlMs?: number } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  file(...parts: string[]): string {
    return path.join(this.dataDir, ...parts);
  }

  trashDir(source: SourceId): string {
    return this.file('trash', source);
  }

  // ---- listing cache -------------------------------------------------------------

  readCache(source: SourceId): CachedListing | undefined {
    const c = readJson<CachedListing | null>(this.file('cache', `${source}.json`), null);
    return c && Array.isArray(c.items) ? c : undefined;
  }

  writeCache(source: SourceId, items: Conversation[]): CachedListing {
    const listing = { fetchedAt: new Date().toISOString(), items };
    writeJsonAtomic(this.file('cache', `${source}.json`), listing);
    return listing;
  }

  /** Updates cached items in place (e.g. after a move) without refetching. */
  patchCache(source: SourceId, update: (items: Conversation[]) => Conversation[]): void {
    const c = this.readCache(source);
    if (!c) return;
    writeJsonAtomic(this.file('cache', `${source}.json`), { fetchedAt: c.fetchedAt, items: update(c.items) });
  }

  readProjects(source: SourceId): { fetchedAt: string; projects: Project[] } | undefined {
    const c = readJson<{ fetchedAt: string; projects: Project[] } | null>(this.file('cache', `${source}-projects.json`), null);
    return c && Array.isArray(c.projects) ? c : undefined;
  }

  writeProjects(source: SourceId, projects: Project[]): void {
    writeJsonAtomic(this.file('cache', `${source}-projects.json`), { fetchedAt: new Date().toISOString(), projects });
  }

  patchProjects(source: SourceId, update: (projects: Project[]) => Project[]): void {
    const c = this.readProjects(source);
    if (!c) return;
    writeJsonAtomic(this.file('cache', `${source}-projects.json`), { fetchedAt: c.fetchedAt, projects: update(c.projects) });
  }

  // ---- tombstones (hide deleted items that a stale server cache still returns) ----

  private tombstones(): Record<string, number> {
    const all = readJson<Record<string, number>>(this.file('tombstones.json'), {});
    const now = Date.now();
    for (const [k, t] of Object.entries(all)) if (now - t > this.tombstoneTtlMs) delete all[k];
    return all;
  }

  addTombstones(keys: string[]): void {
    if (!keys.length) return;
    const all = this.tombstones();
    const now = Date.now();
    for (const k of keys) all[k] = now;
    writeJsonAtomic(this.file('tombstones.json'), all);
  }

  removeTombstones(keys: string[]): void {
    const all = this.tombstones();
    let changed = false;
    for (const k of keys) {
      if (k in all) {
        delete all[k];
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(this.file('tombstones.json'), all);
  }

  withoutTombstoned(items: Conversation[]): Conversation[] {
    const all = this.tombstones();
    return items.filter((i) => !(`${i.source}:${i.id}` in all));
  }

  // ---- local collections (cross-source grouping) ---------------------------------

  private readCollections(): CollectionsFile {
    const c = readJson<CollectionsFile>(this.file('collections.json'), { collections: [], members: {} });
    c.collections ??= [];
    c.members ??= {};
    return c;
  }

  listCollections(): Array<Collection & { members: string[] }> {
    const c = this.readCollections();
    return c.collections.map((col) => ({ ...col, members: c.members[col.id] ?? [] }));
  }

  createCollection(name: string, color?: string): Collection {
    const trimmed = name.trim();
    if (!trimmed) throw new UserError('Collection name is required');
    const c = this.readCollections();
    if (c.collections.some((x) => x.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new UserError(`A collection named "${trimmed}" already exists`);
    }
    const col: Collection = { id: crypto.randomUUID(), name: trimmed, color, createdAt: new Date().toISOString() };
    c.collections.push(col);
    c.members[col.id] = [];
    writeJsonAtomic(this.file('collections.json'), c);
    return col;
  }

  updateCollection(id: string, patch: { name?: string; color?: string | null }): Collection {
    const c = this.readCollections();
    const col = c.collections.find((x) => x.id === id);
    if (!col) throw new UserError(`Unknown collection ${id}`);
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new UserError('Collection name is required');
      col.name = trimmed;
    }
    if (patch.color === null) delete col.color;
    else if (patch.color !== undefined) col.color = patch.color;
    writeJsonAtomic(this.file('collections.json'), c);
    return col;
  }

  deleteCollection(id: string): void {
    const c = this.readCollections();
    c.collections = c.collections.filter((x) => x.id !== id);
    delete c.members[id];
    writeJsonAtomic(this.file('collections.json'), c);
  }

  addToCollection(id: string, keys: string[]): number {
    const c = this.readCollections();
    if (!c.collections.some((x) => x.id === id)) throw new UserError(`Unknown collection ${id}`);
    const set = new Set(c.members[id] ?? []);
    const before = set.size;
    for (const k of keys) set.add(k);
    c.members[id] = [...set];
    writeJsonAtomic(this.file('collections.json'), c);
    return set.size - before;
  }

  removeFromCollection(id: string, keys: string[]): number {
    const c = this.readCollections();
    if (!c.collections.some((x) => x.id === id)) throw new UserError(`Unknown collection ${id}`);
    const drop = new Set(keys);
    const before = (c.members[id] ?? []).length;
    c.members[id] = (c.members[id] ?? []).filter((k) => !drop.has(k));
    writeJsonAtomic(this.file('collections.json'), c);
    return before - c.members[id].length;
  }

  /** Removes deleted items from every collection. */
  forgetItems(keys: string[]): void {
    const drop = new Set(keys);
    const c = this.readCollections();
    let changed = false;
    for (const id of Object.keys(c.members)) {
      const next = c.members[id].filter((k) => !drop.has(k));
      if (next.length !== c.members[id].length) {
        c.members[id] = next;
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(this.file('collections.json'), c);
  }

  // ---- hand-off queue (deletions another app must perform) ------------------------

  listHandoff(): HandoffEntry[] {
    return readJson<HandoffEntry[]>(this.file('handoff.json'), []);
  }

  queueHandoff(items: Conversation[]): number {
    const queue = this.listHandoff();
    const have = new Set(queue.map((q) => q.key));
    let added = 0;
    for (const i of items) {
      const key = `${i.source}:${i.id}`;
      if (have.has(key)) continue;
      queue.push({ key, source: i.source, id: i.id, title: i.title, url: i.url, queuedAt: new Date().toISOString() });
      have.add(key);
      added++;
    }
    writeJsonAtomic(this.file('handoff.json'), queue);
    return added;
  }

  removeHandoff(keys: string[]): void {
    const drop = new Set(keys);
    writeJsonAtomic(
      this.file('handoff.json'),
      this.listHandoff().filter((q) => !drop.has(q.key)),
    );
  }

  // ---- backups and operation log ---------------------------------------------------

  writeBackup(source: SourceId, id: string, data: unknown): string {
    const day = new Date().toISOString().slice(0, 10);
    const file = this.file('backups', day, source, `${safeName(id)}.json`);
    writeJsonAtomic(file, { source, id, savedAt: new Date().toISOString(), data });
    return file;
  }

  appendOp(entry: Omit<OpLogEntry, 'at'>): OpLogEntry {
    const full: OpLogEntry = { at: new Date().toISOString(), ...entry };
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.appendFileSync(this.file('oplog.jsonl'), JSON.stringify(full) + '\n');
    return full;
  }

  readOps(limit = 200): OpLogEntry[] {
    let text = '';
    try {
      text = fs.readFileSync(this.file('oplog.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n').filter(Boolean);
    const out: OpLogEntry[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line) as OpLogEntry);
      } catch {
        // skip a torn line
      }
    }
    return out.reverse();
  }
}
