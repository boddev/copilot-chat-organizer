// Typed operations over the M365 transport: chat history paging, Cowork tasks, Projects.
// Endpoint details and caveats: docs/m365-endpoints.md.
import type { M365Transport } from './transport.ts';
import { withRetry } from '../../lib/async.ts';

export interface ChatRecord {
  conversationId: string;
  chatName?: string;
  tone?: string;
  createTimeUtc?: number;
  updateTimeUtc?: number;
  threadId?: string;
  isUnread?: boolean;
  hasCopilotTasks?: boolean;
  isMessageless?: boolean;
  isScheduledPromptThread?: boolean;
  path?: string;
  preview?: string;
  [key: string]: unknown;
}

export interface TaskRecord {
  taskId: string;
  sessionId: string;
  title?: string;
  state?: string;
  lastActivity?: number;
  createdAt?: string;
  lastReplyAt?: string;
  lastReplySummary?: string;
  ic3ThreadId?: string;
  parentConversationId?: string;
  parentName?: string;
  progressSummary?: string;
  scheduledTaskState?: string;
  sessionState?: string;
  [key: string]: unknown;
}

export interface ProjectRecord {
  projectId: string;
  title?: string;
  state?: string;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ProjectMembers {
  chats: Array<{ threadId?: string; conversationId?: string; title?: string }>;
  tasks: Array<{ threadId?: string; sessionId?: string; title?: string }>;
  complete: boolean;
}

export interface ChatMessageRecord {
  messageId?: string;
  author?: string;
  text?: string;
  createdAt?: string | number;
  messageType?: string;
  /** Many replies carry their answer only here. */
  adaptiveCards?: unknown[];
  [key: string]: unknown;
}

export interface ChatContent {
  header: Record<string, unknown>;
  messages: ChatMessageRecord[];
  complete: boolean;
}

export interface TaskEvent {
  event: string;
  data: any;
  id?: string;
}

export const PROJECT_COLORS = ['gray', 'green', 'blue', 'pumpkin', 'purple', 'pink', 'yellow'];

const enc = encodeURIComponent;

/** Decodes the history syncState to the oldest delivered segment start (ISO-ish string). */
export function syncStateStart(syncState: string | undefined): string | undefined {
  if (!syncState) return undefined;
  try {
    const outer = JSON.parse(Buffer.from(syncState, 'base64').toString('utf8'));
    const inner = JSON.parse(Buffer.from(String(outer.IC3SyncState), 'base64').toString('utf8'));
    const segs = inner.deliveredSegments as Array<{ start?: string }> | undefined;
    return segs?.[0]?.start;
  } catch {
    return undefined;
  }
}

export function parseNdjson(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // ignore keep-alive or partial lines
    }
  }
  return out;
}

export interface M365ClientOptions {
  /** Upper bound on history pages (~18 chats each). */
  maxHistoryPages?: number;
  maxTaskPages?: number;
}

export class M365Client {
  private readonly t: M365Transport;
  private readonly maxHistoryPages: number;
  private readonly maxTaskPages: number;

  constructor(transport: M365Transport, options: M365ClientOptions = {}) {
    this.t = transport;
    this.maxHistoryPages = options.maxHistoryPages ?? 600;
    this.maxTaskPages = options.maxTaskPages ?? 200;
  }

  private sfn(data: Record<string, unknown>): Promise<any> {
    return withRetry(() => this.t.serverFn(data));
  }

  private aether<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    return withRetry(async () => (await this.t.aether<T>(method, path, body)).data);
  }

  // ---- chats -------------------------------------------------------------------

  /** Pages through the complete chat history (newest first). */
  async listChats(progress?: (count: number) => void): Promise<ChatRecord[]> {
    const seen = new Map<string, ChatRecord>();
    const add = (chats: unknown): number => {
      let fresh = 0;
      for (const c of Array.isArray(chats) ? (chats as ChatRecord[]) : []) {
        if (!c?.conversationId) continue;
        const key = c.conversationId.toLowerCase();
        const prev = seen.get(key);
        if (!prev) fresh++;
        // Keep the first-seen id so an item's key never changes between pages.
        seen.set(key, { ...prev, ...c, conversationId: prev?.conversationId ?? c.conversationId });
      }
      return fresh;
    };
    const nav = await this.sfn({
      action: 'RefreshNavPane',
      conversationHistoryFilter: null,
      skipNotebooks: true,
      skipAgentListCache: false,
      preservePinnedChats: false,
      enableLastMessage: false,
      state: {},
    });
    const first = nav?.result?.store?.conversationPageHistoryList;
    if (!first) throw new Error('Unexpected RefreshNavPane response (the Copilot web app may have changed).');
    add(first.chats);
    progress?.(seen.size);
    let syncState: string | undefined = first.syncState;
    let emptyPages = 0;
    for (let page = 0; page < this.maxHistoryPages && syncState; page++) {
      const res = await this.sfn({
        action: 'GetConversationPageHistoryList',
        syncState,
        enableLastMessage: true,
        saveToStore: 'chatLandingPageHistoryList',
        state: { chatLandingPageHistoryList: { chats: [], syncState } },
      });
      const list = res?.result?.store?.chatLandingPageHistoryList;
      if (!list) throw new Error('Unexpected GetConversationPageHistoryList response.');
      const fresh = add(list.chats);
      progress?.(seen.size);
      const next: string | undefined = list.syncState;
      const reachedStart = String(syncStateStart(next) ?? '').startsWith('1970');
      emptyPages = fresh === 0 ? emptyPages + 1 : 0;
      if (!next || next === syncState) break;
      if (reachedStart && fresh === 0) break;
      if (emptyPages >= 2) break;
      syncState = next;
    }
    return [...seen.values()].sort((a, b) => (b.updateTimeUtc || b.createTimeUtc || 0) - (a.updateTimeUtc || a.createTimeUtc || 0));
  }

  async deleteChat(conversationId: string): Promise<void> {
    const res = await this.sfn({ action: 'DeleteConversation', conversationId, state: {} });
    const status = res?.result?.store?.lastConversationActionMetrics?.statusCode;
    const deleted: unknown = res?.result?.result?.conversationIdsDeleted;
    if (status !== 200) throw new Error(`Delete was rejected (status ${status ?? 'unknown'}).`);
    if (Array.isArray(deleted) && deleted.length && !deleted.some((d) => String(d).toLowerCase() === conversationId.toLowerCase())) {
      throw new Error('The service did not confirm the deletion.');
    }
  }

  /** Copilot tasks that the service deletes together with the chat. */
  async tasksDeletedWithChat(conversationId: string): Promise<unknown[]> {
    const res = await this.sfn({ action: 'GetMoreTasks', cursor: '', filter: { conversationId }, storeKey: 'pendingDeleteTasks', state: {} });
    const tasks = res?.result?.store?.pendingDeleteTasks?.tasks;
    return Array.isArray(tasks) ? tasks : [];
  }

  /**
   * Reads a chat's messages. `path` is the chat's app path, tried when the default
   * conversation route does not return content (agent chats).
   */
  async chatContent(conversationId: string, options: { path?: string; maxPages?: number } = {}): Promise<ChatContent> {
    const headers = { 'x-streaming': 'true', accept: 'application/x-ndjson,application/json' };
    const routes = [`/chat/conversation/${enc(conversationId)}`];
    if (options.path && options.path.startsWith('/') && !routes.includes(options.path)) routes.push(options.path);
    let lastError = '';
    for (const route of routes) {
      const byId = new Map<string, ChatMessageRecord>();
      let header: Record<string, unknown> | undefined;
      let syncState: string | undefined;
      let complete = false;
      for (let page = 0; page < (options.maxPages ?? 20); page++) {
        const qs = `direction=Backward${syncState ? `&syncState=${enc(syncState)}` : ''}`;
        const res = await withRetry(() => this.t.pageGet(`${route}?${qs}`, headers));
        if (res.status !== 200) {
          lastError = `HTTP ${res.status}`;
          break;
        }
        const lines = parseNdjson(res.text);
        // The first line holds the header and the newest messages; older messages of the
        // same response follow in further `{messages}` lines.
        const chunks = lines.filter((l) => Array.isArray(l?.messages));
        const body = chunks[0];
        if (!body) {
          lastError = 'no messages in response';
          break;
        }
        header ??= Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'messages'));
        let fresh = 0;
        for (const m of chunks.flatMap((c) => c.messages as ChatMessageRecord[])) {
          const key = String(m.messageId ?? `${m.createdAt}|${m.author}|${String(m.text ?? '').slice(0, 40)}`);
          if (!byId.has(key)) fresh++;
          byId.set(key, m);
        }
        const last = lines.find((l) => typeof l?.isLastPage === 'boolean');
        if (last?.isLastPage !== false) {
          complete = true;
          break;
        }
        const next = typeof body.syncState === 'string' ? body.syncState : undefined;
        if (!next || next === syncState || fresh === 0) break;
        syncState = next;
      }
      if (header) {
        const messages = [...byId.values()].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
        return { header, messages, complete };
      }
    }
    throw new Error(`Could not read the chat (${lastError}).`);
  }

  // ---- Cowork tasks ----------------------------------------------------------------

  async listTasks(progress?: (count: number) => void): Promise<TaskRecord[]> {
    const seen = new Map<string, TaskRecord>();
    let cursor: string | undefined;
    for (let page = 0; page < this.maxTaskPages; page++) {
      const qs = `pageSize=150&includeCached=true&sessionType=interactive${cursor ? `&cursor=${enc(cursor)}` : ''}`;
      const res = await this.aether<{ tasks?: TaskRecord[]; nextCursor?: string | null }>('GET', `/v1/tasks/live?${qs}`);
      let fresh = 0;
      for (const task of res?.tasks ?? []) {
        if (!task?.taskId) continue;
        if (!seen.has(task.taskId)) fresh++;
        seen.set(task.taskId, task);
      }
      progress?.(seen.size);
      const next = res?.nextCursor ?? undefined;
      if (!next || next === cursor || fresh === 0) break;
      cursor = next;
    }
    return [...seen.values()];
  }

  taskDetail(sessionId: string): Promise<{ task?: any; snapshot?: any }> {
    return this.aether('GET', `/v1/tasks/live/detail?sessionId=${enc(sessionId)}`);
  }

  /**
   * Reads a task's event stream, newest page first, until the beginning or a limit.
   * Returns events in chronological order.
   */
  async taskEvents(
    threadId: string,
    options: { maxPages?: number; maxEvents?: number } = {},
    progress?: (events: number) => void,
  ): Promise<{ events: TaskEvent[]; complete: boolean }> {
    const pages: TaskEvent[][] = [];
    let total = 0;
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < (options.maxPages ?? 12); page++) {
      const qs = `threadId=${enc(threadId)}&pageSize=50${cursor ? `&cursor=${enc(cursor)}` : ''}`;
      const res = await this.aether<{ events?: TaskEvent[]; nextCursor?: string | null }>('GET', `/v1/tasks/live/messages?${qs}`);
      const events = res?.events ?? [];
      pages.push(events);
      total += events.length;
      progress?.(total);
      const next = res?.nextCursor ?? undefined;
      if (!next || next === cursor || events.length === 0) {
        complete = true;
        break;
      }
      if (total >= (options.maxEvents ?? 400_000)) break;
      cursor = next;
    }
    const events = pages.reverse().flat();
    events.sort((a, b) => seqOf(a.id) - seqOf(b.id));
    return { events, complete };
  }

  async deleteTask(sessionId: string): Promise<void> {
    await this.aether('DELETE', `/v1/conversations/${enc(sessionId)}`);
  }

  // ---- projects ----------------------------------------------------------------------

  async listProjects(): Promise<ProjectRecord[]> {
    const out: ProjectRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.aether<{ items?: ProjectRecord[]; cursor?: string | null; nextCursor?: string | null }>(
        'GET',
        `/v1/projects${cursor ? `?cursor=${enc(cursor)}` : ''}`,
      );
      out.push(...(res?.items ?? []).filter((p) => p?.projectId && !/^delet/i.test(String(p.state ?? ''))));
      const next = res?.nextCursor ?? res?.cursor ?? undefined;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return out;
  }

  async projectColors(): Promise<Record<string, string>> {
    const settings = await this.aether<{ projectColors?: Record<string, string | null> }>('GET', '/v1/settings');
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings?.projectColors ?? {})) if (typeof v === 'string' && v) out[k] = v;
    return out;
  }

  async projectMembers(projectId: string): Promise<ProjectMembers> {
    const res = await this.sfn({ action: 'GetNavProjectChats', projectId });
    const r = res?.result?.result;
    if (!r) throw new Error('Unexpected GetNavProjectChats response.');
    return {
      chats: Array.isArray(r.copilotChats) ? r.copilotChats : [],
      tasks: Array.isArray(r.tasks) ? r.tasks : [],
      complete: r.isComplete !== false,
    };
  }

  createProject(title: string): Promise<ProjectRecord> {
    return this.aether<ProjectRecord>('POST', '/v1/projects', { title, instructions: '', tags: [] });
  }

  async renameProject(projectId: string, title: string): Promise<void> {
    await this.aether('PATCH', `/v1/projects/${enc(projectId)}`, { title });
  }

  async setProjectArchived(projectId: string, archived: boolean): Promise<void> {
    await this.aether('PATCH', `/v1/projects/${enc(projectId)}`, { state: archived ? 'archived' : 'active' });
  }

  async setProjectColor(projectId: string, color: string | null): Promise<void> {
    const value = !color || color === PROJECT_COLORS[0] ? null : color;
    await this.aether('PATCH', '/v1/settings', { projectColors: { [projectId]: value } });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.aether('DELETE', `/v1/projects/${enc(projectId)}`);
  }

  async addChatToProject(projectId: string, threadId: string): Promise<void> {
    await this.aether('POST', `/v1/projects/${enc(projectId)}/chats`, { threadId });
  }

  async addTaskToProject(projectId: string, taskId: string): Promise<void> {
    await this.aether('POST', `/v2/tasks/projects/${enc(projectId)}/tasks`, { conversationId: taskId });
  }

  /** `memberId` is a chat's threadId or a Cowork task's taskId. */
  async removeFromProject(projectId: string, memberId: string): Promise<void> {
    await this.aether('DELETE', `/v1/projects/${enc(projectId)}/tasks/${enc(memberId)}`);
  }
}

function timeOf(value: unknown): number {
  if (typeof value === 'number') return value;
  const t = Date.parse(String(value ?? ''));
  return Number.isNaN(t) ? 0 : t;
}

function seqOf(id: unknown): number {
  const m = /(\d+)\s*$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : 0;
}
