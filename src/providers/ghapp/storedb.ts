// session-store.db: the Copilot CLI's session index (sessions, turns, checkpoints, files,
// usage, and an FTS5 search_index). Listing and transcripts open it read-only; only the
// trash/restore path opens it for writing.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { toIso } from '../../core/types.ts';
import { listTables, quoteIdent, tableColumns } from './sqlutil.ts';
import type { TableInfo } from './sqlutil.ts';
import { text } from './util.ts';

export interface StoreSession {
  id: string;
  cwd?: string;
  repository?: string;
  branch?: string;
  summary?: string;
  hostType?: string;
  createdAt?: string;
  updatedAt?: string;
  turnCount: number;
  firstTurnAt?: string;
  lastTurnAt?: string;
  /** Start of the first non-empty user message. */
  firstUser?: string;
  /** Start of the latest non-empty assistant response. */
  lastAssistant?: string;
}

type Row = Record<string, SQLOutputValue>;

const SNIPPET = 600;

export function openStoreReadOnly(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true, timeout: 3000 });
}

/** Opens the index for writing; refuses to create a missing database. */
export function openStoreWritable(file: string): DatabaseSync {
  if (!fs.existsSync(file)) throw new Error(`CLI session index not found: ${file}`);
  const db = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: false });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function sessionFor(map: Map<string, StoreSession>, id: string): StoreSession {
  let s = map.get(id);
  if (!s) {
    s = { id, turnCount: 0 };
    map.set(id, s);
  }
  return s;
}

/** Bulk listing data: one query per aspect, never per session. */
export function readStoreIndex(file: string): Map<string, StoreSession> {
  const db = openStoreReadOnly(file);
  try {
    const map = new Map<string, StoreSession>();
    const cols = tableColumns(db, 'sessions');
    if (cols.has('id')) {
      const wanted = ['id', 'cwd', 'repository', 'branch', 'summary', 'host_type', 'created_at', 'updated_at'].filter((c) => cols.has(c));
      for (const r of db.prepare(`SELECT ${wanted.map(quoteIdent).join(', ')} FROM sessions`).all() as Row[]) {
        const id = text(r.id);
        if (!id) continue;
        Object.assign(sessionFor(map, id), {
          cwd: text(r.cwd),
          repository: text(r.repository),
          branch: text(r.branch),
          summary: text(r.summary),
          hostType: text(r.host_type),
          createdAt: toIso(r.created_at),
          updatedAt: toIso(r.updated_at),
        });
      }
    }
    const turnCols = tableColumns(db, 'turns');
    if (turnCols.has('session_id')) {
      const ts = turnCols.has('timestamp');
      const counts = db.prepare(
        `SELECT session_id, count(*) AS n${ts ? ', min("timestamp") AS first_at, max("timestamp") AS last_at' : ''}
           FROM turns GROUP BY session_id`,
      ).all() as Row[];
      for (const r of counts) {
        const id = text(r.session_id);
        if (!id) continue;
        const s = sessionFor(map, id);
        s.turnCount = Number(r.n);
        s.firstTurnAt = toIso(r.first_at);
        s.lastTurnAt = toIso(r.last_at);
      }
      if (turnCols.has('turn_index') && turnCols.has('user_message')) {
        // SQLite returns the bare column from the row that holds the min()/max().
        const firsts = db.prepare(
          `SELECT session_id, min(turn_index) AS ti, substr(user_message, 1, ${SNIPPET}) AS msg
             FROM turns WHERE user_message IS NOT NULL AND trim(substr(user_message, 1, ${SNIPPET})) <> ''
            GROUP BY session_id`,
        ).all() as Row[];
        for (const r of firsts) {
          const id = text(r.session_id);
          if (id && typeof r.msg === 'string') sessionFor(map, id).firstUser = r.msg;
        }
      }
      if (turnCols.has('turn_index') && turnCols.has('assistant_response')) {
        const lasts = db.prepare(
          `SELECT session_id, max(turn_index) AS ti, substr(assistant_response, 1, ${SNIPPET}) AS msg
             FROM turns WHERE assistant_response IS NOT NULL AND trim(substr(assistant_response, 1, ${SNIPPET})) <> ''
            GROUP BY session_id`,
        ).all() as Row[];
        for (const r of lasts) {
          const id = text(r.session_id);
          if (id && typeof r.msg === 'string') sessionFor(map, id).lastAssistant = r.msg;
        }
      }
    }
    return map;
  } finally {
    db.close();
  }
}

export interface StoreTurn {
  turnIndex: number;
  userMessage?: string;
  assistantResponse?: string;
  timestamp?: string;
}

export interface StoreCheckpoint {
  number: number;
  title?: string;
  overview?: string;
  createdAt?: string;
}

export interface SessionDetail {
  turns: StoreTurn[];
  checkpoints: StoreCheckpoint[];
}

function selectForSession(db: DatabaseSync, table: string, wanted: string[], order: string, id: string): Row[] {
  const cols = tableColumns(db, table);
  if (!cols.has('session_id')) return [];
  const list = wanted.filter((c) => cols.has(c));
  const orderBy = cols.has(order) ? ` ORDER BY ${quoteIdent(order)}` : '';
  return db.prepare(`SELECT ${list.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)} WHERE session_id = ?${orderBy}`).all(id) as Row[];
}

const str = (v: SQLOutputValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export function readSessionDetail(file: string, id: string): SessionDetail {
  const db = openStoreReadOnly(file);
  try {
    const turns = selectForSession(db, 'turns', ['turn_index', 'user_message', 'assistant_response', 'timestamp'], 'turn_index', id).map(
      (r): StoreTurn => ({
        turnIndex: Number(r.turn_index ?? 0),
        userMessage: str(r.user_message),
        assistantResponse: str(r.assistant_response),
        timestamp: toIso(r.timestamp),
      }),
    );
    const checkpoints = selectForSession(db, 'checkpoints', ['checkpoint_number', 'title', 'overview', 'created_at'], 'checkpoint_number', id).map(
      (r): StoreCheckpoint => ({
        number: Number(r.checkpoint_number ?? 0),
        title: str(r.title),
        overview: str(r.overview),
        createdAt: toIso(r.created_at),
      }),
    );
    return { turns, checkpoints };
  } finally {
    db.close();
  }
}

// ---- export / delete / restore of one session's rows -----------------------------------

/**
 * JSON-safe SQLite value. Integers are plain JSON integers (or {$bigint} beyond 2^53),
 * REALs that look like integers are tagged {$real} so they keep their storage class.
 */
export type EncodedValue =
  | null
  | number
  | string
  | { $bigint: string }
  | { $real: number }
  | { $num: string }
  | { $blob: string };

export interface ExportedTable {
  columns: string[];
  rows: EncodedValue[][];
  virtual?: boolean;
}

export interface IndexRows {
  version: 1;
  sessionId: string;
  exportedAt: string;
  tables: Record<string, ExportedTable>;
}

export function encodeValue(v: SQLOutputValue): EncodedValue {
  if (v === null || typeof v === 'string') return v;
  if (typeof v === 'bigint') {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : { $bigint: v.toString() };
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { $num: String(v) };
    return Number.isInteger(v) ? { $real: v } : v;
  }
  return { $blob: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
}

export function decodeValue(v: unknown): SQLInputValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : v;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$bigint === 'string') return BigInt(o.$bigint);
    if (typeof o.$real === 'number') return o.$real;
    if (typeof o.$num === 'string') return Number(o.$num);
    if (typeof o.$blob === 'string') return Buffer.from(o.$blob, 'base64');
  }
  throw new Error(`Unsupported value in exported rows: ${JSON.stringify(v)}`);
}

/** Tables holding rows for a session: `sessions` by id, everything else by session_id. */
export function sessionTables(db: DatabaseSync): Array<TableInfo & { key: string }> {
  const out: Array<TableInfo & { key: string }> = [];
  for (const t of listTables(db)) {
    if (t.name === 'sessions') {
      if (t.columns.includes('id')) out.push({ ...t, key: 'id' });
    } else if (t.columns.includes('session_id')) out.push({ ...t, key: 'session_id' });
  }
  return out;
}

export interface ExportedSession {
  rows: IndexRows;
  total: number;
  /** rowids of virtual-table rows, so the delete does not rescan unindexed columns. */
  virtualRowids: Map<string, bigint[]>;
}

/** Reads every row that belongs to the session. Run inside the delete transaction. */
export function exportSessionRows(db: DatabaseSync, sessionId: string): ExportedSession {
  const tables: Record<string, ExportedTable> = {};
  const virtualRowids = new Map<string, bigint[]>();
  let total = 0;
  for (const t of sessionTables(db)) {
    const select = t.virtual ? ['rowid AS "__rowid"', ...t.columns.map(quoteIdent)] : t.columns.map(quoteIdent);
    const stmt = db.prepare(`SELECT ${select.join(', ')} FROM ${quoteIdent(t.name)} WHERE ${quoteIdent(t.key)} = ?`);
    stmt.setReadBigInts(true);
    const rows = stmt.all(sessionId) as Row[];
    if (!rows.length) continue;
    if (t.virtual) virtualRowids.set(t.name, rows.map((r) => r.__rowid as bigint));
    tables[t.name] = {
      columns: t.columns,
      rows: rows.map((r) => t.columns.map((c) => encodeValue(r[c] ?? null))),
      ...(t.virtual ? { virtual: true } : {}),
    };
    total += rows.length;
  }
  return { rows: { version: 1, sessionId, exportedAt: new Date().toISOString(), tables }, total, virtualRowids };
}

/** Deletes the exported rows: children first, then the sessions row. */
export function deleteSessionRows(db: DatabaseSync, exported: ExportedSession): number {
  const sessionId = exported.rows.sessionId;
  const names = Object.keys(exported.rows.tables).sort((a, b) => Number(a === 'sessions') - Number(b === 'sessions'));
  let changes = 0;
  for (const name of names) {
    const rowids = exported.virtualRowids.get(name);
    if (rowids) {
      const del = db.prepare(`DELETE FROM ${quoteIdent(name)} WHERE rowid = ?`);
      for (const rowid of rowids) changes += Number(del.run(rowid).changes);
    } else {
      const key = name === 'sessions' ? 'id' : 'session_id';
      changes += Number(db.prepare(`DELETE FROM ${quoteIdent(name)} WHERE ${quoteIdent(key)} = ?`).run(sessionId).changes);
    }
  }
  return changes;
}

export interface InsertResult {
  inserted: number;
  total: number;
  skippedTables: string[];
}

/** Re-inserts exported rows (sessions first). Existing rows win; FTS rows are only added when absent. */
export function insertSessionRows(db: DatabaseSync, data: IndexRows): InsertResult {
  const current = new Map(listTables(db).map((t) => [t.name, t]));
  const names = Object.keys(data.tables).sort((a, b) => Number(b === 'sessions') - Number(a === 'sessions'));
  const result: InsertResult = { inserted: 0, total: 0, skippedTables: [] };
  for (const name of names) {
    const table = data.tables[name];
    if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) continue;
    result.total += table.rows.length;
    const target = current.get(name);
    if (!target) {
      result.skippedTables.push(name);
      continue;
    }
    const keep = table.columns.map((c, i) => [c, i] as const).filter(([c]) => target.columns.includes(c));
    if (!keep.length) {
      result.skippedTables.push(name);
      continue;
    }
    const colList = keep.map(([c]) => quoteIdent(c)).join(', ');
    const params = keep.map(() => '?').join(', ');
    if (target.virtual) {
      if (target.columns.includes('session_id')) {
        const existing = db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(name)} WHERE session_id = ?`).get(data.sessionId);
        if (Number(existing?.n ?? 0) > 0) continue;
      }
      const ins = db.prepare(`INSERT INTO ${quoteIdent(name)} (${colList}) VALUES (${params})`);
      for (const row of table.rows) {
        ins.run(...keep.map(([, i]) => decodeValue(row[i])));
        result.inserted++;
      }
    } else {
      const ins = db.prepare(`INSERT OR IGNORE INTO ${quoteIdent(name)} (${colList}) VALUES (${params})`);
      for (const row of table.rows) result.inserted += Number(ins.run(...keep.map(([, i]) => decodeValue(row[i]))).changes);
    }
  }
  return result;
}
