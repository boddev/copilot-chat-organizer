// Streams session-state/<id>/events.jsonl (one JSON event per line; files can be tens of MB).
// Only the lines whose "type" is wanted are decoded and parsed.
//
// Event shapes used (all lines: {type, data, id, timestamp, parentId, agentId?}):
//   user.message       data.content; data.source: undefined = typed by the user,
//                      'skill-*' = injected skill text (skipped), 'agent-*' = message from
//                      another session, 'system' / 'autopilot' = generated prompts.
//                      Lines with a top-level agentId belong to sub-agents (skipped).
//   assistant.message  data.content (empty when the message only requests tools),
//                      data.messageId, data.chunkIndex, data.parentToolCallId (sub-agent).
//   abort              data.reason
//   session.error      data.errorType, data.message
import fsp from 'node:fs/promises';
import { toIso } from '../../core/types.ts';
import type { TranscriptMessage, TranscriptRole } from '../../core/types.ts';

export interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
  timestamp?: unknown;
  agentId?: unknown;
}

export interface ScanResult {
  size: number;
  bytesRead: number;
  /** Stopped at `maxBytes` before the end of the file. */
  truncated: boolean;
}

const NL = 0x0a;
const HEAD_BYTES = 256;
const TYPE_RE = /"type"\s*:\s*"([^"\\]{1,100})"/;
const CHUNK = 1 << 20;

function lineType(buf: Buffer): string | undefined {
  return TYPE_RE.exec(buf.toString('latin1', 0, Math.min(buf.length, HEAD_BYTES)))?.[1];
}

export interface ScanOptions {
  /** Read at most this many bytes (counted from `start`). */
  maxBytes: number;
  /** Byte offset to start at; the partial line there is skipped. */
  start?: number;
  chunkSize?: number;
}

/**
 * Calls `onEvent` for each parsed event whose type passes `want`. Returning false from
 * `onEvent` stops early.
 */
export async function scanEvents(
  file: string,
  options: ScanOptions,
  want: (type: string) => boolean,
  onEvent: (event: SessionEvent) => boolean | void,
): Promise<ScanResult> {
  const fh = await fsp.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const begin = Math.min(size, Math.max(0, Math.floor(options.start ?? 0)));
    // Starting one byte early means a line that begins exactly at `begin` is kept.
    let pos = begin > 0 ? begin - 1 : 0;
    const limit = Math.min(size, begin + Math.max(0, options.maxBytes));
    const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(options.chunkSize ?? CHUNK, limit - pos)));
    let parts: Buffer[] = [];
    let partsLen = 0;
    let typeChecked = false;
    let skipping = begin > 0;
    let stopped = false;

    const handle = (line: Buffer): boolean => {
      const type = lineType(line);
      if (!type || !want(type)) return true;
      let ev: unknown;
      try {
        ev = JSON.parse(line.toString('utf8'));
      } catch {
        return true; // torn or partial line
      }
      if (!ev || typeof ev !== 'object' || typeof (ev as SessionEvent).type !== 'string') return true;
      return onEvent(ev as SessionEvent) !== false;
    };

    outer: while (pos < limit) {
      const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, limit - pos), pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const buf = chunk.subarray(0, bytesRead);
      let start = 0;
      while (start < buf.length) {
        const nl = buf.indexOf(NL, start);
        if (nl === -1) {
          if (!skipping) {
            parts.push(Buffer.from(buf.subarray(start)));
            partsLen += buf.length - start;
            if (!typeChecked && partsLen >= HEAD_BYTES) {
              typeChecked = true;
              const type = lineType(parts.length === 1 ? parts[0] : Buffer.concat(parts, partsLen));
              if (type !== undefined && !want(type)) {
                skipping = true;
                parts = [];
                partsLen = 0;
              }
            }
          }
          break;
        }
        if (skipping) skipping = false;
        else {
          let line = buf.subarray(start, nl);
          if (partsLen) {
            parts.push(line);
            line = Buffer.concat(parts, partsLen + line.length);
          }
          if (line.length && !handle(line)) {
            stopped = true;
            break outer;
          }
        }
        parts = [];
        partsLen = 0;
        typeChecked = false;
        start = nl + 1;
      }
    }
    if (!stopped && pos >= size && partsLen && !skipping) handle(Buffer.concat(parts, partsLen));
    return { size, bytesRead: Math.max(0, pos - begin), truncated: !stopped && pos < size };
  } finally {
    await fh.close();
  }
}

/** Transcript role for a user.message event, or undefined when it should be hidden. */
export function userMessageRole(event: SessionEvent): TranscriptRole | undefined {
  if (event.agentId) return undefined;
  const source = typeof event.data?.source === 'string' ? event.data.source : '';
  if (source.startsWith('skill-')) return undefined;
  if (source === 'system' || source === 'autopilot') return 'system';
  return 'user';
}

function contentOf(event: SessionEvent): string {
  const c = event.data?.content;
  return typeof c === 'string' ? c : '';
}

export interface EventsTranscript extends ScanResult {
  /** Messages in log order; for a log read as head and tail, the head's messages. */
  messages: TranscriptMessage[];
  /** Set when the middle of a log larger than the read limit was skipped. */
  tail?: { messages: TranscriptMessage[]; bytesRead: number; skippedBytes: number };
}

export interface TranscriptReadOptions {
  /**
   * For a log larger than the read limit, read this many of the limit's bytes from the end of the
   * log instead, so the transcript shows how the conversation ends.
   */
  tailBytes?: number;
  chunkSize?: number;
}

/** Event types that make up a transcript. github.com agent tasks use the same event format. */
export const TRANSCRIPT_EVENT_TYPES: readonly string[] = ['user.message', 'assistant.message', 'abort', 'session.error'];
/** The `data` fields the transcript reads; everything else can be dropped early. */
export const TRANSCRIPT_DATA_FIELDS: readonly string[] = [
  'content',
  'source',
  'messageId',
  'chunkIndex',
  'parentToolCallId',
  'reason',
  'errorType',
  'message',
];
const TRANSCRIPT_TYPES = new Set(TRANSCRIPT_EVENT_TYPES);

/** Builds transcript messages from session events fed in log order. */
export function createTranscriptCollector(): { messages: TranscriptMessage[]; add: (ev: SessionEvent) => void } {
  const messages: TranscriptMessage[] = [];
  let lastAssistantId: string | undefined;
  const add = (ev: SessionEvent): void => {
    const data = ev.data ?? {};
    const at = toIso(ev.timestamp);
    if (ev.type === 'user.message') {
      const role = userMessageRole(ev);
      const body = contentOf(ev);
      if (role && body.trim()) {
        messages.push({ role, text: body, at });
        lastAssistantId = undefined;
      }
    } else if (ev.type === 'assistant.message') {
      if (ev.agentId || data.parentToolCallId) return;
      const body = contentOf(ev);
      if (!body.trim()) return;
      const messageId = typeof data.messageId === 'string' ? data.messageId : undefined;
      const last = messages[messages.length - 1];
      const continues = typeof data.chunkIndex === 'number' && data.chunkIndex > 0;
      if (continues && messageId && messageId === lastAssistantId && last?.role === 'assistant') last.text += body;
      else messages.push({ role: 'assistant', text: body, at });
      lastAssistantId = messageId;
    } else if (ev.type === 'abort') {
      const reason = typeof data.reason === 'string' && data.reason ? `: ${data.reason}` : '';
      messages.push({ role: 'status', text: `Stopped${reason}`, at });
    } else if (ev.type === 'session.error') {
      const detail = typeof data.message === 'string' && data.message ? data.message : String(data.errorType ?? 'unknown error');
      messages.push({ role: 'status', text: `Error: ${detail}`, at });
    }
  };
  return { messages, add };
}

/** Transcript messages from an in-memory event list (e.g. a github.com task's events). */
export function eventsToMessages(events: Iterable<unknown>): TranscriptMessage[] {
  const collector = createTranscriptCollector();
  for (const ev of events) {
    if (ev && typeof ev === 'object' && TRANSCRIPT_TYPES.has((ev as SessionEvent).type)) collector.add(ev as SessionEvent);
  }
  return collector.messages;
}

export async function readEventsTranscript(file: string, maxBytes: number, options: TranscriptReadOptions = {}): Promise<EventsTranscript> {
  const want = (t: string) => TRANSCRIPT_TYPES.has(t);
  const { chunkSize } = options;
  const tailBytes = Math.max(0, Math.min(Math.floor(options.tailBytes ?? 0), maxBytes));
  const size = tailBytes ? (await fsp.stat(file)).size : 0;
  if (!tailBytes || size <= maxBytes) {
    const collector = createTranscriptCollector();
    const result = await scanEvents(file, { maxBytes, chunkSize }, want, collector.add);
    return { ...result, messages: collector.messages };
  }
  const head = createTranscriptCollector();
  const first = await scanEvents(file, { maxBytes: maxBytes - tailBytes, chunkSize }, want, head.add);
  const tail = createTranscriptCollector();
  const start = Math.max(first.bytesRead, size - tailBytes);
  const last = await scanEvents(file, { start, maxBytes: tailBytes, chunkSize }, want, tail.add);
  return {
    size: last.size,
    bytesRead: first.bytesRead + last.bytesRead,
    truncated: true,
    messages: head.messages,
    tail: { messages: tail.messages, bytesRead: last.bytesRead, skippedBytes: start - first.bytesRead },
  };
}

export interface EventsHead {
  /** Number of user-typed messages; undefined when the log was too large to count. */
  userMessages?: number;
  firstUser?: string;
  lastAssistant?: string;
}

export interface HeadLimits {
  /** Logs up to this size are read in one pass (count, first message, latest answer). */
  fullBytes: number;
  /** Logs up to this size are read once for user messages only; the answer comes from the tail. */
  countBytes: number;
  /** Larger logs are read only this far, looking for the first user message. */
  scanBytes: number;
  /** Bytes read from the end of a log that is not read in one pass, for the latest answer. */
  tailBytes: number;
}

const HEAD_TEXT = 1000;

/** Cheap listing summary of an event log; see HeadLimits for how much is read. */
export async function readEventsHead(file: string, limits: HeadLimits, knownSize?: number): Promise<EventsHead> {
  const size = knownSize ?? (await fsp.stat(file)).size;
  const full = size <= limits.fullBytes;
  const counting = size <= limits.countBytes;
  const head: EventsHead = {};
  let count = 0;
  let lastId: string | undefined;
  const onAssistant = (ev: SessionEvent) => {
    if (ev.agentId || ev.data?.parentToolCallId) return;
    const body = contentOf(ev);
    if (!body.trim()) return;
    const id = typeof ev.data?.messageId === 'string' ? ev.data.messageId : undefined;
    const continues = typeof ev.data?.chunkIndex === 'number' && ev.data.chunkIndex > 0 && id !== undefined && id === lastId;
    head.lastAssistant = (continues ? (head.lastAssistant ?? '') + body : body).slice(0, HEAD_TEXT);
    lastId = id;
  };
  const first = await scanEvents(
    file,
    { maxBytes: counting ? limits.countBytes : limits.scanBytes },
    (t) => t === 'user.message' || (full && t === 'assistant.message'),
    (ev) => {
      if (ev.type !== 'user.message') return onAssistant(ev);
      if (userMessageRole(ev) !== 'user') return;
      const body = contentOf(ev);
      if (!body.trim()) return;
      count++;
      head.firstUser ??= body.slice(0, HEAD_TEXT);
      if (!counting) return false;
    },
  );
  if (counting && !first.truncated) head.userMessages = count;
  if (!full) {
    await scanEvents(file, { start: Math.max(0, first.size - limits.tailBytes), maxBytes: limits.tailBytes }, (t) => t === 'assistant.message', onAssistant);
  }
  return head;
}
