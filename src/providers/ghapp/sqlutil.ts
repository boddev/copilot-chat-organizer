// Schema helpers shared by the data.db and session-store.db readers.
import type { DatabaseSync } from 'node:sqlite';

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Column names of a table (empty when the table does not exist or cannot be inspected). */
export function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
    return new Set(rows.map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

export interface TableInfo {
  name: string;
  /** Virtual table (e.g. FTS5): rows must be inserted without INSERT OR IGNORE. */
  virtual: boolean;
  columns: string[];
}

/** User tables, excluding SQLite internals and the shadow tables behind virtual tables. */
export function listTables(db: DatabaseSync): TableInfo[] {
  const rows = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`).all();
  const virtual = rows
    .filter((r) => /^\s*create\s+virtual\s+table\b/i.test(String(r.sql ?? '')))
    .map((r) => String(r.name).toLowerCase());
  const out: TableInfo[] = [];
  for (const r of rows) {
    const name = String(r.name);
    const lower = name.toLowerCase();
    if (lower.startsWith('sqlite_')) continue;
    if (virtual.some((v) => lower !== v && lower.startsWith(`${v}_`))) continue;
    out.push({ name, virtual: virtual.includes(lower), columns: [...tableColumns(db, name)] });
  }
  return out;
}
