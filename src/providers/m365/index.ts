// Microsoft 365 Copilot chats and Copilot Cowork tasks, with native Projects.
import type {
  Conversation,
  ItemResult,
  NativeProjects,
  Progress,
  Project,
  Provider,
  ProviderContext,
  ProviderStatus,
  Transcript,
  TranscriptMessage,
  TranscriptRole,
} from '../../core/types.ts';
import { toIso } from '../../core/types.ts';
import { mapLimit } from '../../lib/async.ts';
import {
  M365Client,
  PROJECT_COLORS,
  type ChatMessageRecord,
  type ChatRecord,
  type ProjectRecord,
  type TaskEvent,
  type TaskRecord,
} from './client.ts';
import { APP_ORIGIN, type M365Transport } from './transport.ts';

const enc = encodeURIComponent;
const lc = (s: unknown) => String(s ?? '').toLowerCase();

export function chatLocation(path: string | undefined): string {
  const p = path ?? '';
  if (/^\/agents\/researcher\//i.test(p)) return 'Researcher';
  if (/^\/agents\/analyst\//i.test(p)) return 'Analyst';
  if (/^\/chat\/agent\/Notebook/i.test(p)) return 'Notebook';
  if (/^\/(chat\/)?agents?\//i.test(p)) return 'Agent';
  return 'Chat';
}

export function chatToConversation(c: ChatRecord, projectId: string | undefined, childTaskIds: string[]): Conversation {
  const path = typeof c.path === 'string' && c.path.startsWith('/') ? c.path : `/chat/conversation/${enc(c.conversationId)}`;
  const notes: string[] = [];
  if (c.hasCopilotTasks || childTaskIds.length) notes.push('Deleting this chat also deletes the Copilot tasks created from it.');
  if (!c.threadId) notes.push('No thread id: cannot be added to a project.');
  return {
    source: 'm365',
    id: c.conversationId,
    kind: 'chat',
    title: (c.chatName ?? '').trim() || '(untitled chat)',
    createdAt: toIso(c.createTimeUtc),
    updatedAt: toIso(c.updateTimeUtc) ?? toIso(c.createTimeUtc),
    url: APP_ORIGIN + path,
    location: chatLocation(path),
    projectIds: projectId ? [projectId] : [],
    preview: chatPreview(c.preview),
    status: c.isUnread ? 'unread' : undefined,
    deleteMode: 'direct',
    note: notes.join(' ') || undefined,
    extra: {
      threadId: c.threadId,
      path,
      tone: c.tone,
      hasCopilotTasks: c.hasCopilotTasks === true,
      childTaskIds: childTaskIds.length ? childTaskIds : undefined,
    },
  };
}

export function taskToConversation(t: TaskRecord, projectId: string | undefined): Conversation {
  const notes: string[] = [];
  if (t.parentConversationId) notes.push(`Created from the chat "${t.parentName || t.parentConversationId}".`);
  if (t.scheduledTaskState) notes.push(`Scheduled task (${t.scheduledTaskState}).`);
  return {
    source: 'm365',
    id: t.taskId,
    kind: 'cowork-task',
    title: (t.title ?? '').trim() || '(untitled task)',
    createdAt: toIso(t.createdAt),
    updatedAt: toIso(t.lastActivity) ?? toIso(t.lastReplyAt) ?? toIso(t.createdAt),
    url: `${APP_ORIGIN}/cowork/#/task/${enc(t.taskId)}`,
    location: 'Cowork',
    projectIds: projectId ? [projectId] : [],
    preview: (t.lastReplySummary || t.progressSummary || undefined)?.slice(0, 400),
    status: t.state,
    deleteMode: 'direct',
    note: notes.join(' ') || undefined,
    extra: {
      sessionId: t.sessionId,
      threadId: t.ic3ThreadId,
      parentConversationId: t.parentConversationId || undefined,
      lastReplySummary: t.lastReplySummary || undefined,
    },
  };
}

export function projectFromRecord(p: ProjectRecord, colors: Record<string, string>): Project {
  return {
    id: p.projectId,
    name: (p.title ?? '').trim() || '(untitled project)',
    color: colors[p.projectId] ?? PROJECT_COLORS[0],
    archived: p.archived === true || lc(p.state) === 'archived',
    createdAt: toIso(p.createdAt),
    updatedAt: toIso(p.updatedAt),
  };
}

/** The text of Adaptive Cards in reading order: TextBlocks, RichTextBlocks and FactSets. */
export function adaptiveCardText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) adaptiveCardText(n, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const n = node as Record<string, unknown>;
  let text: string | undefined;
  if (n.type === 'TextBlock') text = typeof n.text === 'string' ? n.text : '';
  else if (n.type === 'RichTextBlock' && Array.isArray(n.inlines)) {
    text = n.inlines.map((i) => (typeof i === 'string' ? i : typeof i?.text === 'string' ? i.text : '')).join('');
  } else if (n.type === 'FactSet' && Array.isArray(n.facts)) {
    text = n.facts
      .map((f) => [f?.title, f?.value].filter((v) => typeof v === 'string' && v.trim()).join(': '))
      .filter(Boolean)
      .join('\n');
  }
  if (text !== undefined) {
    if (text.trim()) out.push(text.trim());
    return out;
  }
  for (const v of Object.values(n)) if (v && typeof v === 'object') adaptiveCardText(v, out);
  return out;
}

// Placeholders for rich UI, such as `<m-workflow-claude-code-execution-card></m-workflow-claude-code-execution-card>`.
const EMPTY_ELEMENT = /^<([a-z][\w-]*)\b[^>]*>\s*<\/\1>$/i;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
// Markup around an agent's disclaimer, which the Copilot app shows as a note. A line that held only a tag goes too.
function withoutDisclaimerTags(s: string): string {
  if (!/<\/?m-disclaimer\b/i.test(s)) return s;
  return s
    .split('\n')
    .flatMap((line) => {
      const rest = line.replace(/<\/?m-disclaimer\b[^>]*>/gi, '');
      return rest !== line && !rest.trim() ? [] : [rest];
    })
    .join('\n');
}

/** The steps in `headerText: …\nsubText: …` progress text, as lines without the labels. One message can hold several. */
function progressSteps(text: string): string[][] | undefined {
  if (!/^headerText:/.test(text)) return undefined;
  const steps: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(headerText|subText|interstitialText):(.*)$/.exec(line);
    if (m?.[1] === 'headerText') steps.push([]);
    steps[steps.length - 1].push((m ? m[2] : line).trim());
  }
  const out = steps.map((s) => s.filter(Boolean)).filter((s) => s.length);
  return out.length ? out : undefined;
}

/**
 * Readable text for the machine payloads that agents (such as the ones that build PowerPoint
 * and Word files) post as chat messages. Unknown JSON stays as-is but shows as a tool message.
 * The originals stay in the transcript's `raw`.
 */
export function describePayload(text: string, role: TranscriptRole): { role: TranscriptRole; text: string } {
  const t = text.trim();
  const steps = progressSteps(t);
  if (steps) return { role, text: steps.map((s) => s.join('\n')).join('\n\n') };
  if (!/^[[{]/.test(t)) return { role, text };
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    return { role, text };
  }
  if (Array.isArray(value)) {
    const todos = value.length > 0 && value.every((x) => typeof x?.content === 'string' && typeof x?.status === 'string');
    if (todos) return { role, text: value.map((x) => `${lc(x.status) === 'completed' ? '[x]' : '[ ]'} ${x.content}`).join('\n') };
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const fileName = str(o.fileName);
    const answer = str(o.configurationJSON);
    // The agent's reply to the user, sent as a text file.
    if (fileName && answer && /\.txt$/i.test(fileName)) return { role: 'assistant', text: answer };
    const link = str(o.shareableLink);
    if (link) return { role: 'tool', text: `Created ${fileName ?? 'a file'}\n${link}` };
    // Slide HTML and configuration files; their content would swamp the transcript.
    if (fileName) return { role: 'tool', text: `Generated ${fileName}` };
    const command = str(o.stdIn);
    if (command) return { role: 'tool', text: [`$ ${command}`, str(o.stdOut)].filter(Boolean).join('\n') };
  }
  return { role: role === 'assistant' ? 'tool' : role, text };
}

/** A chat message as a transcript entry, or undefined for records with nothing to show. */
export function chatMessage(m: ChatMessageRecord): TranscriptMessage | undefined {
  const type = lc(m.messageType);
  // `Internal` holds search-result bookkeeping as JSON; `EndOfRequest` is an empty marker.
  if (type === 'internal' || type === 'endofrequest') return undefined;
  const author = lc(m.author);
  const fromUser = author === 'user' || author === 'botonbehalfofuser';
  const body = typeof m.text === 'string' && m.text.trim() ? m.text : adaptiveCardText(m.adaptiveCards).join('\n\n');
  const text = fromUser ? body : withoutDisclaimerTags(body);
  if (!text.trim() || EMPTY_ELEMENT.test(text.trim())) return undefined;
  const at = toIso(m.createdAt);
  if (fromUser) return { role: 'user', text, at };
  if (author === 'system') return { role: 'system', text: type === 'attachmentaction' ? `Attached: ${text}` : text, at };
  const role: TranscriptRole =
    author === 'tool' || type === 'generatedcode'
      ? 'tool'
      : type === 'progress' || lc(m.contentOrigin).includes('chainofthought')
        ? 'status'
        : 'assistant';
  return { ...describePayload(text, role), at };
}

/**
 * A chat's messages as transcript entries. Some agents post cumulative progress, where each
 * status message repeats the earlier steps and adds one; only the last of such a run is kept.
 */
export function chatMessages(records: ChatMessageRecord[]): TranscriptMessage[] {
  const out = records.map((m) => chatMessage(m)).filter((m): m is TranscriptMessage => m !== undefined);
  return out.filter((m, i) => {
    const next = out[i + 1];
    return !(m.role === 'status' && next?.role === 'status' && (next.text === m.text || next.text.startsWith(`${m.text}\n`)));
  });
}

/** A string value from JSON text that may be cut off part-way, as in list previews. */
export function partialJsonString(text: string, key: string): { value: string; complete: boolean } | undefined {
  const start = text.indexOf(`"${key}":"`);
  if (start < 0) return undefined;
  const rest = text.slice(start + key.length + 4);
  const body = /^(?:[^"\\]|\\.)*/.exec(rest)?.[0] ?? '';
  const complete = rest[body.length] === '"';
  try {
    // Drop an escape that was cut in half, such as `\u00`.
    return { value: JSON.parse(`"${complete ? body : body.replace(/\\u[0-9a-fA-F]{0,3}$/, '')}"`), complete };
  } catch {
    return undefined;
  }
}

const decodeUri = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

/** The file name in a SharePoint link's `file=` parameter, ending in "…" if the link was cut off inside it. */
function linkFileName(link: string, complete: boolean): string | undefined {
  const m = /[?&]file=([^&#]+)([&#])?/.exec(link);
  if (!m) return undefined;
  const whole = complete || m[2] !== undefined;
  const raw = (whole ? m[1] : m[1].replace(/%[0-9a-f]?$/i, '')).replace(/\+/g, ' ');
  const name = (decodeUri(raw) ?? decodeUri(raw.replace(/(%[0-9a-f]{2})+$/i, '')) ?? raw).trim();
  return name ? (whole ? name : `${name}…`) : undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/**
 * The list preview for a chat. The service sends about the first 200 characters of the newest
 * message. For file-building agents that's a machine payload cut off part-way, so it's
 * described the way the transcript describes it. Other previews are unchanged.
 */
export function chatPreview(preview: unknown): string | undefined {
  // The cut can fall inside a disclaimer tag, leaving something like `<m-discl` at the end.
  const p = str(typeof preview === 'string' ? withoutDisclaimerTags(preview).replace(/<\/?m-[\w-]*$/, '') : undefined);
  if (!p) return undefined;
  const steps = progressSteps(p);
  let text: string | undefined;
  if (steps) {
    text = steps.map((s) => s.join(' — ')).join(' ');
  } else if (p.startsWith('{"')) {
    const file = partialJsonString(p, 'fileName');
    const name = file?.complete ? file.value : undefined;
    const reply = partialJsonString(p, 'configurationJSON');
    const link = partialJsonString(p, 'shareableLink');
    if (name && /\.txt$/i.test(name) && reply?.value.trim()) text = reply.value;
    else if (link || p.includes('"fileType":"')) text = `Created ${name ?? (link && linkFileName(link.value, link.complete)) ?? 'a file'}`;
    else if (name) text = `Generated ${name}`;
  } else if (/^<[a-z][\w-]*[\s>]/i.test(p) && p.includes('</')) {
    // Rich text from the message box.
    text = p.replace(/<[^>]*>?/g, '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? '');
  }
  return ((text !== undefined && str(text.replace(/\s+/g, ' '))) || p).slice(0, 400);
}

function fmtDuration(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  return `${Math.round(n / 60_000)} min`;
}

function firstText(d: Record<string, unknown>): string | undefined {
  for (const k of ['text', 'content', 'message', 'msg', 'prompt', 'query', 't', 'm']) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** Rebuilds a readable transcript from a Cowork task's event stream. */
export function transcriptFromTaskEvents(events: TaskEvent[]): {
  messages: TranscriptMessage[];
  unknownCodes: Record<string, number>;
  /** The first unrecognized events, kept as is so they can be inspected and backed up. */
  unknownEvents: TaskEvent[];
} {
  const messages: TranscriptMessage[] = [];
  const unknownCodes: Record<string, number> = {};
  const unknownEvents: TaskEvent[] = [];
  const tools = new Map<string, number>();
  const citations = new Set<string>();
  const changed = new Map<string, string[]>();
  // Subagents run in parallel, and their text and tool calls carry the subagent's id in `aid`.
  // They're collected per subagent and shown inside its entry instead of interleaved.
  type Subagent = { i: number; parts: { text: string; tool?: boolean }[]; text: string; ended?: boolean };
  const subagents = new Map<string, Subagent>();
  const subagentTools = new Map<string, { sub: Subagent; n: number }>();
  let current: { aid?: string; text: string; at?: string } | undefined;
  let files: TranscriptMessage | undefined;
  const flush = () => {
    if (current && current.text.trim()) messages.push({ role: 'assistant', text: current.text.trim(), at: current.at });
    current = undefined;
  };
  const push = (m: TranscriptMessage) => {
    flush();
    messages.push(m);
    return messages.length - 1;
  };
  const closeText = (s: Subagent) => {
    if (s.text.trim()) s.parts.push({ text: s.text.trim() });
    s.text = '';
  };
  const finished = (d: Record<string, any>) => (d.ok === false ? ' (failed)' : fmtDuration(d.dur) ? ` (${fmtDuration(d.dur)})` : '');
  const unknown = (e: TaskEvent, d: Record<string, any>) => {
    unknownCodes[e.event] = (unknownCodes[e.event] ?? 0) + 1;
    if (unknownEvents.length < 50) unknownEvents.push(e);
    const text = firstText(d);
    if (!text) return;
    const isUser = d.role === 'user' || d.author === 'user' || d.sender === 'user' || /^u/i.test(e.event);
    push({ role: isUser ? 'user' : 'system', text: isUser ? text : `[${e.event}] ${text}` });
  };
  for (const e of events) {
    const d = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, any>;
    // Reply text (dx) has no time of its own; use the first timed event while it's being written.
    if (current && !current.at && d.ts !== undefined) current.at = toIso(d.ts);
    const sub = typeof d.aid === 'string' ? subagents.get(d.aid) : undefined;
    switch (e.event) {
      case 'u': {
        const attached = Array.isArray(d.att) ? d.att.map((a: any) => str(a?.fn)).filter(Boolean) : [];
        const text = [str(d.t), attached.length ? `Attached: ${attached.join(', ')}` : undefined].filter(Boolean).join('\n\n');
        if (text) push({ role: 'user', text, at: toIso(d.ts) });
        break;
      }
      case 'dx':
        if (sub) {
          sub.text += typeof d.t === 'string' ? d.t : '';
          break;
        }
        if (!current || (d.aid && current.aid && d.aid !== current.aid)) {
          flush();
          current = { aid: d.aid, text: '' };
        }
        current.text += typeof d.t === 'string' ? d.t : '';
        break;
      case 'th':
        break;
      case 'ts': {
        const label = `▶ ${[d.tn, d.d].filter((x) => typeof x === 'string' && x).join(': ') || 'tool call'}`;
        if (sub) {
          closeText(sub);
          sub.parts.push({ text: label, tool: true });
          if (d.tid) subagentTools.set(String(d.tid), { sub, n: sub.parts.length - 1 });
          break;
        }
        const i = push({ role: 'tool', text: label, at: toIso(d.ts) });
        if (d.tid) tools.set(String(d.tid), i);
        break;
      }
      case 'tx': {
        const i = tools.get(String(d.tid));
        const nested = subagentTools.get(String(d.tid));
        if (i !== undefined) messages[i].text += finished(d);
        else if (nested) nested.sub.parts[nested.n].text += finished(d);
        break;
      }
      case 'sa': {
        const i = push({ role: 'tool', text: `▶ Subagent: ${str(d.d) ?? str(d.ad) ?? str(d.sat) ?? str(d.tn) ?? 'task'}`, at: toIso(d.ts) });
        if (d.tid) subagents.set(String(d.tid), { i, parts: [], text: '' });
        break;
      }
      case 'sx': {
        // Older tasks send two `sx` events per subagent; only the first counts.
        const s = subagents.get(String(d.tid));
        if (s) {
          if (!s.ended) messages[s.i].text += finished(d);
          s.ended = true;
        } else {
          const name = str(d.d) ?? str(d.ad) ?? str(d.tn) ?? '';
          push({ role: 'tool', text: `Subagent ${name} ${d.ok === false ? 'failed' : 'finished'}${fmtDuration(d.dur) ? ` in ${fmtDuration(d.dur)}` : ''}`.replace(/\s+/g, ' '), at: toIso(d.ts) });
        }
        break;
      }
      case 'aq': {
        // A question Cowork asked the user, with optional choices.
        const text = (Array.isArray(d.q) ? d.q : [])
          .map((q: any) => {
            const question = str(q?.question);
            if (!question) return undefined;
            const header = str(q?.header);
            const options = (Array.isArray(q?.options) ? q.options : []).map((o: any) => (typeof o === 'string' ? str(o) : (str(o?.label) ?? str(o?.text)))).filter(Boolean);
            return `${header ? `${header}: ` : ''}${question}${options.length ? `\nOptions: ${options.join('; ')}` : ''}`;
          })
          .filter(Boolean)
          .join('\n\n');
        if (text) push({ role: 'assistant', text: `Question for you:\n${text}`, at: toIso(d.ts) });
        break;
      }
      case 'aa': {
        const answers = Object.values(d.answers && typeof d.answers === 'object' ? d.answers : {})
          .map((a) => (typeof a === 'string' ? str(a) : Array.isArray(a) ? str(a.filter((x) => typeof x === 'string').join(', ')) : undefined))
          .filter(Boolean);
        if (answers.length) push({ role: 'user', text: `Answer: ${answers.join('\n')}`, at: toIso(d.ts) });
        break;
      }
      case 'ar':
        // Only seen with an empty `r`; keep anything else for inspection.
        if (str(d.r)) unknown(e, d);
        break;
      case 'fu': {
        // A file copied into the task's OneDrive folder (Tasks/<task>/input/…); runs of them are listed together.
        const path = str(d.ip) ?? str(d.rp);
        if (!path) break;
        if (files && !current && messages[messages.length - 1] === files) files.text += `\n${path}`;
        else {
          files = { role: 'system', text: `Files added to OneDrive:\n${path}`, at: toIso(d.ts) };
          push(files);
        }
        break;
      }
      case 'fc': {
        // A file the task created or changed (output/…); repeats for every save, so they're listed once at the end.
        const name = str(d.fn);
        if (!name) break;
        const how = changed.get(name) ?? [];
        const ct = str(d.ct);
        if (ct && !how.includes(ct)) how.push(ct);
        changed.set(name, how);
        break;
      }
      case 'ci':
        if (typeof d.ttl === 'string' || typeof d.src === 'string') citations.add(String(d.ttl || d.src));
        break;
      case 'fr':
        if (sub) closeText(sub);
        else flush();
        break;
      default:
        unknown(e, d);
    }
  }
  flush();
  for (const s of subagents.values()) {
    closeText(s);
    if (s.parts.length) messages[s.i].text += `\n\n${s.parts.map((p, n) => (n === 0 ? '' : p.tool && s.parts[n - 1].tool ? '\n' : '\n\n') + p.text).join('')}`;
  }
  if (changed.size) messages.push({ role: 'system', text: `Files created or changed:\n${[...changed].map(([f, how]) => (how.length ? `${f} (${how.join(', ')})` : f)).join('\n')}` });
  if (citations.size) messages.push({ role: 'system', text: `Sources: ${[...citations].slice(0, 40).join('; ')}` });
  return { messages, unknownCodes, unknownEvents };
}

export function taskSummaryMessages(item: Conversation, detail: { task?: any; snapshot?: any }): TranscriptMessage[] {
  const t = detail.task ?? {};
  const s = detail.snapshot ?? {};
  const out: TranscriptMessage[] = [];
  const state = [t.state, t.sessionState].filter(Boolean).join(' / ');
  out.push({ role: 'status', text: `Cowork task${state ? ` (${state})` : ''}${t.progressSummary ? `\n${t.progressSummary}` : ''}`, at: toIso(t.createdAt) });
  if (t.parentName || t.parentConversationId) out.push({ role: 'status', text: `Started from the chat "${t.parentName || t.parentConversationId}"` });
  if (Array.isArray(t.todos) && t.todos.length) {
    const lines = t.todos.map((x: any) => `${x.completed || x.status === 'completed' ? '[x]' : '[ ]'} ${x.content ?? ''}`);
    out.push({ role: 'status', text: `Plan${t.todosTruncated ? ' (truncated)' : ''}:\n${lines.join('\n')}` });
  }
  if (Array.isArray(s.completedSubagents)) {
    for (const a of s.completedSubagents) {
      const dur = fmtDuration(a.duration_ms);
      out.push({ role: 'tool', text: `Subagent ${a.display_name ?? ''}: ${a.description ?? ''} (${[a.status, dur].filter(Boolean).join(', ')})`.trim() });
    }
  }
  if (Array.isArray(s.messageArtifacts) && s.messageArtifacts.length) {
    const names = s.messageArtifacts.map((a: any) => a?.name ?? a?.title ?? a?.fileName ?? a?.url ?? '').filter(Boolean);
    if (names.length) out.push({ role: 'system', text: `Artifacts: ${names.slice(0, 30).join('; ')}` });
  }
  const last = typeof item.extra?.lastReplySummary === 'string' ? item.extra.lastReplySummary : undefined;
  if (last) out.push({ role: 'assistant', text: last });
  const meta = [s.activeModel ? `model ${s.activeModel}` : '', s.costCredits !== undefined ? `${s.costCredits} credits` : ''].filter(Boolean);
  if (meta.length) out.push({ role: 'system', text: meta.join(', ') });
  return out;
}

export interface M365ProviderOptions {
  transport: M365Transport;
  client?: M365Client;
  /** Concurrent write calls during bulk operations. */
  concurrency?: number;
}

export class M365Provider implements Provider {
  readonly id = 'm365' as const;
  readonly label = 'Microsoft 365 Copilot';
  readonly projects: NativeProjects;
  private readonly ctx: ProviderContext;
  private readonly transport: M365Transport;
  private readonly client: M365Client;
  private readonly concurrency: number;
  private warnings: string[] = [];

  constructor(ctx: ProviderContext, options: M365ProviderOptions) {
    this.ctx = ctx;
    this.transport = options.transport;
    this.client = options.client ?? new M365Client(options.transport);
    this.concurrency = options.concurrency ?? 3;
    this.projects = {
      colors: PROJECT_COLORS,
      list: () => this.listProjects(),
      create: async (name) => {
        const title = name.trim();
        if (!title) throw new Error('Project name is required');
        return projectFromRecord(await this.client.createProject(title), {});
      },
      rename: (projectId, name) => {
        if (!name.trim()) throw new Error('Project name is required');
        return this.client.renameProject(projectId, name.trim());
      },
      setColor: (projectId, color) => {
        if (color && !PROJECT_COLORS.includes(color)) throw new Error(`Unsupported color "${color}"`);
        return this.client.setProjectColor(projectId, color);
      },
      setArchived: (projectId, archived) => this.client.setProjectArchived(projectId, archived),
      delete: (projectId) => this.client.deleteProject(projectId),
      addItems: (projectId, items, progress) => this.addToProject(projectId, items, progress),
      removeItems: (projectId, items, progress) => this.removeFromProject(projectId, items, progress),
      memberCount: async (projectId) => {
        const m = await this.client.projectMembers(projectId);
        return m.chats.length + m.tasks.length + (m.complete ? 0 : 1);
      },
    };
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

  private async listProjects(): Promise<Project[]> {
    const [records, colors] = await Promise.all([this.client.listProjects(), this.client.projectColors()]);
    return records.map((p) => projectFromRecord(p, colors));
  }

  async list(progress?: Progress): Promise<Conversation[]> {
    const warnings: string[] = [];
    progress?.(0, undefined, 'Connecting to Microsoft 365 Copilot');
    await this.transport.connect((m) => progress?.(0, undefined, m));
    const [chats, tasks] = await Promise.all([
      this.client.listChats((n) => progress?.(n, undefined, `Reading chat history: ${n} chats`)),
      this.client.listTasks().catch((e) => {
        warnings.push(`Cowork tasks could not be listed: ${String((e as Error).message ?? e)}`);
        return [] as TaskRecord[];
      }),
    ]);
    progress?.(chats.length + tasks.length, undefined, 'Reading projects');
    const membership = new Map<string, string>();
    try {
      const projects = await this.client.listProjects();
      await mapLimit(projects, 4, async (p) => {
        const m = await this.client.projectMembers(p.projectId);
        if (!m.complete) warnings.push(`Project "${p.title}" has more items than the organizer could list.`);
        for (const c of m.chats) {
          if (c.threadId) membership.set(`thread:${c.threadId}`, p.projectId);
          if (c.conversationId) membership.set(`conv:${lc(c.conversationId)}`, p.projectId);
        }
        for (const t of m.tasks) if (t.sessionId) membership.set(`session:${lc(t.sessionId)}`, p.projectId);
      });
    } catch (e) {
      warnings.push(`Project membership could not be read: ${String((e as Error).message ?? e)}`);
    }
    const childTasks = new Map<string, string[]>();
    for (const t of tasks) {
      if (!t.parentConversationId) continue;
      const key = lc(t.parentConversationId);
      childTasks.set(key, [...(childTasks.get(key) ?? []), t.taskId]);
    }
    const out: Conversation[] = [];
    for (const c of chats) {
      const pid = (c.threadId && membership.get(`thread:${c.threadId}`)) || membership.get(`conv:${lc(c.conversationId)}`);
      out.push(chatToConversation(c, pid, childTasks.get(lc(c.conversationId)) ?? []));
    }
    for (const t of tasks) out.push(taskToConversation(t, membership.get(`session:${lc(t.sessionId)}`)));
    this.warnings = warnings;
    progress?.(out.length, out.length, `Loaded ${chats.length} chats and ${tasks.length} Cowork tasks`);
    return out;
  }

  async getTranscript(item: Conversation, options: { full?: boolean } = {}): Promise<Transcript> {
    if (item.kind === 'chat') {
      const content = await this.client.chatContent(item.id, { path: item.extra?.path as string | undefined });
      const messages = chatMessages(content.messages);
      return {
        source: 'm365',
        id: item.id,
        title: typeof content.header.chatName === 'string' && content.header.chatName ? content.header.chatName : item.title,
        messages,
        partial: !content.complete,
        note: content.complete ? undefined : 'Only the most recent part of this chat could be read.',
        raw: content,
      };
    }
    if (item.kind === 'cowork-task') {
      const sessionId = String(item.extra?.sessionId ?? '');
      const threadId = String(item.extra?.threadId ?? '');
      const detail = await this.client.taskDetail(sessionId);
      if (!options.full || !threadId) {
        return {
          source: 'm365',
          id: item.id,
          title: item.title,
          messages: taskSummaryMessages(item, detail),
          partial: true,
          note: 'Summary of the Cowork task. Load the full conversation to replay its complete event stream.',
          raw: { detail },
        };
      }
      const { events, complete } = await this.client.taskEvents(threadId);
      const { messages, unknownCodes, unknownEvents } = transcriptFromTaskEvents(events);
      if (Object.keys(unknownCodes).length) this.ctx.log(`unknown Cowork event codes ${JSON.stringify(unknownCodes)}`);
      return {
        source: 'm365',
        id: item.id,
        title: item.title,
        messages: [...taskSummaryMessages(item, detail).slice(0, 1), ...messages],
        partial: !complete,
        note: complete ? undefined : 'Very long task: only the most recent events were loaded.',
        raw: { detail, eventCount: events.length, unknownCodes, unknownEvents },
      };
    }
    throw new Error(`Unsupported item kind ${item.kind}`);
  }

  async deleteItems(items: Conversation[], progress?: Progress): Promise<ItemResult[]> {
    let done = 0;
    return mapLimit(items, this.concurrency, async (item): Promise<ItemResult> => {
      try {
        if (item.kind === 'chat') {
          await this.client.deleteChat(item.id);
          const children = Array.isArray(item.extra?.childTaskIds) ? (item.extra.childTaskIds as string[]) : [];
          return { id: item.id, ok: true, alsoRemoved: children.length ? children : undefined };
        }
        if (item.kind === 'cowork-task') {
          const sessionId = String(item.extra?.sessionId ?? '');
          if (!sessionId) throw new Error('Missing Cowork session id');
          await this.client.deleteTask(sessionId);
          return { id: item.id, ok: true };
        }
        throw new Error(`Unsupported item kind ${item.kind}`);
      } catch (e) {
        return { id: item.id, ok: false, error: String((e as Error).message ?? e) };
      } finally {
        done++;
        progress?.(done, items.length, `Deleting ${done}/${items.length}`);
      }
    });
  }

  private memberId(item: Conversation): string {
    if (item.kind === 'chat') {
      const threadId = item.extra?.threadId;
      if (typeof threadId !== 'string' || !threadId) throw new Error('This chat has no thread id, so it cannot be put in a project.');
      return threadId;
    }
    if (item.kind === 'cowork-task') return item.id;
    throw new Error(`Unsupported item kind ${item.kind}`);
  }

  private async addToProject(projectId: string, items: Conversation[], progress?: Progress): Promise<ItemResult[]> {
    let done = 0;
    return mapLimit(items, this.concurrency, async (item): Promise<ItemResult> => {
      try {
        const memberId = this.memberId(item);
        const current = item.projectIds ?? [];
        if (current.includes(projectId)) return { id: item.id, ok: true, detail: 'Already in the project' };
        // An item lives in at most one project: detach it from its current one first.
        for (const old of current) await this.client.removeFromProject(old, memberId);
        if (item.kind === 'chat') await this.client.addChatToProject(projectId, memberId);
        else await this.client.addTaskToProject(projectId, item.id);
        return { id: item.id, ok: true, detail: current.length ? 'Moved from another project' : undefined };
      } catch (e) {
        return { id: item.id, ok: false, error: String((e as Error).message ?? e) };
      } finally {
        done++;
        progress?.(done, items.length, `Adding to project ${done}/${items.length}`);
      }
    });
  }

  private async removeFromProject(projectId: string, items: Conversation[], progress?: Progress): Promise<ItemResult[]> {
    let done = 0;
    return mapLimit(items, this.concurrency, async (item): Promise<ItemResult> => {
      try {
        await this.client.removeFromProject(projectId, this.memberId(item));
        return { id: item.id, ok: true };
      } catch (e) {
        return { id: item.id, ok: false, error: String((e as Error).message ?? e) };
      } finally {
        done++;
        progress?.(done, items.length, `Removing from project ${done}/${items.length}`);
      }
    });
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}
