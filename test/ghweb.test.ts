import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { SignInRequiredError, type BrowserSession } from '../src/lib/browser-session.ts';
import { sleep } from '../src/lib/async.ts';
import type { TranscriptMessage } from '../src/core/types.ts';
import type { TransportPhase, TransportState } from '../src/providers/m365/transport.ts';
import { TRANSCRIPT_DATA_FIELDS, TRANSCRIPT_EVENT_TYPES } from '../src/providers/ghapp/events.ts';
import {
  API_BASE,
  GhWebPageTransport,
  LOGIN_URL,
  apiUrl,
  isGitHubUrl,
  isSignInPage,
  pageRequest,
  pageUrl,
  type GhWebIdentity,
  type GhWebRequestOptions,
  type GhWebResponse,
  type GhWebTransport,
  type PageRequestArgs,
  type SlimEventsBody,
} from '../src/providers/ghweb/transport.ts';
import {
  GhWebProvider,
  detailMessages,
  mergeByTime,
  nextLink,
  taskKind,
  type GhWebProviderOptions,
  type TaskDetail,
  type TaskRecord,
} from '../src/providers/ghweb/index.ts';
import { conv, tempDir } from './support/fakes.ts';

// ---------- pageRequest: runs inside the github.com page ----------

const TOKEN_PATH = '/copilot/agent-sessions/cmc-api-token';
const TOKEN_CACHE = '__copilotChatOrganizerAgentsToken';
const SCHEME = 'GitHub-Bearer';
const TASK_URL = `${API_BASE}tasks/t1`;

interface FetchCall {
  url: string;
  init: any;
}

const json = (status: number, body: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });

/** Fake github.com page globals: fetch (token endpoint and API), the fetch-nonce meta tag and the token cache. */
function pageEnv(api: (url: string, init: any) => Response | Promise<Response>, token?: (n: number) => Response): any {
  let tokens = 0;
  const calls: FetchCall[] = [];
  return {
    calls,
    document: {
      querySelector: (selector: string) =>
        selector === 'meta[name="fetch-nonce"]' ? { getAttribute: (name: string) => (name === 'content' ? 'nonce-1' : null) } : null,
    },
    fetch: async (url: string, init: any) => {
      calls.push({ url, init });
      if (url !== TOKEN_PATH) return api(url, init);
      tokens++;
      return token ? token(tokens) : json(200, { token: `tok${tokens}`, expiration: Math.floor(Date.now() / 1000) + 3600 });
    },
  };
}
const tokenCalls = (env: any): FetchCall[] => env.calls.filter((c: FetchCall) => c.url === TOKEN_PATH);
const apiCalls = (env: any): FetchCall[] => env.calls.filter((c: FetchCall) => c.url !== TOKEN_PATH);

/** A response whose body arrives in fixed-size chunks; records whether the reader cancelled it. */
function chunked(text: string, chunkSize: number, status = 200) {
  const bytes = new TextEncoder().encode(text);
  const state = { cancelled: false, served: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.served >= bytes.length) {
        controller.close();
        return;
      }
      const chunk = bytes.slice(state.served, state.served + chunkSize);
      state.served += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(stream, { status }), state };
}

const reqArgs = (extra: Partial<PageRequestArgs> = {}): PageRequestArgs => ({
  method: 'GET',
  url: TASK_URL,
  tokenPath: TOKEN_PATH,
  headers: { accept: 'application/json', 'copilot-integration-id': 'copilot-web' },
  timeoutMs: 5_000,
  ...extra,
});
const eventsArgs = (maxBytes?: number) =>
  reqArgs({ url: `${TASK_URL}/events`, events: { types: [...TRANSCRIPT_EVENT_TYPES], dataFields: [...TRANSCRIPT_DATA_FIELDS], maxBytes } });
const slimBody = (res: { text: string }) => JSON.parse(res.text) as SlimEventsBody;
const ahpEvent = (type: string, action: Record<string, unknown>, at = '2026-01-01T00:00:00.000Z') => ({
  ns: 'ahp',
  at,
  payload: { data: { action: { type, ...action } } },
});

test('pageRequest gets an API token once, caches it and calls the API with it', async () => {
  const env = pageEnv(() => json(200, { tasks: [] }, { link: '<?cursor=c2>; rel="next"', 'retry-after': '3' }));
  const first = await pageRequest(reqArgs(), env);
  assert.deepEqual(first, { status: 200, text: '{"tasks":[]}', link: '<?cursor=c2>; rel="next"', retryAfter: '3' });
  await pageRequest(reqArgs({ method: 'DELETE' }), env);

  const [tokenCall, ...moreTokenCalls] = tokenCalls(env);
  assert.equal(moreTokenCalls.length, 0);
  assert.equal(tokenCall.init.method, 'POST');
  assert.equal(tokenCall.init.credentials, 'include');
  assert.equal(tokenCall.init.headers['x-fetch-nonce'], 'nonce-1');
  assert.equal(tokenCall.init.headers['github-verified-fetch'], 'true');
  assert.equal(tokenCall.init.headers['x-requested-with'], 'XMLHttpRequest');
  assert.deepEqual(
    apiCalls(env).map((c) => [c.init.method, c.url, c.init.headers.authorization, c.init.headers['copilot-integration-id']]),
    [
      ['GET', TASK_URL, `${SCHEME} tok1`, 'copilot-web'],
      ['DELETE', TASK_URL, `${SCHEME} tok1`, 'copilot-web'],
    ],
  );
  assert.ok(apiCalls(env)[0].init.signal instanceof AbortSignal);
  assert.equal(env[TOKEN_CACHE].token, 'tok1');
});

test('pageRequest replaces a token that is about to expire and reads each expiration format', async () => {
  const now = Date.now();
  const formats: Array<[unknown, number]> = [
    [Math.floor(now / 1000) + 3600, now + 3_600_000],
    [now + 7_200_000, now + 7_200_000],
    [new Date(now + 1_800_000).toISOString(), now + 1_800_000],
    [undefined, now + 600_000],
  ];
  for (const [expiration, expected] of formats) {
    const env = pageEnv(() => json(200, {}), () => json(200, { token: 'fresh', expiration }));
    env[TOKEN_CACHE] = { token: 'stale', exp: Date.now() + 60_000 };
    await pageRequest(reqArgs(), env);
    assert.equal(tokenCalls(env).length, 1);
    assert.equal(apiCalls(env)[0].init.headers.authorization, `${SCHEME} fresh`);
    assert.ok(Math.abs(env[TOKEN_CACHE].exp - expected) < 2_000, `expiration ${String(expiration)}`);
  }
});

test('pageRequest gets a new token once when the API rejects the cached one', async () => {
  let n = 0;
  const env = pageEnv(() => (++n === 1 ? json(401, { message: 'Bad credentials' }) : json(200, { ok: true })));
  assert.equal((await pageRequest(reqArgs(), env)).status, 200);
  assert.deepEqual(
    apiCalls(env).map((c) => c.init.headers.authorization),
    [`${SCHEME} tok1`, `${SCHEME} tok2`],
  );

  const rejected = pageEnv(() => json(401, { message: 'Bad credentials' }));
  const res = await pageRequest(reqArgs(), rejected);
  assert.deepEqual([res.status, res.text, res.tokenStatus], [401, '{"message":"Bad credentials"}', undefined]);
  assert.equal(apiCalls(rejected).length, 2);
  assert.equal(tokenCalls(rejected).length, 2);
});

test('pageRequest reports a token failure without calling the API', async () => {
  const failures: Array<[() => Response, number]> = [
    [() => new Response('nope', { status: 404 }), 404],
    [() => new Response('<html>', { status: 200 }), 502],
    [() => json(200, { token: '' }), 502],
  ];
  for (const [token, status] of failures) {
    const env = pageEnv(() => json(200, {}), token);
    assert.deepEqual(await pageRequest(reqArgs(), env), { status, text: '', link: null, retryAfter: null, tokenStatus: status });
    assert.equal(apiCalls(env).length, 0);
    assert.equal(env[TOKEN_CACHE], undefined);
  }
});

test('pageRequest keeps only transcript events and fields, and counts every event kind', async () => {
  const events = [
    { type: 'user.message', timestamp: 'T0', data: { content: 'Fix it', source: 'user', attachments: ['big'] } },
    { type: 'tool.execution_start', timestamp: 'T1', data: { toolName: 'bash' } },
    { type: 'assistant.message', timestamp: 'T2', agentId: 'sub-1', data: { content: 'Done', messageId: 'm1', toolRequests: [1, 2] } },
    ahpEvent('chat/turnStarted', { startedAt: 'S1', message: { text: 'Hi', origin: { kind: 'user' } } }, 'A1'),
    ahpEvent('chat/responsePart', { part: { kind: 'markdown', id: 'p1', content: 'Hel' } }, 'A2'),
    ahpEvent('chat/delta', { partId: 'p1', content: 'lo' }, 'A3'),
    ahpEvent('chat/responsePart', { part: { kind: 'toolInvocation', id: 'p2', content: 'ls' } }, 'A4'),
    ahpEvent('chat/delta', { partId: 'p2', content: ' -la' }, 'A5'),
    ahpEvent('chat/turnError', { error: { message: 'boom' } }, 'A6'),
    ahpEvent('chat/turnCancelled', { reason: 'user' }, 'A7'),
    ahpEvent('chat/titleChanged', { title: 'x' }, 'A8'),
    { ns: 'telemetry', x: 1 },
    { id: 'x', foo: 1 },
    null,
  ];
  const text = JSON.stringify({ events, total: events.length });
  const body = slimBody(await pageRequest(eventsArgs(), pageEnv(() => new Response(text))));
  assert.deepEqual([body.total, body.count, body.truncated, body.bytes], [14, 14, false, Buffer.byteLength(text)]);
  assert.deepEqual(body.kinds, {
    'user.message': 1,
    'tool.execution_start': 1,
    'assistant.message': 1,
    'ahp:chat/turnStarted': 1,
    'ahp:chat/responsePart': 2,
    'ahp:chat/delta': 2,
    'ahp:chat/turnError': 1,
    'ahp:chat/turnCancelled': 1,
    'ahp:chat/titleChanged': 1,
    'telemetry:?': 1,
    '?:id+foo': 1,
    '(invalid)': 1,
  });
  assert.deepEqual(body.events, [
    { type: 'user.message', timestamp: 'T0', data: { content: 'Fix it', source: 'user' } },
    { type: 'assistant.message', timestamp: 'T2', agentId: 'sub-1', data: { content: 'Done', messageId: 'm1' } },
    { at: 'A1', ahp: { type: 'chat/turnStarted', at: 'S1', text: 'Hi', origin: 'user' } },
    { at: 'A2', ahp: { type: 'chat/responsePart', partId: 'p1', text: 'Hel' } },
    { at: 'A3', ahp: { type: 'chat/delta', partId: 'p1', text: 'lo' } },
    { at: 'A6', ahp: { type: 'chat/turnError', text: 'boom' } },
    { at: 'A7', ahp: { type: 'chat/turnCancelled', text: 'user' } },
  ]);
});

test('pageRequest bounds the event-kind histogram', async () => {
  const events = Array.from({ length: 70 }, (_, i) => ({ type: `kind.${i}.${'x'.repeat(100)}`, data: {} }));
  const body = slimBody(await pageRequest(eventsArgs(), pageEnv(() => json(200, { events }))));
  assert.equal(Object.keys(body.kinds).length, 60);
  assert.ok(Object.keys(body.kinds).every((k) => k.length === 80));
  assert.deepEqual([body.count, body.total, body.events.length], [70, undefined, 0]);
});

test('pageRequest stops reading a long event log at maxBytes and keeps the complete events', async () => {
  const events = Array.from({ length: 50 }, (_, i) => ({
    type: 'user.message',
    timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    data: { content: `message ${i}: "quoted" {braces} [brackets] \\ backslash ${'x'.repeat(40)}` },
  }));
  const text = JSON.stringify({ events, total: events.length });
  const { response, state } = chunked(text, 128);
  const body = slimBody(await pageRequest(eventsArgs(1_000), pageEnv(() => response)));
  assert.equal(body.truncated, true);
  assert.equal(body.total, undefined);
  assert.ok(body.count > 0 && body.count < events.length, `count ${body.count}`);
  assert.ok(body.bytes > 1_000 && body.bytes <= 1_000 + 128, `bytes ${body.bytes}`);
  assert.deepEqual(
    body.events.map((e: any) => e.data.content),
    events.slice(0, body.count).map((e) => e.data.content),
  );
  assert.equal(body.kinds['user.message'], body.count);
  assert.equal(state.cancelled, true);
  assert.ok(state.served < text.length);
});

test('pageRequest notices when the event array ended before maxBytes', async () => {
  const events = [
    { type: 'user.message', data: { content: 'short' } },
    { type: 'assistant.message', data: { content: 'reply', messageId: 'm1' } },
  ];
  const { response, state } = chunked(JSON.stringify({ events, total: 2, padding: 'p'.repeat(5_000) }), 64);
  const body = slimBody(await pageRequest(eventsArgs(300), pageEnv(() => response)));
  assert.deepEqual([body.truncated, body.total, body.count, body.events.length], [false, 2, 2, 2]);
  assert.equal(state.cancelled, true);
});

test('pageRequest hands back an excerpt when the response is not an event log', async () => {
  const moved = await pageRequest(eventsArgs(), pageEnv(() => json(200, { message: 'Moved' })));
  assert.deepEqual([moved.status, moved.text], [200, '{"message":"Moved"}']);

  const html = `<html>${'x'.repeat(5_000)}</html>`;
  const page = await pageRequest(eventsArgs(), pageEnv(() => new Response(html)));
  assert.equal(page.text, html.slice(0, 2_000));

  const cut = await pageRequest(eventsArgs(100), pageEnv(() => chunked(html, 64).response));
  assert.equal(cut.status, 200);
  assert.ok(cut.text.startsWith('<html>') && cut.text.length <= 2_000);

  const missing = await pageRequest(eventsArgs(), pageEnv(() => new Response('Not Found', { status: 404 })));
  assert.deepEqual([missing.status, missing.text], [404, 'Not Found']);
});

test('pageRequest reads "events": null as a task with no history', async () => {
  const text = JSON.stringify({ events: null, total: 0 });
  const body = slimBody(await pageRequest(eventsArgs(), pageEnv(() => new Response(text))));
  assert.deepEqual(body, { total: 0, count: 0, bytes: text.length, truncated: false, kinds: {}, events: [] });
});

test('pageRequest reads the whole body when the response cannot be streamed', async () => {
  const text = JSON.stringify({ events: [{ type: 'user.message', data: { content: 'hi' } }], total: 1 });
  const plain = { status: 200, ok: true, headers: new Headers(), body: null, text: async () => text };
  const body = slimBody(await pageRequest(eventsArgs(5), pageEnv(() => plain as unknown as Response)));
  assert.deepEqual([body.count, body.total, body.truncated, body.bytes], [1, 1, false, text.length]);
});

// ---------- helpers ----------

test('apiUrl resolves paths and pagination links but stays inside the agents API', () => {
  assert.equal(apiUrl('tasks/t1'), `${API_BASE}tasks/t1`);
  assert.equal(apiUrl('?cursor=c2', `${API_BASE}tasks?creator_id=42&page=1`), `${API_BASE}tasks?cursor=c2`);
  assert.equal(apiUrl(`${API_BASE}tasks?page=2`), `${API_BASE}tasks?page=2`);
  for (const bad of [
    'https://evil.example.com/tasks',
    '/user',
    '../../user',
    '//evil.example.com/x',
    'https://api.github.com/cmc_internal/api/agents.evil/tasks',
  ]) {
    assert.throws(() => apiUrl(bad), /Refusing to call a URL outside the Copilot agents API/, bad);
  }
});

test('pageUrl maps pagination links on the public agents path onto the API base', () => {
  const current = `${API_BASE}tasks?creator_id=42&page=1&per_page=250`;
  assert.equal(
    pageUrl('https://api.github.com/agents/tasks?creator_id=42&page=2&per_page=250', current),
    `${API_BASE}tasks?creator_id=42&page=2&per_page=250`,
  );
  assert.equal(pageUrl('/agents/tasks?page=3', current), `${API_BASE}tasks?page=3`);
  assert.equal(pageUrl('?cursor=c2', current), `${API_BASE}tasks?cursor=c2`);
  assert.equal(pageUrl(`${API_BASE}tasks?page=2`, current), `${API_BASE}tasks?page=2`);
  for (const bad of [
    'https://evil.example.com/agents/tasks?page=2',
    'http://api.github.com/agents/tasks?page=2',
    'https://api.github.com/agents/../user',
    'https://api.github.com/agents/%2e%2e/user',
    'https://api.github.com/agentsx/tasks',
    '/user',
  ]) {
    assert.throws(() => pageUrl(bad, current), /Refusing to call a URL outside the Copilot agents API/, bad);
  }
});

test('nextLink finds the rel="next" target of a Link header', () => {
  assert.equal(nextLink('<?cursor=c2>; rel="next"'), '?cursor=c2');
  assert.equal(
    nextLink('<https://a/x?page=1>; rel="prev", <https://a/x?page=3>; rel="next", <https://a/x?page=9>; rel="last"'),
    'https://a/x?page=3',
  );
  assert.equal(nextLink('<https://a/x?page=3>; rel=next'), 'https://a/x?page=3');
  assert.equal(nextLink('<https://a/x?page=9>; rel="last"'), undefined);
  assert.equal(nextLink('<https://a/x>; rel="nextish"'), undefined);
  assert.equal(nextLink(null), undefined);
  assert.equal(nextLink(''), undefined);
});

test('isGitHubUrl and isSignInPage recognize github.com and its sign-in pages', () => {
  assert.equal(isGitHubUrl('https://github.com'), true);
  assert.equal(isGitHubUrl('https://github.com/copilot'), true);
  assert.equal(isGitHubUrl('https://github.com.evil.example/'), false);
  assert.equal(isGitHubUrl('https://gist.github.com/'), false);
  for (const url of [
    LOGIN_URL,
    'https://github.com/session',
    'https://github.com/sessions/two-factor/app',
    'https://github.com/orgs/acme/sso?return_to=x',
    'https://github.com/enterprises/contoso/sso',
  ]) {
    assert.equal(isSignInPage(url), true, url);
  }
  for (const url of ['https://github.com/copilot', 'https://github.com/loginfoo', 'https://login.microsoftonline.com/']) {
    assert.equal(isSignInPage(url), false, url);
  }
});

test('taskKind tells web chats, synced app/CLI sessions and agent tasks apart', () => {
  const cli = { slug: 'copilot-developer-cli' };
  assert.equal(taskKind({ id: 'a', agent_collaborators: [cli] }, true), 'web-chat');
  assert.equal(taskKind({ id: 'a', agent_collaborators: [cli, cli] }, false), 'cli-task');
  assert.equal(taskKind({ id: 'a', agent_collaborators: [cli, { slug: 'copilot-developer' }] }, false), 'agent-task');
  assert.equal(taskKind({ id: 'a', agent_collaborators: [] }, false), 'agent-task');
  assert.equal(taskKind({ id: 'a', agent_collaborators: null }, false), 'agent-task');
});

test('mergeByTime interleaves two timelines and keeps untimed messages in place', () => {
  const m = (text: string, at?: string): TranscriptMessage => ({ role: 'user', text, at });
  const a = [m('A1', '2026-01-01T00:00:01.000Z'), m('A3', '2026-01-01T00:00:03.000Z'), m('A-untimed'), m('A5', '2026-01-01T00:00:05.000Z')];
  const b = [m('B2', '2026-01-01T00:00:02.000Z'), m('B4', '2026-01-01T00:00:04.000Z')];
  assert.deepEqual(
    mergeByTime(a, b).map((x) => x.text),
    ['A1', 'B2', 'A3', 'A-untimed', 'B4', 'A5'],
  );
  assert.equal(mergeByTime([], b), b);
  assert.equal(mergeByTime(a, []), a);
});

test('detailMessages says when a task has no history', () => {
  assert.deepEqual(detailMessages({ id: 't', state: 'timed_out' }), [
    { role: 'status', text: 'No conversation history found on github.com (task timed out).' },
  ]);
  assert.deepEqual(detailMessages({ id: 't', sessions: null }), [{ role: 'status', text: 'No conversation history found on github.com.' }]);
});

// ---------- GhWebProvider ----------

type Route = (match: RegExpExecArray, options: GhWebRequestOptions | undefined) => GhWebResponse | Promise<GhWebResponse>;

/** Scripted stand-in for the github.com page transport; records every call. */
class FakeTransport implements GhWebTransport {
  phase: TransportPhase = 'ready';
  message: string | undefined;
  me: GhWebIdentity | undefined = { login: 'octocat', id: '42' };
  closed = false;
  readonly calls: string[] = [];
  readonly options = new Map<string, GhWebRequestOptions | undefined>();
  private readonly routes: Array<[RegExp, Route]> = [];

  on(call: string | RegExp, route: Route | GhWebResponse): this {
    const re = typeof call === 'string' ? new RegExp(`^${call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : call;
    this.routes.push([re, typeof route === 'function' ? route : () => route]);
    return this;
  }

  state(): TransportState {
    return { phase: this.phase, message: this.message };
  }

  async connect(): Promise<void> {
    this.calls.push('connect');
  }

  identity(): GhWebIdentity | undefined {
    return this.me;
  }

  async request(method: string, apiPath: string, options?: GhWebRequestOptions): Promise<GhWebResponse> {
    const call = `${method} ${apiUrl(apiPath).slice(API_BASE.length)}`;
    this.calls.push(call);
    this.options.set(call, options);
    for (const [re, route] of this.routes) {
      const match = re.exec(call);
      if (match) return route(match, options);
    }
    throw new Error(`unexpected call ${call}`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const res = (status: number, body?: unknown, extra: Partial<GhWebResponse> = {}): GhWebResponse => ({
  status,
  text: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
  link: null,
  retryAfter: null,
  ...extra,
});
const listPage = (tasks: TaskRecord[], next?: string) => res(200, { tasks }, { link: next ? `<${next}>; rel="next"` : null });
const LIST = (archived: boolean, chat = false) =>
  `GET tasks?creator_id=42&page=1&archived=${archived}&per_page=250${chat ? '&type=chat' : ''}`;
const CLI_SLUG = 'copilot-developer-cli';
const task = (id: string, extra: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  name: `Task ${id}`,
  state: 'idle',
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-01-03T03:04:05Z',
  agent_collaborators: [{ agent_task_id: `session-${id}`, slug: CLI_SLUG }],
  ...extra,
});
const slim = (events: unknown[], extra: Partial<SlimEventsBody> = {}) =>
  res(200, { total: events.length, count: events.length, bytes: 1_234, truncated: false, kinds: {}, events, ...extra });
const detail = (id: string, extra: Partial<TaskDetail> = {}) => res(200, { ...task(id), sessions: [], ...extra });
const pairs = (messages: TranscriptMessage[]) => messages.map((m) => [m.role, m.text]);

function provider(t: TestContext, transport: GhWebTransport, options: Partial<GhWebProviderOptions> = {}) {
  const dir = tempDir(t);
  const logs: string[] = [];
  const copilotHome = path.join(dir, 'copilot-home');
  const p = new GhWebProvider(
    { dataDir: dir, trashDir: path.join(dir, 'trash', 'ghweb'), log: (m) => logs.push(m) },
    { transport, copilotHome, ...options },
  );
  return { p, logs, copilotHome };
}

test('list walks tasks, archived tasks and chats, merges them and maps each kind', async (t) => {
  const transport = new FakeTransport()
    .on(
      LIST(false),
      listPage(
        [
          task('t1', { agent_collaborators: [{ agent_task_id: 'local-1', slug: CLI_SLUG }] }),
          task('t2', {
            name: 'Fix login',
            state: 'in_progress',
            repository: { full_name: 'octo/app' },
            agent_collaborators: [{ agent_task_id: 'a2', slug: 'copilot-developer' }],
            session_count: 2,
          }),
          task('c1', { name: 'Old name' }),
        ],
        // The API's next links name its public path; they are followed through the API base.
        'https://api.github.com/agents/tasks?cursor=p2',
      ),
    )
    .on('GET tasks?cursor=p2', listPage([task('t3', { name: '  ', agent_collaborators: [{ agent_task_id: 'file-1', slug: CLI_SLUG }] })]))
    .on(
      LIST(true),
      listPage([task('t4', { state: 'in_progress', archived_at: '2026-02-01T00:00:00Z', agent_collaborators: [{ slug: 'copilot-developer' }] })]),
    )
    .on(LIST(false, true), listPage([task('c1', { name: null })]))
    .on(LIST(true, true), listPage([task('c2', { name: 'Archived chat', archived_at: '2026-02-01T00:00:00Z' })]));
  const { p, copilotHome } = provider(t, transport);
  fs.mkdirSync(path.join(copilotHome, 'session-state', 'local-1'), { recursive: true });
  fs.writeFileSync(path.join(copilotHome, 'session-state', 'file-1'), '');
  const messages: string[] = [];
  const items = await p.list((_done, _total, message) => messages.push(message));

  assert.equal(transport.calls[0], 'connect');
  assert.deepEqual(new Set(transport.calls.slice(1)), new Set([LIST(false), LIST(true), LIST(false, true), LIST(true, true), 'GET tasks?cursor=p2']));
  assert.deepEqual(
    items.map((i) => [i.id, i.kind, i.title, i.location, i.status]),
    [
      ['t1', 'cli-task', 'Task t1', 'No repository', 'idle'],
      ['t2', 'agent-task', 'Fix login', 'octo/app', 'in progress'],
      ['c1', 'web-chat', '(untitled chat)', 'Copilot chat', 'idle'],
      ['t3', 'cli-task', '(untitled task)', 'No repository', 'idle'],
      ['t4', 'agent-task', 'Task t4', 'No repository', 'archived'],
      ['c2', 'web-chat', 'Archived chat', 'Copilot chat', 'archived'],
    ],
  );
  const byId = new Map(items.map((i) => [i.id, i]));
  const t1 = byId.get('t1')!;
  assert.deepEqual(
    [t1.source, t1.url, t1.createdAt, t1.updatedAt, t1.deleteMode],
    ['ghweb', 'https://github.com/copilot/tasks/t1', '2026-01-02T03:04:05.000Z', '2026-01-03T03:04:05.000Z', 'direct'],
  );
  assert.match(t1.note ?? '', /^github\.com copy of a GitHub Copilot app\/CLI session on this PC\. Deleting it here removes only the github\.com copy/);
  assert.deepEqual(t1.extra, {
    archived: false,
    state: 'idle',
    agentTaskId: 'local-1',
    agentSlug: CLI_SLUG,
    repo: undefined,
    chat: false,
    localSession: true,
    sessionCount: undefined,
  });
  assert.equal(byId.get('t2')!.note, 'Still running on github.com.');
  assert.deepEqual(byId.get('t2')!.extra, {
    archived: false,
    state: 'in_progress',
    agentTaskId: 'a2',
    agentSlug: 'copilot-developer',
    repo: 'octo/app',
    chat: false,
    localSession: false,
    sessionCount: 2,
  });
  // A file named like the session is not a session folder; archived tasks are not running.
  assert.equal(byId.get('t3')!.note, undefined);
  assert.equal(byId.get('t4')!.note, undefined);
  assert.equal(byId.get('t4')!.extra?.archived, true);
  assert.equal(byId.get('c1')!.extra?.chat, true);
  assert.equal(messages[0], 'Connecting to github.com');
  assert.equal(messages.at(-1), 'Loaded 2 chats and 4 tasks from github.com');
  assert.equal((await p.status()).warnings, undefined);
});

test('list reports unfinished or failing secondary lists as warnings', async (t) => {
  const transport = new FakeTransport()
    .on(LIST(false), listPage([task('t1')]))
    .on(LIST(true), listPage([task('t2')], '?cursor=same'))
    .on('GET tasks?cursor=same', listPage([task('t3')], '?cursor=same'))
    .on(LIST(false, true), listPage([task('c1')], 'https://evil.example.com/steal'))
    .on(LIST(true, true), res(500, { message: 'Server Error' }));
  const { p } = provider(t, transport);
  const items = await p.list();
  assert.deepEqual(
    items.map((i) => i.id),
    ['t1', 't2', 't3'],
  );
  assert.equal(transport.calls.filter((c) => c === 'GET tasks?cursor=same').length, 1);
  const warnings = (await p.status()).warnings ?? [];
  assert.equal(warnings.length, 3);
  assert.ok(warnings.includes('Archived tasks on github.com: the list did not finish, so some items may be missing.'));
  assert.ok(
    warnings.includes(
      'Chats on github.com could not be listed: Refusing to call a URL outside the Copilot agents API: https://evil.example.com/steal',
    ),
  );
  assert.ok(warnings.includes('Archived chats on github.com could not be listed: Could not list archived chats: github.com returned HTTP 500 (Server Error).'));
});

test('list fails when the main task list fails or the account is unknown', async (t) => {
  const others = (transport: FakeTransport) => transport.on(/^GET tasks\?/, listPage([]));
  const cases: Array<[GhWebResponse, string]> = [
    [res(401, { message: 'Bad credentials' }), 'Could not list tasks: github.com rejected the sign-in (HTTP 401). Sign in to github.com again.'],
    [res(200, '<html>'), 'Could not list tasks: github.com returned an unreadable response.'],
    [res(200, { items: [] }), 'Could not list tasks: github.com returned an unexpected response.'],
  ];
  for (const [response, message] of cases) {
    const transport = others(new FakeTransport().on(LIST(false), response));
    await assert.rejects(provider(t, transport).p.list(), { message });
  }
  const anonymous = new FakeTransport();
  anonymous.me = undefined;
  await assert.rejects(provider(t, anonymous).p.list(), { message: 'Could not tell which github.com account is signed in.' });
});

test('status reports the github.com sign-in state', async (t) => {
  const transport = new FakeTransport();
  const { p } = provider(t, transport);
  transport.message = 'Signed in to github.com as octocat';
  assert.deepEqual(await p.status(), { available: true, signedIn: true, message: 'Signed in to github.com as octocat', warnings: undefined });
  transport.phase = 'signin';
  assert.equal((await p.status()).signedIn, false);
  transport.phase = 'starting';
  assert.equal((await p.status()).signedIn, undefined);
});

test('getTranscript reads a session or agent task and asks the page to slim its history', async (t) => {
  const transport = new FakeTransport().on('GET tasks/t1', detail('t1', { name: 'Fix the login bug' })).on(
    'GET tasks/t1/events',
    slim([
      { type: 'user.message', timestamp: '2026-01-01T00:00:00.000Z', data: { content: 'Fix the login bug' } },
      { type: 'assistant.message', timestamp: '2026-01-01T00:00:05.000Z', data: { content: 'Looking', messageId: 'm1', chunkIndex: 0 } },
      { type: 'assistant.message', timestamp: '2026-01-01T00:00:06.000Z', data: { content: ' into it.', messageId: 'm1', chunkIndex: 1 } },
      { type: 'abort', timestamp: '2026-01-01T00:00:07.000Z', data: { reason: 'user' } },
    ]),
  );
  const { p } = provider(t, transport, { previewBytes: 1_000 });
  const item = conv('ghweb', 't1', { title: 'Old title' });
  const tr = await p.getTranscript(item);
  assert.deepEqual(pairs(tr.messages), [
    ['user', 'Fix the login bug'],
    ['assistant', 'Looking into it.'],
    ['status', 'Stopped: user'],
  ]);
  assert.deepEqual([tr.source, tr.id, tr.title, tr.partial, tr.note], ['ghweb', 't1', 'Fix the login bug', false, undefined]);
  assert.deepEqual((tr.raw as any).history, { total: 4, count: 4, bytes: 1_234, truncated: false, kinds: {} });
  assert.equal((tr.raw as any).task.id, 't1');
  const events = { types: TRANSCRIPT_EVENT_TYPES, dataFields: TRANSCRIPT_DATA_FIELDS };
  assert.deepEqual(transport.options.get('GET tasks/t1/events'), { timeoutMs: 120_000, events: { ...events, maxBytes: 1_000 } });
  assert.equal(transport.options.get('GET tasks/t1'), undefined);

  await p.getTranscript(item, { full: true });
  assert.deepEqual(transport.options.get('GET tasks/t1/events'), { timeoutMs: 600_000, events: { ...events, maxBytes: undefined } });
});

test('getTranscript rebuilds github.com chat replies from streamed parts', async (t) => {
  const at = (s: number) => `2026-01-01T00:00:0${s}.000Z`;
  const transport = new FakeTransport().on('GET tasks/c1', detail('c1', { name: 'Math' })).on(
    'GET tasks/c1/events',
    slim([
      { at: at(0), ahp: { type: 'chat/turnStarted', at: at(0), text: 'What is 2+2?', origin: 'user' } },
      { at: at(1), ahp: { type: 'chat/responsePart', partId: 'p1', text: '2+2' } },
      { at: at(2), ahp: { type: 'chat/delta', partId: 'p1', text: ' is 4.' } },
      { at: at(3), ahp: { type: 'chat/delta', partId: 'other', text: 'lost' } },
      { type: 'user.message', timestamp: '2026-01-01T00:00:03.500Z', data: { content: 'From the CLI' } },
      { at: at(4), ahp: { type: 'chat/turnStarted', text: 'Summarize the chat', origin: 'tool' } },
      { at: at(5), ahp: { type: 'chat/turnError', text: 'rate limited' } },
      { at: at(6), ahp: { type: 'chat/turnCancelled' } },
      { at: at(7), ahp: { type: 'chat/responsePart', partId: 'p2', text: '   ' } },
    ]),
  );
  const tr = await provider(t, transport).p.getTranscript(conv('ghweb', 'c1'));
  assert.deepEqual(pairs(tr.messages), [
    ['user', 'What is 2+2?'],
    ['assistant', '2+2 is 4.'],
    ['user', 'From the CLI'],
    ['system', 'Summarize the chat'],
    ['status', 'Error: rate limited'],
    ['status', 'Stopped'],
  ]);
  assert.equal(tr.messages[1].at, at(1));
});

test('getTranscript flags a cut-off or incomplete history', async (t) => {
  const events = [{ type: 'user.message', timestamp: '2026-01-01T00:00:00.000Z', data: { content: 'hi' } }];
  const cut = new FakeTransport().on('GET tasks/t1', detail('t1')).on('GET tasks/t1/events', slim(events, { total: undefined, truncated: true }));
  const long = await provider(t, cut).p.getTranscript(conv('ghweb', 't1'));
  assert.deepEqual([long.partial, long.note], [true, 'Long conversation: showing the beginning. Load the full conversation to read all of it.']);

  const short = new FakeTransport().on('GET tasks/t1', detail('t1')).on('GET tasks/t1/events', slim(events, { total: 10 }));
  const missing = await provider(t, short).p.getTranscript(conv('ghweb', 't1'));
  assert.deepEqual([missing.partial, missing.note], [true, 'github.com returned 1 of 10 events, so the end may be missing.']);
});

test('getTranscript falls back to a task summary when the history has no readable messages', async (t) => {
  const sessions = [
    {
      prompt: 'Add unit tests',
      state: 'completed',
      head_ref: 'copilot/add-tests',
      resource_number: 12,
      premium_requests: 1,
      created_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
    },
    { event_content: 'Also fix lint', state: 'failed', premium_requests: 2.5 },
  ];
  const empty = new FakeTransport().on('GET tasks/t1', detail('t1', { sessions })).on('GET tasks/t1/events', slim([]));
  const first = provider(t, empty);
  const tr = await first.p.getTranscript(conv('ghweb', 't1'));
  assert.deepEqual(tr.messages, [
    { role: 'user', text: 'Add unit tests', at: '2026-01-01T00:00:00.000Z' },
    { role: 'status', text: 'Session: completed · branch copilot/add-tests · #12 · 1 premium request', at: '2026-01-01T01:00:00.000Z' },
    { role: 'user', text: 'Also fix lint', at: undefined },
    { role: 'status', text: 'Session: failed · 2.5 premium requests', at: undefined },
  ]);
  assert.equal(tr.note, 'github.com has no messages for this conversation, so this is a summary of the task.');
  assert.deepEqual(first.logs, []);

  // Logs with only housekeeping events (common for github.com copies of app/CLI sessions).
  const housekeeping = {
    'session.requested': 1,
    'session.start': 1,
    'session.mcp_servers_loaded': 1,
    'session.canvas.registry_changed': 1,
    'permission.requested': 2,
    'commands.changed': 1,
    'capabilities.changed': 1,
  };
  const quiet = new FakeTransport()
    .on('GET tasks/t3', detail('t3', { sessions: [{ state: 'completed' }] }))
    .on('GET tasks/t3/events', slim([], { count: 8, total: 8, kinds: housekeeping }));
  const third = provider(t, quiet);
  const tr3 = await third.p.getTranscript(conv('ghweb', 't3'));
  assert.deepEqual(pairs(tr3.messages), [['status', 'Session: completed']]);
  assert.equal(tr3.note, 'github.com has no messages for this conversation, so this is a summary of the task.');
  assert.deepEqual(third.logs, []);

  // The summary itself says when there is nothing to summarize; an incomplete log keeps only its own note.
  const none = new FakeTransport().on('GET tasks/t4', detail('t4', { state: 'failed' })).on('GET tasks/t4/events', slim([]));
  const tr4 = await provider(t, none).p.getTranscript(conv('ghweb', 't4'));
  assert.deepEqual([pairs(tr4.messages), tr4.note], [[['status', 'No conversation history found on github.com (task failed).']], undefined]);
  const cut = new FakeTransport()
    .on('GET tasks/t5', detail('t5', { sessions: [{ state: 'completed' }] }))
    .on('GET tasks/t5/events', slim([], { count: 2, total: 9, kinds: { 'session.start': 2 } }));
  const tr5 = await provider(t, cut).p.getTranscript(conv('ghweb', 't5'));
  assert.deepEqual([tr5.partial, tr5.note], [true, 'github.com returned 2 of 9 events, so the end may be missing.']);

  const unreadable = new FakeTransport()
    .on('GET tasks/t2', detail('t2', { state: 'cancelled' }))
    .on('GET tasks/t2/events', slim([], { count: 3, total: 3, kinds: { 'weird.event': 3 } }));
  const second = provider(t, unreadable);
  const tr2 = await second.p.getTranscript(conv('ghweb', 't2'));
  assert.deepEqual(tr2.messages, [{ role: 'status', text: 'No conversation history found on github.com (task cancelled).' }]);
  assert.equal(tr2.note, "The organizer could not read this conversation's history, so this is a summary of the task.");
  assert.deepEqual(second.logs, ['no readable messages in t2; event kinds {"weird.event":3}']);
});

test('getTranscript fails clearly when the item is gone or github.com reports an error', async (t) => {
  const gone = new FakeTransport().on(/^GET tasks\/t1/, res(404, { message: 'Not Found' }));
  await assert.rejects(provider(t, gone).p.getTranscript(conv('ghweb', 't1')), {
    message: 'This item no longer exists on github.com. Refresh the list.',
  });
  const cases: Array<[GhWebResponse, string]> = [
    [res(500, { message: 'Internal error' }), 'Could not read the conversation: github.com returned HTTP 500 (Internal error).'],
    [res(401, { message: 'Bad credentials' }), 'Could not read the conversation: github.com rejected the sign-in (HTTP 401). Sign in to github.com again.'],
  ];
  for (const [events, message] of cases) {
    const transport = new FakeTransport().on('GET tasks/t1', detail('t1')).on('GET tasks/t1/events', events);
    await assert.rejects(provider(t, transport).p.getTranscript(conv('ghweb', 't1')), { message });
  }
});

test('getTranscript shows the task summary when github.com sends no usable history', async (t) => {
  const cases: Array<[GhWebResponse, string]> = [
    [res(404, { message: 'Not Found' }), 'unexpected history response for t1: HTTP 404'],
    [res(200, '<html>Unicorn!</html>'), 'unexpected history response for t1: HTTP 200 not JSON (21 characters)'],
    [res(200, { message: 'Moved', events: 3 }), 'unexpected history response for t1: HTTP 200 {message: string, events: number}'],
  ];
  for (const [events, logLine] of cases) {
    const transport = new FakeTransport()
      .on('GET tasks/t1', detail('t1', { sessions: [{ prompt: 'Add unit tests', state: 'failed' }] }))
      .on('GET tasks/t1/events', events);
    const { p, logs } = provider(t, transport);
    const tr = await p.getTranscript(conv('ghweb', 't1'));
    assert.deepEqual(pairs(tr.messages), [
      ['user', 'Add unit tests'],
      ['status', 'Session: failed'],
    ]);
    assert.deepEqual([tr.partial, tr.note], [false, "The organizer could not read this conversation's history, so this is a summary of the task."]);
    assert.equal((tr.raw as any).history, undefined);
    assert.deepEqual(logs, [logLine]);
  }
});

test('getTranscript retries throttled and unavailable responses', async (t) => {
  let n = 0;
  const transport = new FakeTransport()
    .on('GET tasks/t1', () => (++n === 1 ? res(502, 'Bad Gateway', { retryAfter: '0' }) : detail('t1')))
    .on('GET tasks/t1/events', slim([{ type: 'user.message', data: { content: 'hi' } }]));
  const tr = await provider(t, transport).p.getTranscript(conv('ghweb', 't1'));
  assert.deepEqual(pairs(tr.messages), [['user', 'hi']]);
  assert.equal(transport.calls.filter((c) => c === 'GET tasks/t1').length, 2);
});

test('deleteItems deletes each item, treats 404 as already deleted and retries throttling', async (t) => {
  let throttled = 0;
  const transport = new FakeTransport()
    .on('DELETE tasks/ok', res(204))
    .on('DELETE tasks/gone', res(404, { message: 'Not Found' }))
    .on('DELETE tasks/broken', res(500, { message: 'boom' }))
    .on('DELETE tasks/denied', res(403, 'forbidden'))
    .on('DELETE tasks/busy', () => (throttled++ === 0 ? res(429, '', { retryAfter: '0' }) : res(204)))
    .on('DELETE tasks/stuck', res(429, '', { retryAfter: '0' }))
    .on('DELETE tasks/a%2Fb', res(204));
  const { p } = provider(t, transport);
  const done: number[] = [];
  const ids = ['ok', 'gone', 'broken', 'denied', 'busy', 'stuck', 'a/b'];
  const results = await p.deleteItems(
    ids.map((id) => conv('ghweb', id)),
    (n) => done.push(n),
  );
  assert.deepEqual(results, [
    { id: 'ok', ok: true },
    { id: 'gone', ok: true, detail: 'Already deleted on github.com' },
    { id: 'broken', ok: false, error: 'Could not delete: github.com returned HTTP 500 (boom).' },
    { id: 'denied', ok: false, error: 'Could not delete: github.com returned HTTP 403.' },
    { id: 'busy', ok: true },
    { id: 'stuck', ok: false, error: 'Could not delete: github.com is limiting requests (HTTP 429). Try again in a few minutes.' },
    { id: 'a/b', ok: true },
  ]);
  assert.equal(transport.calls.filter((c) => c === 'DELETE tasks/busy').length, 2);
  assert.equal(transport.calls.filter((c) => c === 'DELETE tasks/stuck').length, 4);
  assert.deepEqual(
    done.sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test('deleteItems runs at most `concurrency` deletes at once', async (t) => {
  let active = 0;
  let maxActive = 0;
  const transport = new FakeTransport().on(/^DELETE tasks\//, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(5);
    active--;
    return res(204);
  });
  const { p } = provider(t, transport, { concurrency: 2 });
  const results = await p.deleteItems(Array.from({ length: 7 }, (_, i) => conv('ghweb', `t${i}`)));
  assert.equal(results.every((r) => r.ok), true);
  assert.equal(maxActive, 2);
});

test('close closes the transport', async (t) => {
  const transport = new FakeTransport();
  await provider(t, transport).p.close();
  assert.equal(transport.closed, true);
});

// ---------- GhWebPageTransport ----------

/** A github.com page: evaluate() runs pageRequest against a fake page environment. */
class FakePage {
  readonly env: any;
  location = 'https://github.com/copilot';
  who = { login: 'octocat', id: '42', nonce: true, hasLoginMeta: true };
  readonly visits: string[] = [];
  readonly failNext: Error[] = [];
  reloads = 0;

  constructor(env: any) {
    this.env = env;
  }

  url(): string {
    return this.location;
  }

  isClosed(): boolean {
    return false;
  }

  async goto(url: string): Promise<void> {
    this.visits.push(url);
    this.location = url;
  }

  async reload(): Promise<void> {
    this.reloads++;
  }

  async evaluate(fn: (...args: any[]) => unknown, arg?: unknown): Promise<unknown> {
    if (fn.name === 'pageIdentity') return { ...this.who };
    const failure = this.failNext.shift();
    if (failure) throw failure;
    return fn(arg, this.env);
  }
}

class FakeSession {
  readonly calls: string[] = [];
  readonly tab: FakePage;
  isOpen = true;
  generation = 1;
  isHeadless = true;
  mode = 'auto';
  onFocus: (() => void) | undefined;

  constructor(tab: FakePage) {
    this.tab = tab;
  }

  async page(): Promise<FakePage> {
    return this.tab;
  }

  async context(options: { visible?: boolean } = {}): Promise<void> {
    this.calls.push(`context visible=${options.visible === true}`);
    this.isHeadless = !options.visible;
  }

  async focus(name: string): Promise<void> {
    this.calls.push(`focus ${name}`);
    this.onFocus?.();
  }
}

function pageTransport(tab: FakePage, mode = 'auto') {
  const session = new FakeSession(tab);
  session.mode = mode;
  const logs: string[] = [];
  const transport = new GhWebPageTransport({
    session: session as unknown as BrowserSession,
    log: (m) => logs.push(m),
    headlessGraceMs: 0,
    signInTimeoutMs: 10_000,
  });
  return { transport, session, logs };
}

test('page transport signs in on github.com and calls the agents API from the page', async () => {
  const tab = new FakePage(pageEnv(() => json(200, { tasks: [] })));
  const { transport, logs } = pageTransport(tab);
  await transport.connect();
  assert.deepEqual(transport.identity(), { login: 'octocat', id: '42' });
  assert.deepEqual(transport.state(), { phase: 'ready', message: 'Signed in to github.com as octocat' });
  assert.ok(logs.includes('signed in as octocat'));

  assert.deepEqual(await transport.request('GET', 'tasks?creator_id=42'), { status: 200, text: '{"tasks":[]}', link: null, retryAfter: null });
  const [call] = apiCalls(tab.env);
  assert.equal(call.url, `${API_BASE}tasks?creator_id=42`);
  assert.equal(call.init.headers['copilot-integration-id'], 'copilot-web');
  assert.equal(call.init.headers['x-client-application'], 'copilot-cloud-web');
  assert.equal(tokenCalls(tab.env).length, 1);
  await assert.rejects(transport.request('GET', 'https://evil.example.com/'), /Refusing to call a URL outside the Copilot agents API/);
  assert.equal(apiCalls(tab.env).length, 1);
});

test('page transport reloads github.com once when the page cannot get a token', async () => {
  const env = pageEnv(
    () => json(200, { ok: true }),
    (n) => (n === 1 ? new Response('', { status: 401 }) : json(200, { token: `tok${n}`, expiration: Math.floor(Date.now() / 1000) + 3600 })),
  );
  const tab = new FakePage(env);
  const { transport, logs } = pageTransport(tab);
  assert.equal((await transport.request('GET', 'tasks/t1')).status, 200);
  assert.ok(logs.includes('token request returned HTTP 401; reloading github.com'));
  assert.equal(tab.reloads, 2);

  const denied = new FakePage(pageEnv(() => json(200, {}), () => new Response('', { status: 404 })));
  await assert.rejects(pageTransport(denied).transport.request('GET', 'tasks/t1'), {
    message: 'github.com did not issue a Copilot API token (HTTP 404). Sign in again, and check that Copilot is enabled for your account.',
  });
});

test('page transport reconnects once when the page call fails', async () => {
  const tab = new FakePage(pageEnv(() => json(200, { ok: true })));
  tab.failNext.push(new Error('Execution context was destroyed'));
  const { transport, logs } = pageTransport(tab);
  assert.equal((await transport.request('GET', 'tasks/t1')).status, 200);
  assert.ok(logs.some((l) => l.startsWith('page call failed (Error: Execution context was destroyed); reconnecting')));

  tab.failNext.push(new Error('Target closed'), new Error('Target closed'));
  await assert.rejects(transport.request('GET', 'tasks/t1'), /Target closed/);
});

test('page transport asks for an interactive sign-in when only headless is allowed', async () => {
  const tab = new FakePage(pageEnv(() => json(200, {})));
  tab.who = { login: '', id: '', nonce: true, hasLoginMeta: true };
  const { transport, session } = pageTransport(tab, 'headless');
  await assert.rejects(transport.connect(), (e: unknown) => e instanceof SignInRequiredError && /needs an interactive sign-in/.test(e.message));
  assert.equal(transport.state().phase, 'signin');
  assert.deepEqual(session.calls, []);
});

test('page transport opens a visible window for sign-in and continues once signed in', async () => {
  const tab = new FakePage(pageEnv(() => json(200, {})));
  tab.who = { login: '', id: '', nonce: true, hasLoginMeta: true };
  const { transport, session } = pageTransport(tab);
  session.onFocus = () => {
    tab.who = { login: 'octocat', id: '42', nonce: true, hasLoginMeta: true };
    tab.location = 'https://github.com/copilot';
  };
  const statuses: string[] = [];
  await transport.connect((m) => statuses.push(m));
  assert.deepEqual(session.calls, ['context visible=true', 'focus ghweb']);
  assert.ok(tab.visits.includes(LOGIN_URL));
  assert.deepEqual(statuses, ['Sign-in needed: opening a visible Edge window for github.com', 'Waiting for you to sign in to github.com in the Edge window']);
  assert.deepEqual(transport.state(), { phase: 'ready', message: 'Signed in to github.com as octocat' });
});

test('a github.com chat is slimmed in the page and read back as a transcript', async (t) => {
  const raw = [
    ahpEvent('chat/turnStarted', { startedAt: '2026-01-01T00:00:00.000Z', message: { text: 'Hello?', origin: { kind: 'user' } } }, '2026-01-01T00:00:00.000Z'),
    ahpEvent('chat/responsePart', { part: { kind: 'markdown', id: 'p1', content: 'Hi' } }, '2026-01-01T00:00:01.000Z'),
    ahpEvent('chat/responsePart', { part: { kind: 'progress', id: 'p9', content: 'Thinking' } }, '2026-01-01T00:00:01.500Z'),
    ahpEvent('chat/delta', { partId: 'p1', content: ' there!' }, '2026-01-01T00:00:02.000Z'),
  ];
  const env = pageEnv((url) =>
    url.endsWith('/events') ? json(200, { events: raw, total: raw.length }) : json(200, { id: 'c1', name: 'Greeting', sessions: [] }),
  );
  const { transport } = pageTransport(new FakePage(env));
  const { p } = provider(t, transport);
  const tr = await p.getTranscript(conv('ghweb', 'c1'));
  assert.equal(tr.title, 'Greeting');
  assert.deepEqual(pairs(tr.messages), [
    ['user', 'Hello?'],
    ['assistant', 'Hi there!'],
  ]);
  assert.equal(tr.partial, false);
  assert.deepEqual((tr.raw as any).history.kinds, { 'ahp:chat/turnStarted': 1, 'ahp:chat/responsePart': 2, 'ahp:chat/delta': 1 });
});
