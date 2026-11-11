// GitHub Copilot desktop app & Copilot CLI sessions stored under ~/.copilot (or COPILOT_HOME).
//
// Sources:
//   data.db           the desktop app's database. Sessions listed there are app-managed:
//                     the organizer hands their deletion off to the app (never deleted here).
//   session-state/<id> one folder per CLI/app session (workspace.yaml, events.jsonl, ...).
//   session-store.db  the CLI's session index (turns, checkpoints, FTS search_index, ...).
// Session folders the app does not track are CLI-only and can be moved to the organizer
// trash (folder + exported index rows), unless a live Copilot process holds them.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Conversation,
  DeleteMode,
  ItemResult,
  Progress,
  Provider,
  ProviderContext,
  ProviderStatus,
  Transcript,
  TranscriptMessage,
} from '../../core/types.ts';
import { openAppDb, readAppData } from './appdb.ts';
import type { AppData, AppProject, AppSession, AppWorkspace } from './appdb.ts';
import { readEventsHead, readEventsTranscript } from './events.ts';
import type { EventsHead, HeadLimits } from './events.ts';
import { scanSessionState } from './scan.ts';
import type { SessionDir } from './scan.ts';
import { readSessionDetail, readStoreIndex } from './storedb.ts';
import type { IndexRows, SessionDetail, StoreCheckpoint, StoreSession, StoreTurn } from './storedb.ts';
import { STATE_DIR, listTrashed, readTrashMeta, readTrashRows, restoreSessions, trashFolder, trashSessions } from './trash.ts';
import type { GhAppPaths } from './trash.ts';
import {
  compact,
  errorMessage,
  firstIso,
  forEachLimit,
  isDir,
  isFile,
  isInside,
  isSafeId,
  latestIso,
  oneLine,
  pidAlive,
  text,
} from './util.ts';

export interface GhAppOptions {
  /** Copilot home folder; defaults to $COPILOT_HOME or ~/.copilot. */
  copilotHome?: string;
  /** Bytes of events.jsonl read for a transcript (default 20 MB; `full` allows at least 200 MB). */
  maxTranscriptBytes?: number;
}

const TITLE_MAX = 140;
const PREVIEW_MAX = 200;
const DEFAULT_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const FULL_TRANSCRIPT_BYTES = 200 * 1024 * 1024;
/** How much of an event log is read while listing (logs without current index turns only). */
const HEAD_LIMITS: HeadLimits = {
  fullBytes: 1024 * 1024,
  countBytes: 32 * 1024 * 1024,
  scanBytes: 256 * 1024,
  tailBytes: 256 * 1024,
};
const HEAD_CONCURRENCY = 16;
/** session-store.db is considered stale for a session when events.jsonl is this much newer. */
const STALE_MS = 5 * 60 * 1000;
const RAW_TURN_CHARS = 2 * 1024 * 1024;

const HANDOFF_NOTE = 'Owned by the GitHub Copilot app — deletion is handed off to the app';
const LINKED_NOTE = 'Linked from the GitHub Copilot app (workspace or automation run) but not listed as an app session; manage it in the app';
const IN_USE_NOTE = 'In use by a running Copilot process';
const INDEX_ONLY_NOTE = 'The session folder no longer exists; only the CLI session index still lists it. Deleting removes those index rows (restorable).';

interface ItemParts {
  id: string;
  kind: string;
  deleteMode: DeleteMode;
  note?: string;
  status?: string;
  session?: AppSession;
  workspace?: AppWorkspace;
  project?: AppProject;
  workflow?: { name?: string; status?: string };
  dir?: SessionDir;
  store?: StoreSession;
}

interface HeadJob {
  item: Conversation;
  file: string;
  size?: number;
  turnCount: number;
  stale: boolean;
  needsTitle: boolean;
}

function projectLocation(project: AppProject | undefined): string | undefined {
  if (!project) return undefined;
  if (project.owner && project.repo) return `${project.owner}/${project.repo}`;
  return project.path ?? project.name;
}

function byUpdatedDesc(a: Conversation, b: Conversation): number {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
}

/** Plain JS value from an exported (JSON-encoded) SQLite value, for display only. */
function plain(v: unknown): unknown {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$bigint === 'string') return Number(o.$bigint);
    if (typeof o.$real === 'number') return o.$real;
    if (typeof o.$num === 'string') return Number(o.$num);
    if (typeof o.$blob === 'string') return undefined;
  }
  return v;
}

function tableObjects(rows: IndexRows | undefined, table: string): Array<Record<string, unknown>> {
  const t = rows?.tables?.[table];
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) return [];
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, plain(r[i])])));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Turns and checkpoints from a trashed session's exported index rows. */
function detailFromRows(rows: IndexRows | undefined): SessionDetail {
  const turns = tableObjects(rows, 'turns')
    .map(
      (r): StoreTurn => ({
        turnIndex: Number(r.turn_index ?? 0),
        userMessage: str(r.user_message),
        assistantResponse: str(r.assistant_response),
        timestamp: firstIso(r.timestamp),
      }),
    )
    .sort((a, b) => a.turnIndex - b.turnIndex);
  const checkpoints = tableObjects(rows, 'checkpoints')
    .map(
      (r): StoreCheckpoint => ({
        number: Number(r.checkpoint_number ?? 0),
        title: str(r.title),
        overview: str(r.overview),
        createdAt: firstIso(r.created_at),
      }),
    )
    .sort((a, b) => a.number - b.number);
  return { turns, checkpoints };
}

function mb(bytes: number): string {
  return `${Math.max(0.1, Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

/** Some CLI sessions record their folder wrapped in literal quotes: cwd: '"C:\src\app"'. */
function unquote(value: string | undefined): string | undefined {
  const m = value === undefined ? null : /^(["'])(.*)\1$/s.exec(value.trim());
  return m ? m[2].trim() || undefined : value;
}

/** Skill instructions injected as a prompt; the event log marks these and the transcript hides them. */
const isSkillContext = (s: string): boolean => s.trimStart().startsWith('<skill-context');

function turnMessages(t: StoreTurn): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  if (t.userMessage?.trim() && !isSkillContext(t.userMessage)) out.push({ role: 'user', text: t.userMessage, at: t.timestamp });
  if (t.assistantResponse?.trim()) out.push({ role: 'assistant', text: t.assistantResponse, at: t.timestamp });
  return out;
}

export class GhAppProvider implements Provider {
  readonly id = 'ghapp';
  readonly label = 'GitHub Copilot app & CLI';
  readonly home: string;
  private readonly ctx: ProviderContext;
  private readonly paths: GhAppPaths;
  private readonly maxTranscriptBytes: number;

  constructor(ctx: ProviderContext, options: GhAppOptions = {}) {
    this.ctx = ctx;
    this.home = path.resolve(options.copilotHome || process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'));
    this.paths = {
      home: this.home,
      appDb: path.join(this.home, 'data.db'),
      storeDb: path.join(this.home, 'session-store.db'),
      stateDir: path.join(this.home, 'session-state'),
      trashDir: path.resolve(ctx.trashDir),
    };
    this.maxTranscriptBytes = Math.max(1024, options.maxTranscriptBytes ?? DEFAULT_TRANSCRIPT_BYTES);
  }

  async status(): Promise<ProviderStatus> {
    if (!isDir(this.home)) return { available: false, message: `Copilot home folder not found: ${this.home}` };
    const warnings: string[] = [];
    if (!isFile(this.paths.appDb)) {
      warnings.push('GitHub Copilot app database (data.db) not found; only CLI sessions are listed');
    } else {
      try {
        const db = openAppDb(this.paths.appDb);
        try {
          db.prepare('SELECT count(*) AS n FROM sessions').get();
        } finally {
          db.close();
        }
      } catch (e) {
        warnings.push(`GitHub Copilot app database (data.db) could not be read: ${errorMessage(e)}`);
      }
    }
    if (!isFile(this.paths.storeDb)) warnings.push('CLI session index (session-store.db) not found');
    if (!isDir(this.paths.stateDir)) warnings.push('session-state folder not found');
    return { available: true, message: `Reading ${this.home}`, ...(warnings.length ? { warnings } : {}) };
  }

  async list(progress?: Progress): Promise<Conversation[]> {
    if (!isDir(this.home)) throw new Error(`Copilot home folder not found: ${this.home}`);
    const scanning = 'Scanning Copilot session folders';
    progress?.(0, undefined, scanning);
    // The folder scan runs on the libuv threadpool while the databases are read below.
    const scan: Promise<{ dirs: SessionDir[]; error?: unknown }> = scanSessionState(this.paths.stateDir, (done, total) =>
      progress?.(done, total, scanning),
    ).then(
      (dirs) => ({ dirs }),
      (error: unknown) => ({ dirs: [], error }),
    );

    let app: AppData | undefined;
    if (isFile(this.paths.appDb)) {
      try {
        app = readAppData(this.paths.appDb);
      } catch (e) {
        await scan;
        throw new Error(`Could not read the GitHub Copilot app database (data.db): ${errorMessage(e)}`);
      }
    }
    let store = new Map<string, StoreSession>();
    if (isFile(this.paths.storeDb)) {
      try {
        store = readStoreIndex(this.paths.storeDb);
      } catch (e) {
        this.ctx.log(`could not read session-store.db: ${errorMessage(e)}`);
      }
    }
    const scanned = await scan;
    if (scanned.error) throw scanned.error;

    progress?.(0, undefined, 'Classifying sessions');
    const dirs = new Map(scanned.dirs.map((d) => [d.id, d]));
    const pidCache = new Map<number, boolean>();
    const live = (d: SessionDir | undefined): boolean => !!d && d.lockPids.some((pid) => pidAlive(pid, pidCache));
    const items: Conversation[] = [];
    const heads: HeadJob[] = [];
    const listed = new Set<string>();
    const add = (parts: ItemParts) => {
      listed.add(parts.id);
      const { item, job } = this.build(parts);
      items.push(item);
      if (job) heads.push(job);
    };

    // 1. Sessions the desktop app manages.
    for (const session of app?.sessions.values() ?? []) {
      const dir = dirs.get(session.id);
      const workspace = app?.workspaceOf.get(session.id);
      const project = workspace?.projectId ? app?.projects.get(workspace.projectId) : undefined;
      const kind = session.sessionType === 'general_chat' ? 'app-chat' : session.sessionType === 'cli_session' ? 'app-cli-session' : 'app-session';
      const status = session.archivedAt || workspace?.archivedAt ? 'Archived' : session.isRunning ? 'Running' : live(dir) ? 'In use' : undefined;
      add({
        id: session.id,
        kind,
        deleteMode: 'handoff',
        note: HANDOFF_NOTE,
        status,
        session,
        workspace,
        project,
        workflow: app?.workflowOf.get(session.id),
        dir,
        store: store.get(session.id),
      });
    }

    // 2. Session folders the app does not list.
    for (const dir of dirs.values()) {
      if (listed.has(dir.id) || app?.pendingDeletion.has(dir.id)) continue;
      const store1 = store.get(dir.id);
      if (app?.referenced.has(dir.id)) {
        const workspace = app.workspaceOf.get(dir.id);
        add({
          id: dir.id,
          kind: 'app-session',
          deleteMode: 'none',
          note: LINKED_NOTE,
          workspace,
          project: workspace?.projectId ? app.projects.get(workspace.projectId) : undefined,
          workflow: app.workflowOf.get(dir.id),
          dir,
          store: store1,
        });
        continue;
      }
      const inUse = live(dir);
      add({
        id: dir.id,
        kind: 'cli-session',
        deleteMode: inUse ? 'none' : 'trash',
        note: inUse ? IN_USE_NOTE : undefined,
        status: inUse ? 'In use' : undefined,
        dir,
        store: store1,
      });
    }

    // 3. Sessions left only in the CLI index (folder already gone).
    for (const s of store.values()) {
      if (listed.has(s.id) || dirs.has(s.id) || !isSafeId(s.id) || app?.referenced.has(s.id)) continue;
      add({ id: s.id, kind: 'cli-index-only', deleteMode: 'trash', note: INDEX_ONLY_NOTE, store: s });
    }

    if (heads.length) {
      const reading = 'Reading session event logs';
      let done = 0;
      progress?.(0, heads.length, reading);
      await forEachLimit(heads, HEAD_CONCURRENCY, async (job) => {
        try {
          this.applyHead(job, await readEventsHead(job.file, HEAD_LIMITS, job.size));
        } catch {
          // unreadable log: keep what the index had
        }
        done++;
        if (done % 100 === 0 || done === heads.length) progress?.(done, heads.length, reading);
      });
    }

    items.sort(byUpdatedDesc);
    progress?.(items.length, items.length, `Found ${items.length} sessions`);
    return items;
  }

  private cwdLocation(cwd: string | undefined): string | undefined {
    if (!cwd) return undefined;
    // App chats run in <home>/chats/<date>/<slug>: not a meaningful location.
    return isInside(path.resolve(cwd), path.join(this.home, 'chats')) ? undefined : cwd;
  }

  private build(p: ItemParts): { item: Conversation; job?: HeadJob } {
    const y = p.dir?.yaml ?? {};
    const st = p.store;
    const cliTitle =
      oneLine(y.name, TITLE_MAX) ?? oneLine(y.summary, TITLE_MAX) ?? oneLine(st?.summary, TITLE_MAX) ?? oneLine(st?.firstUser, TITLE_MAX, true);
    const title = oneLine(p.session?.title, TITLE_MAX) ?? oneLine(p.workspace?.name, TITLE_MAX) ?? oneLine(p.workflow?.name, TITLE_MAX) ?? cliTitle;
    const repository = text(y.repository) ?? st?.repository;
    const cwd = unquote(text(y.cwd) ?? st?.cwd);
    const branch = p.workspace?.branch ?? text(y.branch) ?? st?.branch;
    const fromProject = projectLocation(p.project);
    const location = p.kind === 'app-chat' ? fromProject : (fromProject ?? repository ?? this.cwdLocation(cwd));
    const turnCount = st?.turnCount ?? 0;
    const hasEvents = !!p.dir?.hasEvents;
    const item: Conversation = {
      source: 'ghapp',
      id: p.id,
      kind: p.kind,
      title: title ?? 'Untitled session',
      createdAt: firstIso(p.session?.createdAt, y.created_at, st?.createdAt, st?.firstTurnAt),
      updatedAt: latestIso(p.session?.updatedAt, y.updated_at, st?.updatedAt, st?.lastTurnAt, p.dir?.eventsMtimeMs),
      url: p.session ? `ghapp://sessions/${p.id}` : undefined,
      location,
      messageCount: turnCount > 0 ? turnCount : hasEvents ? undefined : 0,
      preview: oneLine(st?.lastAssistant, PREVIEW_MAX) ?? oneLine(st?.firstUser, PREVIEW_MAX, true),
      status: p.status,
      deleteMode: p.deleteMode,
      note: p.note,
      extra: compact({
        sessionType: p.session?.sessionType,
        titleSource: p.session?.titleSource,
        branch,
        cwd,
        repository,
        gitRoot: text(y.git_root),
        clientName: text(y.client_name),
        hostType: text(y.host_type) ?? st?.hostType,
        workspaceId: p.workspace?.id,
        workspaceName: p.workspace?.name,
        workspaceType: p.workspace?.type,
        projectId: p.project?.id,
        projectName: p.project?.name,
        projectPath: p.project?.path,
        sourcePrUrl: p.workspace?.sourcePrUrl,
        sourcePrTitle: p.workspace?.sourcePrTitle,
        createdPrUrl: p.workspace?.createdPrUrl,
        workflowName: p.workflow?.name,
        workflowStatus: p.workflow?.status,
        archivedAt: p.session?.archivedAt ?? p.workspace?.archivedAt,
        isRunning: p.session?.isRunning || undefined,
        wasInterrupted: p.session?.wasInterrupted || undefined,
        mode: p.session?.mode,
        model: p.session?.model,
        executionLocation: p.session?.executionLocation,
        sessionDir: p.dir?.dir,
        indexed: st !== undefined,
      }),
    };
    if (!item.extra || !Object.keys(item.extra).length) delete item.extra;
    if (!hasEvents || !p.dir) return { item };
    const lastTurnMs = st?.lastTurnAt ? Date.parse(st.lastTurnAt) : NaN;
    const stale = turnCount > 0 && Number.isFinite(lastTurnMs) && (p.dir.eventsMtimeMs ?? 0) > lastTurnMs + STALE_MS;
    if (turnCount > 0 && !stale && title) return { item };
    return {
      item,
      job: {
        item,
        file: path.join(p.dir.dir, 'events.jsonl'),
        size: p.dir.eventsSize,
        turnCount,
        stale,
        needsTitle: !title,
      },
    };
  }

  private applyHead(job: HeadJob, head: EventsHead): void {
    const { item } = job;
    if (head.userMessages !== undefined) item.messageCount = Math.max(job.turnCount, head.userMessages);
    if (job.stale || !item.preview) {
      item.preview = oneLine(head.lastAssistant, PREVIEW_MAX) ?? item.preview ?? oneLine(head.firstUser, PREVIEW_MAX, true);
    }
    if (job.needsTitle) item.title = oneLine(head.firstUser, TITLE_MAX, true) ?? item.title;
  }

  async getTranscript(item: Conversation, options: { full?: boolean } = {}): Promise<Transcript> {
    const id = item.id;
    if (!isSafeId(id)) throw new Error(`Invalid session id: ${id}`);
    const maxBytes = options.full ? Math.max(this.maxTranscriptBytes, FULL_TRANSCRIPT_BYTES) : this.maxTranscriptBytes;
    const notes: string[] = [];
    let detail: SessionDetail = { turns: [], checkpoints: [] };
    let eventsFile = path.join(this.paths.stateDir, id, 'events.jsonl');

    const trashed = !isDir(path.join(this.paths.stateDir, id)) ? readTrashMeta(this.paths, id) : undefined;
    if (trashed) {
      notes.push('This session is in the organizer trash');
      detail = detailFromRows(readTrashRows(this.paths, id));
      eventsFile = path.join(trashFolder(this.paths, id), STATE_DIR, 'events.jsonl');
    } else if (isFile(this.paths.storeDb)) {
      try {
        detail = readSessionDetail(this.paths.storeDb, id);
      } catch (e) {
        notes.push(`The CLI session index could not be read (${errorMessage(e)})`);
      }
    }

    const events = await fsp.stat(eventsFile).catch(() => undefined);
    let messages: TranscriptMessage[] = [];
    let partial = false;
    let raw: Record<string, unknown> | undefined;

    // The event log is the complete record. The CLI index keeps only the last assistant message of
    // each turn (often empty when the turn ended with tool calls), so it is the fallback. A log over
    // the read limit is read from both ends, so the transcript shows how the conversation ends.
    if (events?.isFile()) {
      const ev = await readEventsTranscript(eventsFile, maxBytes, { tailBytes: Math.floor(maxBytes / 2) });
      if (ev.messages.length || ev.tail?.messages.length || !detail.turns.length) {
        messages = ev.messages;
        partial = ev.truncated;
        raw = { from: 'events.jsonl', file: eventsFile, size: ev.size, bytesRead: ev.bytesRead, truncated: ev.truncated };
        if (ev.tail) {
          raw.skippedBytes = ev.tail.skippedBytes;
          const headBytes = ev.bytesRead - ev.tail.bytesRead;
          notes.push(
            `Showing the first ${mb(headBytes)} and last ${mb(ev.tail.bytesRead)} of a ${mb(ev.size)} event log${options.full ? '' : '; open the full transcript to read more'}`,
          );
          const skipped = `Skipped ${mb(ev.tail.skippedBytes)} of the event log here${options.full ? ' because the log is too large to show in full' : ''}`;
          messages.push({ role: 'status', text: skipped }, ...ev.tail.messages);
        } else if (ev.truncated) {
          notes.push(`Showing the first ${mb(ev.bytesRead)} of a ${mb(ev.size)} event log${options.full ? '' : '; open the full transcript to read more'}`);
        }
      }
    }
    if (!raw) {
      for (const t of detail.turns) messages.push(...turnMessages(t));
      let chars = 0;
      const turns: StoreTurn[] = [];
      for (const t of detail.turns) {
        chars += (t.userMessage?.length ?? 0) + (t.assistantResponse?.length ?? 0);
        if (chars > RAW_TURN_CHARS && turns.length) break;
        turns.push(t);
      }
      raw = { from: 'session-store', turns, ...(turns.length < detail.turns.length ? { turnsTruncated: true } : {}) };
    }
    for (const c of detail.checkpoints) {
      const head = `Checkpoint ${c.number}${c.title ? `: ${c.title}` : ''}`;
      messages.push({ role: 'system', text: c.overview ? `${head}\n\n${c.overview}` : head, at: c.createdAt });
    }
    if (detail.checkpoints.length) raw.checkpoints = detail.checkpoints;
    if (item.extra?.isRunning === true) notes.push('This session is still running, so its latest messages may not be recorded yet');
    if (!messages.length) notes.push('No messages were recorded for this session');

    return {
      source: 'ghapp',
      id,
      title: item.title,
      messages,
      ...(partial ? { partial: true } : {}),
      ...(notes.length ? { note: notes.join('. ') } : {}),
      raw,
    };
  }

  async deleteItems(items: Conversation[], progress?: Progress): Promise<ItemResult[]> {
    return trashSessions(this.paths, items, progress);
  }

  async restoreItems(ids: string[]): Promise<ItemResult[]> {
    return restoreSessions(this.paths, ids);
  }

  async listTrash(): Promise<Conversation[]> {
    return listTrashed(this.paths);
  }
}
