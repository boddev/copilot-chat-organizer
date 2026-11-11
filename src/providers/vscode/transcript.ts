// Turns a VS Code chat session object into transcript messages.
//
// Each request has message.text (the user prompt) and response[]: the streamed response
// parts. Markdown parts are stored as bare IMarkdownString objects ({ value, ... } without a
// "kind"); everything else has a "kind" (toolInvocationSerialized, inlineReference,
// thinking, textEditGroup, codeblockUri, undoStop, ...). Text is assembled the way VS Code's
// "copy response" does (ChatResponseModel.partsToRepr); tool calls and file edits become
// one-line 'tool' messages, reasoning ("thinking") and UI-only parts are dropped.
import type { TranscriptMessage } from '../../core/types.ts';
import { toIso } from '../../core/types.ts';
import { isObject, requestText, requestsOf, type JsonObject } from './session.ts';

const TOOL_LINE_MAX = 300;

function markdownText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isObject(value) && typeof value.value === 'string') return value.value;
  return '';
}

function oneLine(text: string, max = TOOL_LINE_MAX): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function lastSegment(p: string): string {
  const clean = p.replace(/[?#].*$/, '').replace(/[\\/]+$/, '');
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return i >= 0 ? clean.slice(i + 1) : clean;
}

/** Display text of a serialized URI ({ scheme, path, external?, fsPath? }) or a URI string. */
function uriText(uri: unknown): string {
  if (typeof uri === 'string') {
    if (/^https?:/i.test(uri)) return uri;
    try {
      return decodeURIComponent(lastSegment(uri));
    } catch {
      return lastSegment(uri);
    }
  }
  if (!isObject(uri)) return '';
  const scheme = typeof uri.scheme === 'string' ? uri.scheme : '';
  if (scheme === 'http' || scheme === 'https') {
    if (typeof uri.external === 'string') return uri.external;
    const authority = typeof uri.authority === 'string' ? uri.authority : '';
    const p = typeof uri.path === 'string' ? uri.path : '';
    return `${scheme}://${authority}${p}`;
  }
  const p = typeof uri.fsPath === 'string' ? uri.fsPath : typeof uri.path === 'string' ? uri.path : '';
  return lastSegment(p);
}

function inlineReferenceText(part: JsonObject): string {
  const ref = part.inlineReference;
  if (typeof part.name === 'string' && part.name) return part.name;
  if (isObject(ref)) {
    if ('uri' in ref) return uriText(ref.uri);
    if (typeof ref.name === 'string') return `\`${ref.name}\``;
  }
  return uriText(ref);
}

/** "Read [](file:///c%3A/x/a.ts#1-10), lines 1 to 10" -> "Read a.ts, lines 1 to 10". */
function cleanToolMessage(text: string): string {
  return text.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, label: string, target: string) => label || uriText(target));
}

function toolLine(part: JsonObject): string {
  const data = part.toolSpecificData;
  if (isObject(data)) {
    if (data.kind === 'terminal') {
      const cl = data.commandLine;
      const cmd = isObject(cl)
        ? [cl.userEdited, cl.toolEdited, cl.original].find((c): c is string => typeof c === 'string' && c.trim() !== '')
        : typeof data.command === 'string'
          ? data.command
          : undefined;
      if (cmd) return oneLine(`Ran: ${cmd}`);
    }
    if (data.kind === 'subagent' && typeof data.description === 'string' && data.description.trim()) {
      return oneLine(`Subagent: ${data.description}`);
    }
  }
  const message =
    markdownText(part.pastTenseMessage) || markdownText(part.invocationMessage) || markdownText(part.generatedTitle);
  const text = oneLine(cleanToolMessage(message));
  if (text) return text;
  return typeof part.toolId === 'string' ? `Used tool ${part.toolId}` : 'Used a tool';
}

function responseParts(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (typeof response === 'string') return [{ value: response }];
  if (isObject(response) && Array.isArray(response.value)) return response.value;
  if (isObject(response) && typeof response.value === 'string') return [response];
  return [];
}

function addResponse(out: TranscriptMessage[], response: unknown, at: string | undefined): void {
  let blocks: string[] = [];
  let segments: string[] = [];
  const endBlock = (): void => {
    if (segments.length) blocks.push(segments.join(''));
    segments = [];
  };
  const flush = (): void => {
    endBlock();
    const text = blocks.join('\n\n').trim();
    blocks = [];
    if (text) out.push({ role: 'assistant', text, at });
  };
  const tool = (line: string): void => {
    flush();
    const prev = out[out.length - 1];
    if (prev && prev.role === 'tool' && prev.text === line) return;
    out.push({ role: 'tool', text: line, at });
  };
  const block = (text: string): void => {
    endBlock();
    if (text.trim()) blocks.push(text);
  };

  for (const part of responseParts(response)) {
    if (typeof part === 'string') {
      segments.push(part);
      continue;
    }
    if (!isObject(part)) continue;
    switch (part.kind) {
      case undefined:
        // Markdown content is persisted as a bare IMarkdownString.
        if (typeof part.value === 'string') segments.push(part.value);
        break;
      case 'markdownContent':
      case 'markdownVuln':
      case 'warning':
      case 'progressTask':
      case 'progressTaskSerialized':
        segments.push(markdownText(part.content));
        break;
      case 'inlineReference':
        segments.push(inlineReferenceText(part));
        break;
      case 'command':
        block(isObject(part.command) && typeof part.command.title === 'string' ? part.command.title : '');
        break;
      case 'confirmation':
        block([typeof part.title === 'string' ? part.title : '', markdownText(part.message)].filter(Boolean).join('\n'));
        break;
      case 'toolInvocation':
      case 'toolInvocationSerialized':
        tool(toolLine(part));
        break;
      case 'textEditGroup':
      case 'notebookEditGroup': {
        const name = uriText(part.uri);
        tool(name ? `Edited ${name}` : 'Edited a file');
        break;
      }
      case 'clearToPreviousToolInvocation':
        blocks = [];
        segments = [];
        break;
      default:
        // thinking, progressMessage, codeblockUri, undoStop, prepareToolInvocation,
        // mcpServersStarting, elicitation*, questionCarousel, treeData, ...: UI-only.
        break;
    }
  }
  flush();
}

function responseTime(request: JsonObject): string | undefined {
  const start = typeof request.timestamp === 'number' ? request.timestamp : undefined;
  if (start === undefined) return toIso(request.timestamp);
  const result = isObject(request.result) ? request.result : undefined;
  const timings = result && isObject(result.timings) ? result.timings : undefined;
  const elapsed = timings && typeof timings.totalElapsed === 'number' ? timings.totalElapsed : request.elapsedMs;
  return toIso(typeof elapsed === 'number' && elapsed > 0 ? start + elapsed : start);
}

export function buildTranscriptMessages(session: JsonObject): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const request of requestsOf(session)) {
    const text = requestText(request).trim();
    if (text) {
      const role = request.isSystemInitiated === true ? 'system' : 'user';
      out.push({ role, text, at: toIso(request.timestamp) });
    }
    const at = responseTime(request);
    addResponse(out, request.response, at);
    const result = isObject(request.result) ? request.result : undefined;
    const error = result && isObject(result.errorDetails) ? result.errorDetails.message : undefined;
    if (typeof error === 'string' && error.trim()) out.push({ role: 'status', text: `Error: ${error.trim()}`, at });
    else if (request.isCanceled === true) out.push({ role: 'status', text: 'Canceled', at });
  }
  return out;
}

/** Response text only (markdown and inline references), for slimmed raw copies. */
function responseMarkdown(response: unknown): string {
  const out: TranscriptMessage[] = [];
  addResponse(out, response, undefined);
  return out
    .filter((m) => m.role === 'assistant')
    .map((m) => m.text)
    .join('\n\n');
}

/**
 * The session object for Transcript.raw, bounded to roughly `maxChars` of JSON. Oversized
 * sessions are reduced to request/response text (and as many requests as fit).
 */
export function boundRaw(session: JsonObject, maxChars = 1_500_000): unknown {
  let size: number;
  try {
    size = JSON.stringify(session).length;
  } catch {
    size = Number.POSITIVE_INFINITY;
  }
  if (size <= maxChars) return session;
  const requests: unknown[] = [];
  let budget = maxChars - 2_000;
  let omitted = 0;
  for (const r of requestsOf(session)) {
    const slim = {
      requestId: r.requestId,
      timestamp: r.timestamp,
      modelId: r.modelId,
      message: { text: requestText(r) },
      response: responseMarkdown(r.response),
    };
    const cost = JSON.stringify(slim).length;
    if (cost > budget) {
      omitted++;
      continue;
    }
    budget -= cost;
    requests.push(slim);
  }
  return {
    truncated: true,
    originalChars: Number.isFinite(size) ? size : undefined,
    omittedRequests: omitted || undefined,
    version: session.version,
    sessionId: session.sessionId,
    creationDate: session.creationDate,
    lastMessageDate: session.lastMessageDate,
    customTitle: session.customTitle,
    requests,
  };
}
