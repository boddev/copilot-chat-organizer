// GitHub Copilot on github.com (https://github.com/copilot): web chats, the github.com
// copies of Copilot app/CLI sessions, and Copilot coding agent tasks. Listed, read and
// deleted through the agents API inside a signed-in github.com page (transport.ts,
// docs/ghweb-endpoints.md). github.com has no projects, so these items are grouped with
// the organizer's local collections.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Conversation,
  ItemResult,
  Progress,
  Provider,
  ProviderContext,
  ProviderStatus,
  Transcript,
  TranscriptMessage,
} from '../../core/types.ts';
import { toIso } from '../../core/types.ts';
import { HttpError, mapLimit, parseRetryAfter, withRetry } from '../../lib/async.ts';
import { TRANSCRIPT_DATA_FIELDS, TRANSCRIPT_EVENT_TYPES, eventsToMessages } from '../ghapp/events.ts';
import {
  GITHUB_ORIGIN,
  apiUrl,
  pageUrl,
  type AhpSlimEvent,
  type CliSlimEvent,
  type GhWebRequestOptions,
  type GhWebResponse,
  type GhWebTransport,
  type SlimEventsBody,
} from './transport.ts';

const enc = encodeURIComponent;
/** Agent slug of Copilot app/CLI sessions (and github.com chats) synced to github.com. */
const CLI_SLUG = 'copilot-developer-cli';
const RUNNING_STATES = new Set(['in_progress', 'queued']);
const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_PAGES = 200;

export interface AgentCollaborator {
  agent_id?: number;
  agent_task_id?: string;
  agent_type?: string;
  slug?: string;
}

export interface TaskRecord {
  id: string;
  name?: string | null;
  state?: string | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
  repository?: { id?: number; full_name?: string | null } | null;
  agent_collaborators?: AgentCollaborator[] | null;
  session_count?: number | null;
  [key: string]: unknown;
}

export interface TaskSession {
  name?: string | null;
  state?: string | null;
  prompt?: string | null;
  event_content?: string | null;
  premium_requests?: number | null;
  head_ref?: string | null;
  resource_number?: number | null;
  created_at?: string | null;
  completed_at?: string | null;
  [key: string]: unknown;
}

export interface TaskDetail extends TaskRecord {
  sessions?: TaskSession[] | null;
}

export type GhWebKind = 'web-chat' | 'cli-task' | 'agent-task';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const errorText = (e: unknown): string => String((e as Error)?.message ?? e);

export function taskKind(task: TaskRecord, chat: boolean): GhWebKind {
  if (chat) return 'web-chat';
  const agents = Array.isArray(task.agent_collaborators) ? task.agent_collaborators : [];
  return agents.length > 0 && agents.every((a) => a?.slug === CLI_SLUG) ? 'cli-task' : 'agent-task';
}

export interface TaskListContext {
  /** Listed by a chat walk (`type=chat`). */
  chat: boolean;
  /** Ids of the Copilot app/CLI sessions stored on this PC (session-state folder names). */
  localSessions?: ReadonlySet<string>;
}

export function taskToConversation(task: TaskRecord, ctx: TaskListContext): Conversation {
  const kind = taskKind(task, ctx.chat);
  const agents = Array.isArray(task.agent_collaborators) ? task.agent_collaborators : [];
  const agent = agents.find((a) => a && typeof a.agent_task_id === 'string' && a.agent_task_id);
  const agentTaskId = agent?.agent_task_id;
  const localSession = !!agentTaskId && ctx.localSessions?.has(agentTaskId) === true;
  const repo = str(task.repository?.full_name) || undefined;
  const archived = !!task.archived_at;
  const state = str(task.state) || str(task.status) || undefined;
  const notes: string[] = [];
  if (localSession) {
    notes.push('github.com copy of a GitHub Copilot app/CLI session on this PC. Deleting it here removes only the github.com copy, not the session on this PC.');
  }
  // Synced app/CLI sessions often stay "in progress" after they end; only agent tasks really run.
  if (kind === 'agent-task' && !archived && state && RUNNING_STATES.has(state)) notes.push('Still running on github.com.');
  const createdAt = toIso(task.created_at);
  return {
    source: 'ghweb',
    id: task.id,
    kind,
    title: str(task.name) || (kind === 'web-chat' ? '(untitled chat)' : '(untitled task)'),
    createdAt,
    updatedAt: toIso(task.updated_at) ?? createdAt,
    url: `${GITHUB_ORIGIN}/copilot/tasks/${enc(task.id)}`,
    location: repo ?? (kind === 'web-chat' ? 'Copilot chat' : 'No repository'),
    status: archived ? 'archived' : state?.replace(/_/g, ' '),
    deleteMode: 'direct',
    note: notes.join(' ') || undefined,
    extra: {
      archived,
      state,
      agentTaskId,
      agentSlug: agent?.slug,
      repo,
      chat: ctx.chat,
      localSession,
      sessionCount: typeof task.session_count === 'number' ? task.session_count : undefined,
    },
  };
}

/** The `rel="next"` target of a Link header (may be relative, e.g. `?cursor=...`). */
export function nextLink(link: string | null | undefined): string | undefined {
  if (!link) return undefined;
  const m = /<([^>]*)>\s*;\s*rel\s*=\s*"?next"?\s*(?=,|;|$)/i.exec(link);
  return m ? m[1] : undefined;
}

/** Transcript messages from github.com chat events (see AhpSlimEvent). */
export function ahpToMessages(events: AhpSlimEvent[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const parts = new Map<string, TranscriptMessage>();
  for (const e of events) {
    const a = e?.ahp;
    if (!a || typeof a.type !== 'string') continue;
    const at = toIso(a.at) ?? toIso(e.at);
    const text = typeof a.text === 'string' ? a.text : '';
    if (a.type === 'chat/turnStarted') {
      messages.push({ role: !a.origin || a.origin === 'user' ? 'user' : 'system', text, at });
    } else if (a.type === 'chat/responsePart') {
      const m: TranscriptMessage = { role: 'assistant', text, at };
      messages.push(m);
      if (a.partId) parts.set(a.partId, m);
    } else if (a.type === 'chat/delta') {
      const m = a.partId ? parts.get(a.partId) : undefined;
      if (m) m.text += text;
    } else if (/cancel|abort/i.test(a.type)) {
      messages.push({ role: 'status', text: text ? `Stopped: ${text}` : 'Stopped', at });
    } else {
      messages.push({ role: 'status', text: `Error: ${text || 'the response failed'}`, at });
    }
  }
  return messages.filter((m) => m.text.trim());
}

/** Merges two time-ordered message lists; messages without a time keep their place. */
export function mergeByTime(a: TranscriptMessage[], b: TranscriptMessage[]): TranscriptMessage[] {
  if (!a.length) return b;
  if (!b.length) return a;
  const out: TranscriptMessage[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const takeB = i >= a.length || (j < b.length && !!a[i].at && !!b[j].at && b[j].at! < a[i].at!);
    out.push(takeB ? b[j++] : a[i++]);
  }
  return out;
}

const round2 = (n: number): string => String(Math.round(n * 100) / 100);

/** What the task record says about each session: the ask, then how it ended. */
function sessionMessages(detail: TaskDetail): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const s of Array.isArray(detail.sessions) ? detail.sessions : []) {
    if (!s || typeof s !== 'object') continue;
    const ask = str(s.prompt) || str(s.event_content);
    if (ask) out.push({ role: 'user', text: ask, at: toIso(s.created_at) });
    const facts: string[] = [];
    if (str(s.state)) facts.push(str(s.state).replace(/_/g, ' '));
    if (str(s.head_ref)) facts.push(`branch ${str(s.head_ref)}`);
    if (typeof s.resource_number === 'number' && s.resource_number > 0) facts.push(`#${s.resource_number}`);
    if (typeof s.premium_requests === 'number' && s.premium_requests > 0) {
      facts.push(`${round2(s.premium_requests)} premium request${s.premium_requests === 1 ? '' : 's'}`);
    }
    if (facts.length) out.push({ role: 'status', text: `Session: ${facts.join(' · ')}`, at: toIso(s.completed_at) ?? toIso(s.created_at) });
  }
  return out;
}

function noHistory(detail: TaskDetail): TranscriptMessage {
  const state = str(detail.state);
  return { role: 'status', text: `No conversation history found on github.com${state ? ` (task ${state.replace(/_/g, ' ')})` : ''}.` };
}

/** A summary built from the task record, for tasks whose history has no readable messages. */
export function detailMessages(detail: TaskDetail): TranscriptMessage[] {
  const out = sessionMessages(detail);
  return out.length ? out : [noHistory(detail)];
}

/**
 * History event kinds the organizer understands: the ones the transcript reads, and ones that
 * never hold conversation messages. Any other kind in a log without messages may be a format
 * the organizer cannot read.
 */
const KNOWN_KIND =
  /^(?:(?:session|permission|hook|tool|external_tool|subagent|skill|system|capabilities|commands)\.[\w.-]+|abort|user\.message|assistant\.(?:message|turn_start|turn_end)|ahp:chat\/(?:turnStarted|responsePart|delta|titleChanged))$/;

const isSlimLog = (v: any): v is SlimEventsBody => !!v && typeof v.count === 'number' && Array.isArray(v.events);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Describes a JSON value's structure without its content, for diagnostics. */
function jsonShape(v: unknown): string {
  const one = (x: unknown): string => (x === null ? 'null' : Array.isArray(x) ? `array(${x.length})` : typeof x);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return one(v);
  const keys = Object.keys(v);
  const parts = keys.slice(0, 20).map((k) => `${k.slice(0, 40)}: ${one((v as Record<string, unknown>)[k])}`);
  return `{${parts.join(', ')}${keys.length > 20 ? ', …' : ''}}`;
}

function httpMessage(res: GhWebResponse, action: string): string {
  let detail = '';
  try {
    const body = JSON.parse(res.text);
    if (body && typeof body.message === 'string') detail = body.message.slice(0, 200);
  } catch {
    // Not a JSON error body.
  }
  if (res.status === 401) return `Could not ${action}: github.com rejected the sign-in (HTTP 401). Sign in to github.com again.`;
  if (res.status === 429) return `Could not ${action}: github.com is limiting requests (HTTP 429). Try again in a few minutes.`;
  return `Could not ${action}: github.com returned HTTP ${res.status}${detail ? ` (${detail})` : ''}.`;
}

function okJson(res: GhWebResponse, action: string): any {
  if (res.status < 200 || res.status >= 300) throw new HttpError(httpMessage(res, action), res.status);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`Could not ${action}: github.com returned an unreadable response.`);
  }
}

interface Walk {
  archived: boolean;
  chat: boolean;
  label: string;
}

const WALKS: Walk[] = [
  { archived: false, chat: false, label: 'Tasks' },
  { archived: true, chat: false, label: 'Archived tasks' },
  { archived: false, chat: true, label: 'Chats' },
  { archived: true, chat: true, label: 'Archived chats' },
];

export interface GhWebProviderOptions {
  transport: GhWebTransport;
  /** Copilot app/CLI home, used to recognize github.com copies of local sessions. Defaults to $COPILOT_HOME or ~/.copilot. */
  copilotHome?: string;
  /** Concurrent calls during bulk deletes. */
  concurrency?: number;
  /** Tasks per list page. */
  pageSize?: number;
  /** Bytes of a task's history read for the default view; the full view reads everything. */
  previewBytes?: number;
}

export class GhWebProvider implements Provider {
  readonly id = 'ghweb' as const;
  readonly label = 'GitHub Copilot on github.com';
  private readonly ctx: ProviderContext;
  private readonly transport: GhWebTransport;
  private readonly copilotHome: string;
  private readonly concurrency: number;
  private readonly pageSize: number;
  private readonly previewBytes: number;
  private warnings: string[] = [];

  constructor(ctx: ProviderContext, options: GhWebProviderOptions) {
    this.ctx = ctx;
    this.transport = options.transport;
    this.copilotHome = path.resolve(options.copilotHome || process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'));
    this.concurrency = options.concurrency ?? 3;
    this.pageSize = options.pageSize ?? 250;
    // Fusion (Auto) sessions log thousands of activity events, so 4 MB often held only the first prompt.
    this.previewBytes = options.previewBytes ?? 16 * 1024 * 1024;
  }

  async status(): Promise<ProviderStatus> {
    const s = this.transport.state();
    return {
      available: true,
      signedIn: s.phase === 'ready' ? true : s.phase === 'signin' ? false : undefined,
      message: s.message,
      warnings: this.warnings.length ? this.warnings : undefined,
    };
  }

  /** Calls the API, retrying throttling and transient server errors. Resolves for other statuses. */
  private call(method: string, url: string, action: string, options?: GhWebRequestOptions): Promise<GhWebResponse> {
    return withRetry(async () => {
      const res = await this.transport.request(method, url, options);
      if (RETRYABLE.has(res.status)) throw new HttpError(httpMessage(res, action), res.status, parseRetryAfter(res.retryAfter));
      return res;
    });
  }

  private async walk(creatorId: string, w: Walk, onPage: (n: number) => void): Promise<{ tasks: TaskRecord[]; complete: boolean }> {
    const qs = new URLSearchParams({ creator_id: creatorId, page: '1', archived: String(w.archived), per_page: String(this.pageSize) });
    if (w.chat) qs.set('type', 'chat');
    let url = apiUrl(`tasks?${qs}`);
    const seen = new Set([url]);
    const tasks: TaskRecord[] = [];
    const action = `list ${w.label.toLowerCase()}`;
    for (let page = 1; ; page++) {
      const res = await this.call('GET', url, action);
      const body = okJson(res, action);
      if (!Array.isArray(body?.tasks)) throw new Error(`Could not ${action}: github.com returned an unexpected response.`);
      for (const t of body.tasks) if (t && typeof t === 'object' && typeof t.id === 'string' && t.id) tasks.push(t);
      onPage(body.tasks.length);
      const link = nextLink(res.link);
      if (!link) return { tasks, complete: true };
      const next = pageUrl(link, url);
      if (seen.has(next) || page >= MAX_PAGES) return { tasks, complete: false };
      seen.add(next);
      url = next;
    }
  }

  private async localSessionIds(): Promise<Set<string>> {
    try {
      const entries = await fsp.readdir(path.join(this.copilotHome, 'session-state'), { withFileTypes: true });
      return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    } catch {
      return new Set();
    }
  }

  async list(progress?: Progress): Promise<Conversation[]> {
    progress?.(0, undefined, 'Connecting to github.com');
    await this.transport.connect((m) => progress?.(0, undefined, m));
    const me = this.transport.identity();
    if (!me?.id) throw new Error('Could not tell which github.com account is signed in.');
    const warnings: string[] = [];
    let read = 0;
    const onPage = (n: number) => {
      read += n;
      progress?.(read, undefined, `Reading Copilot chats and tasks on github.com: ${read}`);
    };
    const local = this.localSessionIds();
    const results = await Promise.all(
      WALKS.map(async (w, i) => {
        try {
          const r = await this.walk(me.id, w, onPage);
          if (!r.complete) warnings.push(`${w.label} on github.com: the list did not finish, so some items may be missing.`);
          return r.tasks;
        } catch (e) {
          // The main list must work; the others are reported and skipped.
          if (i === 0) throw e;
          warnings.push(`${w.label} on github.com could not be listed: ${errorText(e)}`);
          return [] as TaskRecord[];
        }
      }),
    );
    const localSessions = await local;
    const merged = new Map<string, { task: TaskRecord; chat: boolean }>();
    results.forEach((tasks, i) => {
      for (const task of tasks) merged.set(task.id, { task, chat: WALKS[i].chat || merged.get(task.id)?.chat === true });
    });
    const out = [...merged.values()].map(({ task, chat }) => taskToConversation(task, { chat, localSessions }));
    this.warnings = warnings;
    const chats = out.filter((c) => c.kind === 'web-chat').length;
    const tasks = out.length - chats;
    progress?.(out.length, out.length, `Loaded ${chats} chat${chats === 1 ? '' : 's'} and ${tasks} task${tasks === 1 ? '' : 's'} from github.com`);
    return out;
  }

  async getTranscript(item: Conversation, options: { full?: boolean } = {}): Promise<Transcript> {
    const full = options.full === true;
    const base = `tasks/${enc(item.id)}`;
    const [detailRes, eventsRes] = await Promise.all([
      this.call('GET', base, 'read the task'),
      this.call('GET', `${base}/events`, 'read the conversation', {
        timeoutMs: full ? 10 * 60_000 : 2 * 60_000,
        events: { types: TRANSCRIPT_EVENT_TYPES, dataFields: TRANSCRIPT_DATA_FIELDS, maxBytes: full ? undefined : this.previewBytes },
      }),
    ]);
    if (detailRes.status === 404) throw new Error('This item no longer exists on github.com. Refresh the list.');
    const detail = okJson(detailRes, 'read the task') as TaskDetail;
    if (!detail || typeof detail !== 'object') throw new Error('Could not read the task: github.com returned an unexpected response.');
    const log = this.historyLog(item.id, eventsRes);
    const events = log?.events ?? [];
    const cli = events.filter((e): e is CliSlimEvent => typeof (e as CliSlimEvent).type === 'string');
    const ahp = events.filter((e): e is AhpSlimEvent => !!(e as AhpSlimEvent).ahp);
    let messages = mergeByTime(eventsToMessages(cli), ahpToMessages(ahp));
    const partial = !!log && (log.truncated || (typeof log.total === 'number' && log.count < log.total));
    const notes: string[] = [];
    if (log?.truncated) notes.push('Long conversation: showing the beginning. Load the full conversation to read all of it.');
    else if (log && partial) notes.push(`github.com returned ${log.count} of ${log.total} events, so the end may be missing.`);
    if (!messages.length) {
      const summary = sessionMessages(detail);
      messages = summary.length ? summary : [noHistory(detail)];
      const kinds = log?.kinds ?? {};
      if (!log || Object.keys(kinds).some((k) => !KNOWN_KIND.test(k))) {
        if (log) this.ctx.log(`no readable messages in ${item.id}; event kinds ${JSON.stringify(kinds)}`);
        notes.push("The organizer could not read this conversation's history, so this is a summary of the task.");
      } else if (summary.length && !partial) {
        notes.push('github.com has no messages for this conversation, so this is a summary of the task.');
      }
    }
    return {
      source: 'ghweb',
      id: item.id,
      title: str(detail?.name) || item.title,
      messages,
      partial,
      note: notes.join(' ') || undefined,
      raw: {
        task: detail,
        history: log ? { total: log.total, count: log.count, bytes: log.bytes, truncated: log.truncated, kinds: log.kinds } : undefined,
      },
    };
  }

  /**
   * The task's event log, or undefined when github.com sends none or something unrecognized
   * (the transcript then falls back to the task summary). Other HTTP errors still fail: they are
   * usually temporary or need a new sign-in.
   */
  private historyLog(id: string, res: GhWebResponse): SlimEventsBody | undefined {
    const ok = res.status >= 200 && res.status < 300;
    if (!ok && res.status !== 404) throw new HttpError(httpMessage(res, 'read the conversation'), res.status);
    const body = ok ? parseJson(res.text) : undefined;
    if (isSlimLog(body)) return body;
    const shape = !ok ? '' : body === undefined ? ` not JSON (${res.text.length} characters)` : ` ${jsonShape(body)}`;
    this.ctx.log(`unexpected history response for ${id}: HTTP ${res.status}${shape}`);
    return undefined;
  }

  async deleteItems(items: Conversation[], progress?: Progress): Promise<ItemResult[]> {
    let done = 0;
    return mapLimit(items, this.concurrency, async (item): Promise<ItemResult> => {
      try {
        const res = await this.call('DELETE', `tasks/${enc(item.id)}`, 'delete');
        if (res.status === 404) return { id: item.id, ok: true, detail: 'Already deleted on github.com' };
        if (res.status < 200 || res.status >= 300) throw new HttpError(httpMessage(res, 'delete'), res.status);
        return { id: item.id, ok: true };
      } catch (e) {
        return { id: item.id, ok: false, error: errorText(e) };
      } finally {
        done++;
        progress?.(done, items.length, `Deleting ${done}/${items.length}`);
      }
    });
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}
