// Read-only access to the GitHub Copilot desktop app's database (<copilotHome>/data.db).
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue, StatementSync } from 'node:sqlite';
import { toIso } from '../../core/types.ts';
import { quoteIdent, tableColumns } from './sqlutil.ts';
import { errorMessage, text } from './util.ts';

const toIsoOrUndefined = (v: unknown): string | undefined => toIso(v);

export interface AppSession {
  id: string;
  title?: string;
  sessionType: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
  titleSource?: string;
  executionLocation?: string;
  isRunning: boolean;
  wasInterrupted: boolean;
  mode?: string;
  model?: string;
}

export interface AppWorkspace {
  id: string;
  projectId?: string;
  name?: string;
  branch?: string;
  type?: string;
  archivedAt?: string;
  updatedAt?: string;
  sourcePrUrl?: string;
  sourcePrTitle?: string;
  createdPrUrl?: string;
}

export interface AppProject {
  id: string;
  name?: string;
  kind?: string;
  path?: string;
  owner?: string;
  repo?: string;
}

export interface AppData {
  /** Sessions the app lists (pending deletions excluded). */
  sessions: Map<string, AppSession>;
  /** Sessions the app is already deleting (session_deletion_intents). */
  pendingDeletion: Set<string>;
  /** Every session id the app references: sessions, deletion intents, workspaces, aliases, workflow runs. */
  referenced: Set<string>;
  workspaceOf: Map<string, AppWorkspace>;
  projects: Map<string, AppProject>;
  workflowOf: Map<string, { name?: string; status?: string }>;
}

type Row = Record<string, SQLOutputValue>;

function selectExisting(db: DatabaseSync, table: string, wanted: string[], where = ''): Row[] {
  const cols = tableColumns(db, table);
  const list = wanted.filter((c) => cols.has(c));
  if (!list.length) return [];
  return db.prepare(`SELECT ${list.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)} ${where}`).all() as Row[];
}

function workspaceFrom(r: Row): AppWorkspace {
  return {
    id: String(r.id),
    projectId: text(r.project_id),
    name: text(r.name),
    branch: text(r.branch),
    type: text(r.workspace_type),
    archivedAt: toIsoOrUndefined(r.archived_at),
    updatedAt: toIsoOrUndefined(r.updated_at),
    sourcePrUrl: text(r.source_pr_html_url),
    sourcePrTitle: text(r.source_pr_title),
    createdPrUrl: text(r.created_pr_html_url),
  };
}

/** Prefers an active workspace, then the most recently updated one. */
function better(a: AppWorkspace | undefined, b: AppWorkspace): boolean {
  if (!a) return true;
  if (!!a.archivedAt !== !!b.archivedAt) return !b.archivedAt;
  return (b.updatedAt ?? '') > (a.updatedAt ?? '');
}

export function openAppDb(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true, timeout: 3000 });
}

/** Reads everything the listing needs in a handful of queries. Throws when the database is unusable. */
export function readAppData(file: string): AppData {
  const db = openAppDb(file);
  try {
    if (!tableColumns(db, 'sessions').has('id')) throw new Error('data.db has no sessions table');
    const data: AppData = {
      sessions: new Map(),
      pendingDeletion: new Set(),
      referenced: new Set(),
      workspaceOf: new Map(),
      projects: new Map(),
      workflowOf: new Map(),
    };
    for (const r of selectExisting(db, 'session_deletion_intents', ['session_id'])) {
      const id = text(r.session_id);
      if (id) data.pendingDeletion.add(id);
    }
    const sessionCols = [
      'id', 'title', 'session_type', 'created_at', 'updated_at', 'archived_at', 'title_source',
      'execution_location', 'is_running', 'was_interrupted', 'mode', 'model',
    ];
    for (const r of selectExisting(db, 'sessions', sessionCols)) {
      const id = text(r.id);
      if (!id) continue;
      data.referenced.add(id);
      if (data.pendingDeletion.has(id)) continue;
      data.sessions.set(id, {
        id,
        title: text(r.title),
        sessionType: text(r.session_type) ?? 'unknown',
        createdAt: toIsoOrUndefined(r.created_at),
        updatedAt: toIsoOrUndefined(r.updated_at),
        archivedAt: toIsoOrUndefined(r.archived_at),
        titleSource: text(r.title_source),
        executionLocation: text(r.execution_location),
        isRunning: Number(r.is_running ?? 0) === 1,
        wasInterrupted: Number(r.was_interrupted ?? 0) === 1,
        mode: text(r.mode),
        model: text(r.model),
      });
    }
    for (const id of data.pendingDeletion) data.referenced.add(id);

    for (const r of selectExisting(db, 'projects', ['id', 'name', 'container_kind', 'main_repo_path', 'github_owner', 'github_repo'])) {
      const id = text(r.id);
      if (!id) continue;
      data.projects.set(id, {
        id,
        name: text(r.name),
        kind: text(r.container_kind),
        path: text(r.main_repo_path),
        owner: text(r.github_owner),
        repo: text(r.github_repo),
      });
    }

    const wsCols = [
      'id', 'project_id', 'session_id', 'name', 'branch', 'workspace_type', 'archived_at', 'updated_at',
      'source_pr_html_url', 'source_pr_title', 'created_pr_html_url',
    ];
    const workspaces = new Map<string, AppWorkspace>();
    for (const r of selectExisting(db, 'workspaces', wsCols)) {
      if (r.id === null || r.id === undefined) continue;
      const ws = workspaceFrom(r);
      workspaces.set(ws.id, ws);
      const sid = text(r.session_id);
      if (!sid) continue;
      data.referenced.add(sid);
      if (better(data.workspaceOf.get(sid), ws)) data.workspaceOf.set(sid, ws);
    }
    for (const r of selectExisting(db, 'workspace_session_aliases', ['session_id', 'workspace_id'])) {
      const sid = text(r.session_id);
      if (!sid) continue;
      data.referenced.add(sid);
      const ws = workspaces.get(String(r.workspace_id));
      if (ws && !data.workspaceOf.has(sid)) data.workspaceOf.set(sid, ws);
    }

    const workflowNames = new Map<string, string>();
    for (const r of selectExisting(db, 'workflows', ['id', 'name'])) {
      const name = text(r.name);
      if (name) workflowNames.set(String(r.id), name);
    }
    for (const r of selectExisting(db, 'workflow_runs', ['session_id', 'task_id', 'status', 'workspace_id'])) {
      const sid = text(r.session_id);
      if (!sid) continue;
      data.referenced.add(sid);
      if (!data.workflowOf.has(sid)) data.workflowOf.set(sid, { name: workflowNames.get(String(r.task_id)), status: text(r.status) });
      const ws = workspaces.get(String(r.workspace_id));
      if (ws && !data.workspaceOf.has(sid)) data.workspaceOf.set(sid, ws);
    }
    return data;
  } finally {
    db.close();
  }
}

/** Point lookups used to re-verify, right before a delete, that the app does not track a session. */
export class AppOwnership {
  private readonly db?: DatabaseSync;
  private readonly error?: string;
  private readonly checks: StatementSync[] = [];

  /** `file` may not exist (no desktop app installed): then nothing is app-owned. */
  constructor(file: string, exists: boolean) {
    if (!exists) return;
    try {
      this.db = openAppDb(file);
      const lookups: Array<[string, string]> = [
        ['sessions', 'id'],
        ['session_deletion_intents', 'session_id'],
        ['workspaces', 'session_id'],
        ['workspace_session_aliases', 'session_id'],
        ['workflow_runs', 'session_id'],
      ];
      if (!tableColumns(this.db, 'sessions').has('id')) throw new Error('data.db has no sessions table');
      for (const [table, col] of lookups) {
        if (!tableColumns(this.db, table).has(col)) continue;
        this.checks.push(this.db.prepare(`SELECT 1 AS hit FROM ${quoteIdent(table)} WHERE ${quoteIdent(col)} = ? LIMIT 1`));
      }
    } catch (e) {
      this.error = errorMessage(e);
      try {
        this.db?.close();
      } catch {
        // already closed
      }
      this.db = undefined;
    }
  }

  /** A refusal reason when the app references `id` or ownership cannot be verified. */
  refusal(id: string): string | undefined {
    if (this.error) return `The GitHub Copilot app database could not be read (${this.error}), so ownership could not be verified`;
    if (!this.db) return undefined;
    try {
      for (const s of this.checks) if (s.get(id)) return 'Owned by the GitHub Copilot app; deletion is handed off to the app';
      return undefined;
    } catch (e) {
      return `The GitHub Copilot app database could not be checked (${errorMessage(e)})`;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
  }
}
