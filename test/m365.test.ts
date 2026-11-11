import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { M365Client, parseNdjson, syncStateStart, type TaskEvent } from '../src/providers/m365/client.ts';
import {
  M365Provider,
  adaptiveCardText,
  chatLocation,
  chatMessage,
  chatMessages,
  chatPreview,
  chatToConversation,
  transcriptFromTaskEvents,
} from '../src/providers/m365/index.ts';
import type { AetherResult, M365Transport, TransportState } from '../src/providers/m365/transport.ts';
import type { Conversation, TranscriptMessage } from '../src/core/types.ts';
import { HttpError } from '../src/lib/async.ts';
import { conv, tempDir } from './support/fakes.ts';

type Handler = (body: any, match: RegExpExecArray) => unknown;

/** Scripted stand-in for the browser-backed transport; records every call. */
class FakeTransport implements M365Transport {
  phase: TransportState['phase'] = 'ready';
  readonly calls: string[] = [];
  readonly sent: Array<{ call: string; body: unknown }> = [];
  readonly sfn: Record<string, (data: Record<string, any>) => unknown> = {};
  readonly pages: Record<string, { status: number; text: string }> = {};
  private readonly routes: Array<[RegExp, Handler]> = [];

  on(call: string | RegExp, handler: Handler): this {
    const re = typeof call === 'string' ? new RegExp(`^${call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : call;
    this.routes.push([re, handler]);
    return this;
  }

  state(): TransportState {
    return { phase: this.phase };
  }

  async connect(): Promise<void> {
    this.calls.push('connect');
  }

  async serverFn(data: Record<string, unknown>): Promise<any> {
    const action = String(data.action);
    this.calls.push(`sfn ${action}`);
    const handler = this.sfn[action];
    if (!handler) throw new Error(`unexpected server function ${action}`);
    return handler(data as Record<string, any>);
  }

  async pageGet(pagePath: string): Promise<{ status: number; text: string }> {
    this.calls.push(`PAGE ${pagePath}`);
    return this.pages[pagePath] ?? { status: 404, text: 'not found' };
  }

  async aether<T = any>(method: string, apiPath: string, body?: unknown): Promise<AetherResult<T>> {
    const call = `${method} ${apiPath}`;
    this.calls.push(call);
    this.sent.push({ call, body });
    for (const [re, handler] of this.routes) {
      const match = re.exec(call);
      if (match) return { status: 200, data: (await handler(body, match)) as T };
    }
    throw new Error(`unexpected call ${call}`);
  }

  identity() {
    return { oid: 'oid', tid: 'tid' };
  }
}

function provider(t: TestContext, transport: FakeTransport) {
  const dir = tempDir(t);
  const logs: string[] = [];
  const p = new M365Provider({ dataDir: dir, trashDir: path.join(dir, 'trash', 'm365'), log: (m) => logs.push(m) }, { transport, concurrency: 1 });
  return { p, logs };
}

const nav = (chats: unknown[], syncState?: string) => ({ result: { store: { conversationPageHistoryList: { chats, syncState } } } });
const historyPage = (chats: unknown[], syncState?: string) => ({ result: { store: { chatLandingPageHistoryList: { chats, syncState } } } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const syncFrom = (start: string) => b64({ IC3SyncState: b64({ deliveredSegments: [{ start }] }) });
const chat = (id: string, updated: number, extra: Record<string, unknown> = {}) => ({
  conversationId: id,
  chatName: `Chat ${id}`,
  threadId: `19:${id}@thread.v2`,
  updateTimeUtc: updated,
  ...extra,
});
const ndjson = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');
const pairs = (messages: TranscriptMessage[]) => messages.map((m) => [m.role, m.text]);
const deleted = (statusCode: number, ids?: string[]) => ({
  result: { store: { lastConversationActionMetrics: { statusCode } }, result: ids ? { conversationIdsDeleted: ids } : {} },
});
const TASKS_PAGE = 'GET /v1/tasks/live?pageSize=150&includeCached=true&sessionType=interactive';

test('chatLocation names where a chat lives', () => {
  const cases: Array<[string | undefined, string]> = [
    ['/agents/researcher/abc', 'Researcher'],
    ['/agents/Analyst/abc', 'Analyst'],
    ['/chat/agent/Notebook/123', 'Notebook'],
    ['/chat/agents/T_123', 'Agent'],
    ['/agent/xyz', 'Agent'],
    ['/chat/conversation/abc', 'Chat'],
    [undefined, 'Chat'],
  ];
  for (const [p, expected] of cases) assert.equal(chatLocation(p), expected, String(p));
});

test('syncStateStart and parseNdjson tolerate junk', () => {
  assert.equal(syncStateStart(syncFrom('2025-06-01T00:00:00Z')), '2025-06-01T00:00:00Z');
  assert.equal(syncStateStart('not a sync state'), undefined);
  assert.equal(syncStateStart(undefined), undefined);
  assert.deepEqual(parseNdjson('{"a":1}\n\n  \r\n{"b":2}\n{"partial":'), [{ a: 1 }, { b: 2 }]);
});

test('listChats pages the history, merges duplicates and stops after two empty pages', async () => {
  const t = new FakeTransport();
  t.sfn.RefreshNavPane = () => nav([chat('A', 300), chat('B', 200)], 'S1');
  const pages: Record<string, unknown> = {
    S1: historyPage([chat('c', 100), chat('a', 300, { chatName: 'A renamed' })], 'S2'),
    S2: historyPage([chat('B', 200)], 'S3'),
    S3: historyPage([], 'S4'),
    S4: historyPage([chat('never', 1)]),
  };
  t.sfn.GetConversationPageHistoryList = (d) => pages[d.syncState];
  const counts: number[] = [];
  const chats = await new M365Client(t).listChats((n) => counts.push(n));
  assert.deepEqual(
    chats.map((c) => [c.conversationId, c.chatName]),
    [
      ['A', 'A renamed'],
      ['B', 'Chat B'],
      ['c', 'Chat c'],
    ],
  );
  assert.deepEqual(counts, [2, 3, 3, 3]);
  assert.equal(t.calls.filter((c) => c === 'sfn GetConversationPageHistoryList').length, 3);
});

test('listChats stops at the start of history, on a repeated sync state, or without one', async () => {
  const t = new FakeTransport();
  t.sfn.RefreshNavPane = () => nav([chat('a', 3)], 'S1');
  t.sfn.GetConversationPageHistoryList = (d) =>
    d.syncState === 'S1' ? historyPage([chat('b', 2)], syncFrom('1970-01-01T00:00:00Z')) : historyPage([], syncFrom('1970-01-01T00:00:00.000Z'));
  assert.equal((await new M365Client(t).listChats()).length, 2);
  assert.equal(t.calls.filter((c) => c === 'sfn GetConversationPageHistoryList').length, 2);

  const repeat = new FakeTransport();
  repeat.sfn.RefreshNavPane = () => nav([chat('a', 3)], 'S1');
  repeat.sfn.GetConversationPageHistoryList = () => historyPage([chat('b', 2)], 'S1');
  assert.equal((await new M365Client(repeat).listChats()).length, 2);
  assert.equal(repeat.calls.length, 2);

  const single = new FakeTransport();
  single.sfn.RefreshNavPane = () => nav([chat('a', 3)]);
  assert.equal((await new M365Client(single).listChats()).length, 1);

  const broken = new FakeTransport();
  broken.sfn.RefreshNavPane = () => ({ result: {} });
  await assert.rejects(new M365Client(broken).listChats(), /RefreshNavPane/);
});

test('deleteChat requires the service to accept and confirm the deletion', async () => {
  const t = new FakeTransport();
  const responses: Record<string, unknown> = {
    'AB-CD': deleted(200, ['ab-cd']),
    quiet: deleted(200),
    rejected: deleted(500),
    mismatch: deleted(200, ['someone-else']),
  };
  t.sfn.DeleteConversation = (d) => responses[d.conversationId];
  const client = new M365Client(t);
  await client.deleteChat('AB-CD');
  await client.deleteChat('quiet');
  await assert.rejects(client.deleteChat('rejected'), /rejected \(status 500\)/);
  await assert.rejects(client.deleteChat('mismatch'), /did not confirm/);
});

test('chat transcripts page backwards, fall back to the chat path and flag partial reads', async (t) => {
  const tr = new FakeTransport();
  tr.pages['/chat/conversation/AAA?direction=Backward'] = {
    status: 200,
    text: ndjson(
      {
        chatName: 'Budget',
        messages: [
          { messageId: 'm3', author: 'bot', text: 'Answer', createdAt: '2026-01-01T00:03:00Z' },
          { messageId: 'm4', author: 'bot', text: '  ', createdAt: '2026-01-01T00:04:00Z' },
        ],
        syncState: 'P2',
      },
      { isLastPage: false },
    ),
  };
  tr.pages['/chat/conversation/AAA?direction=Backward&syncState=P2'] = {
    status: 200,
    text: ndjson(
      {
        messages: [
          { messageId: 'm1', author: 'user', text: 'Question', createdAt: '2026-01-01T00:01:00Z' },
          { messageId: 'm2', author: 'bot', text: 'Working...', messageType: 'Progress', createdAt: '2026-01-01T00:02:00Z' },
        ],
      },
      { isLastPage: true },
    ),
  };
  tr.pages['/agents/researcher/BBB?direction=Backward'] = {
    status: 200,
    text: ndjson({ messages: [{ messageId: 'r1', author: 'user', text: 'Research this' }] }),
  };
  const looping = ndjson({ messages: [{ messageId: 'x1', author: 'user', text: 'Hi' }], syncState: 'Q2' }, { isLastPage: false });
  tr.pages['/chat/conversation/CCC?direction=Backward'] = { status: 200, text: looping };
  tr.pages['/chat/conversation/CCC?direction=Backward&syncState=Q2'] = { status: 200, text: looping };

  const { p } = provider(t, tr);
  const full = await p.getTranscript(conv('m365', 'AAA', { title: 'Old title', extra: { path: '/chat/conversation/AAA' } }));
  assert.equal(full.title, 'Budget');
  assert.deepEqual(pairs(full.messages), [
    ['user', 'Question'],
    ['status', 'Working...'],
    ['assistant', 'Answer'],
  ]);
  assert.equal(full.partial, false);
  assert.equal(full.messages[0].at, '2026-01-01T00:01:00.000Z');

  const agent = await p.getTranscript(conv('m365', 'BBB', { extra: { path: '/agents/researcher/BBB' } }));
  assert.deepEqual(pairs(agent.messages), [['user', 'Research this']]);
  assert.equal(agent.title, 'Chat BBB');
  assert.ok(tr.calls.includes('PAGE /chat/conversation/BBB?direction=Backward'));

  const partial = await p.getTranscript(conv('m365', 'CCC'));
  assert.equal(partial.partial, true);
  assert.match(partial.note ?? '', /most recent part/);

  await assert.rejects(p.getTranscript(conv('m365', 'DDD')), /Could not read the chat \(HTTP 404\)/);
});

test('chat transcripts read every message line of a response, recover card-only replies and map message types', async (t) => {
  const tr = new FakeTransport();
  const card = (...body: unknown[]) => [{ type: 'AdaptiveCard', version: '1.0', body }];
  const at = (minute: number) => `2026-01-01T00:0${minute}:00Z`;
  tr.pages['/chat/conversation/EEE?direction=Backward'] = {
    status: 200,
    text: ndjson(
      {
        chatName: 'Deals',
        syncState: 'S1',
        messages: [
          { messageId: 'e5', author: 'bot', messageType: 'Internal', text: '{"referenceToIndex":{}}', createdAt: at(5) },
          {
            messageId: 'e6',
            author: 'bot',
            createdAt: at(6),
            adaptiveCards: card({ type: 'TextBlock', text: 'Card answer' }, { type: 'FactSet', facts: [{ title: 'Price', value: '$27' }] }),
          },
          { messageId: 'e7', author: 'bot', messageType: 'EndOfRequest', createdAt: at(7) },
        ],
      },
      {
        messages: [
          { messageId: 'e1', author: 'BotOnBehalfOfUser', text: 'Scheduled prompt', createdAt: at(1) },
          { messageId: 'e2', author: 'system', messageType: 'AttachmentAction', text: '[deck.pptx](https://example.com/deck)', createdAt: at(2) },
        ],
      },
      {
        messages: [
          { messageId: 'e3', author: 'bot', messageType: 'GeneratedCode', text: '```python\nprint(1)\n```', createdAt: at(3) },
          { messageId: 'e4', author: 'bot', text: 'Text wins', adaptiveCards: card({ type: 'TextBlock', text: 'Card copy' }), createdAt: at(4) },
        ],
      },
      { isLastPage: true },
    ),
  };
  const { p } = provider(t, tr);
  const tx = await p.getTranscript(conv('m365', 'EEE'));
  assert.equal(tx.title, 'Deals');
  assert.deepEqual(pairs(tx.messages), [
    ['user', 'Scheduled prompt'],
    ['system', 'Attached: [deck.pptx](https://example.com/deck)'],
    ['tool', '```python\nprint(1)\n```'],
    ['assistant', 'Text wins'],
    ['assistant', 'Card answer\n\nPrice: $27'],
  ]);
  assert.equal(tx.partial, false);
  assert.equal(tr.calls.filter((c) => c.startsWith('PAGE /chat/conversation/EEE')).length, 1);
});

test('adaptiveCardText reads nested text blocks, rich text and facts in reading order', () => {
  const cards = [
    {
      type: 'AdaptiveCard',
      body: [
        { type: 'Container', items: [{ type: 'TextBlock', text: ' Title ' }, { type: 'TextBlock', text: '  ' }] },
        { type: 'ColumnSet', columns: [{ type: 'Column', items: [{ type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: 'Bold' }, ' tail'] }] }] },
        { type: 'Input.ChoiceSet', choices: [{ title: 'Yes', value: 'y' }] },
        { type: 'FactSet', facts: [{ title: 'Owner', value: 'Brian' }, { title: 'Empty' }] },
        { type: 'ActionSet', actions: [{ type: 'Action.ShowCard', title: 'More', card: { type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: 'Detail' }] } }] },
      ],
    },
  ];
  assert.deepEqual(adaptiveCardText(cards), ['Title', 'Bold tail', 'Owner: Brian\nEmpty', 'Detail']);
  assert.deepEqual(adaptiveCardText(undefined), []);
  assert.equal(chatMessage({ author: 'bot', adaptiveCards: [{ type: 'AdaptiveCard', body: [] }] }), undefined);
});

test('chat messages from file-building agents become readable status, tool and reply entries', () => {
  const show = (m: Record<string, unknown>) => {
    const r = chatMessage({ author: 'bot', createdAt: '2026-01-01T00:00:00Z', ...m });
    return r && [r.role, r.text];
  };
  const json = (o: unknown) => JSON.stringify(o);
  assert.equal(show({ contentOrigin: 'DeepLeo', text: '<m-workflow-claude-code-execution-card></m-workflow-claude-code-execution-card>' }), undefined);
  assert.deepEqual(show({ contentOrigin: 'ChainOfThoughtContentOrigin', text: 'headerText: Creating the deck\nsubText: Twelve slides.' }), [
    'status',
    'Creating the deck\nTwelve slides.',
  ]);
  assert.deepEqual(show({ contentOrigin: 'SlideHTMLGenerationContentOrigin', text: json({ fileName: '01.html', html: '<!DOCTYPE html>…' }) }), ['tool', 'Generated 01.html']);
  assert.deepEqual(
    show({ adaptiveCards: [{ type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: json({ fileName: 'resultMessage.txt', configurationJSON: 'Two questions first.' }) }] }] }),
    ['assistant', 'Two questions first.'],
  );
  assert.deepEqual(show({ text: json({ fileType: 'docx', fileName: 'plan.docx', shareableLink: 'https://example.com/plan' }) }), ['tool', 'Created plan.docx\nhttps://example.com/plan']);
  assert.deepEqual(show({ messageType: 'Progress', text: json({ stdIn: 'ls', stdOut: 'a.txt', callId: 'c1' }) }), ['tool', '$ ls\na.txt']);
  assert.deepEqual(
    show({ messageType: 'Progress', text: json([{ content: 'Plan', status: 'Completed' }, { content: 'Write', status: 'InProgress' }]) }),
    ['status', '[x] Plan\n[ ] Write'],
  );
  assert.deepEqual(show({ text: json({ results: [] }) }), ['tool', '{"results":[]}']);
  assert.deepEqual(show({ author: 'tool', messageType: 'InternalContentDescription', text: 'An image was generated.' }), ['tool', 'An image was generated.']);
  assert.deepEqual(show({ text: '{not json' }), ['assistant', '{not json']);
  assert.deepEqual(show({ author: 'user', text: json({ fileName: 'mine.html' }) }), ['user', '{"fileName":"mine.html"}']);
});

test('cumulative agent progress collapses to its last snapshot, without the step labels', () => {
  const card = (text: string) => ({
    author: 'bot',
    contentOrigin: 'ChainOfThoughtContentOrigin',
    adaptiveCards: [{ type: 'AdaptiveCard', body: [{ type: 'TextBlock', text }] }],
  });
  const first = 'headerText: Checking access\nsubText: Looking for the file.\n';
  const messages = chatMessages([
    { author: 'user', text: 'Convert my PDF' },
    card(first),
    card(`${first}headerText: Reading the file\nsubText: Found it.\ninterstitialText: Searching the web for: SOA\n`),
    { author: 'bot', text: 'Done.' },
    card('headerText: Adding slide 1'),
    card('headerText: Adding slide 10'),
  ]);
  assert.deepEqual(
    messages.map((m) => [m.role, m.text]),
    [
      ['user', 'Convert my PDF'],
      ['status', 'Checking access\nLooking for the file.\n\nReading the file\nFound it.\nSearching the web for: SOA'],
      ['assistant', 'Done.'],
      ['status', 'Adding slide 1'],
      ['status', 'Adding slide 10'],
    ],
  );
});

test('chat list previews describe agent payloads, even when cut off part-way', () => {
  const doc = 'https://contoso.sharepoint.com/_layouts/15/Doc.aspx?sourcedoc=%7B06C6%7D';
  assert.equal(chatPreview(`{"shareableLink":"${doc}&file=Design%20Pattern%20Scen`), 'Created Design Pattern Scen…');
  assert.equal(chatPreview(`{"shareableLink":"${doc}&file=Call%20to%20Action%2`), 'Created Call to Action…');
  assert.equal(chatPreview(`{"shareableLink":"${doc}&file=Plan.docx&action=edit","fileName":"Pl`), 'Created Plan.docx');
  assert.equal(chatPreview('{"fileType":"docx","fileName":"marathon_plan.docx","fileId":"01PY'), 'Created marathon_plan.docx');
  assert.equal(chatPreview('{"fileName":"09.html","html":"<!DOCTYPE html><html lang=\\"en\\"><he'), 'Generated 09.html');
  const reply = JSON.stringify({ fileName: 'resultMessage.txt', configurationJSON: 'Can\'t see the "PDF" yet.\nPlease upload it again.' });
  assert.equal(chatPreview(reply.slice(0, reply.indexOf('upload') + 3)), 'Can\'t see the "PDF" yet. Please upl');
  assert.equal(chatPreview('{"fileName":"resultMessage.txt","configurationJSON":"Caf\\u00'), 'Caf');
  assert.equal(
    chatPreview('headerText: Verifying access\nsubText: Checking your files.\nheaderText: Locating the doc\nsubText: The do'),
    'Verifying access — Checking your files. Locating the doc — The do',
  );
  assert.equal(
    chatPreview('<em class="x" data-lexical-text="true">draw a cat &amp; a dog:  </em><strong data-lexical-text="true"> STYLE: </strong><em class="x'),
    'draw a cat & a dog: STYLE:',
  );
  for (const same of ['{"orientation":"landscape"}', 'Use <b> for bold', '[Download the file](https://example.com/f)', 'Plain answer']) {
    assert.equal(chatPreview(same), same);
  }
  assert.equal(chatPreview('   '), undefined);
  assert.equal(chatPreview(undefined), undefined);
  assert.equal(chatToConversation({ conversationId: 'c1', preview: '{"fileName":"01.html","html":"<!DOC' }, undefined, []).preview, 'Generated 01.html');
});

test('agent disclaimer tags are dropped from replies and previews, keeping the disclaimer', () => {
  const reply = 'Sorry, I can only help with Connect.\n\n---\n<m-disclaimer>\nNOTE: This assistant is in preview.\n</m-disclaimer>';
  const shown = 'Sorry, I can only help with Connect.\n\n---\nNOTE: This assistant is in preview.';
  assert.equal(chatMessage({ author: 'bot', text: reply })?.text, shown);
  assert.equal(chatMessage({ author: 'bot', text: 'Done.\r\n<m-disclaimer>**Note**: Check this.</m-disclaimer>' })?.text, 'Done.\r\n**Note**: Check this.');
  assert.equal(chatMessage({ author: 'bot', text: '<m-disclaimer>\n</m-disclaimer>' }), undefined);
  assert.equal(chatMessage({ author: 'user', text: 'What does <m-disclaimer> do?' })?.text, 'What does <m-disclaimer> do?');
  assert.equal(chatPreview(reply), shown);
  assert.equal(chatPreview('Sorry, I can only help with Connect.\n<m-discl'), 'Sorry, I can only help with Connect.');
  assert.equal(chatPreview('<m-disclaimer>**Note**: Check this.'), '**Note**: Check this.');
});

test('listTasks follows cursors until a page adds nothing new', async () => {
  const t = new FakeTransport();
  const task = (id: string) => ({ taskId: id, sessionId: `s-${id}` });
  t.on(TASKS_PAGE, () => ({ tasks: [task('A'), task('B')], nextCursor: 'c1' }));
  t.on(`${TASKS_PAGE}&cursor=c1`, () => ({ tasks: [task('B'), task('C')], nextCursor: 'c2' }));
  t.on(`${TASKS_PAGE}&cursor=c2`, () => ({ tasks: [task('C')], nextCursor: 'c3' }));
  const tasks = await new M365Client(t).listTasks();
  assert.deepEqual(
    tasks.map((x) => x.taskId),
    ['A', 'B', 'C'],
  );
  assert.equal(t.calls.length, 3);
});

test('taskEvents reads newest pages first and returns events in order', async () => {
  const t = new FakeTransport();
  const ev = (n: number): TaskEvent => ({ event: 'dx', id: `run-${n}`, data: { t: String(n) } });
  const base = 'GET /v1/tasks/live/messages?threadId=19%3At%40thread.v2&pageSize=50';
  t.on(base, () => ({ events: [ev(11), ev(10)], nextCursor: 'k' }));
  t.on(`${base}&cursor=k`, () => ({ events: [ev(9), ev(2)], nextCursor: null }));
  const client = new M365Client(t);
  const all = await client.taskEvents('19:t@thread.v2');
  assert.deepEqual(
    all.events.map((e) => e.id),
    ['run-2', 'run-9', 'run-10', 'run-11'],
  );
  assert.equal(all.complete, true);
  const first = await client.taskEvents('19:t@thread.v2', { maxPages: 1 });
  assert.deepEqual([first.events.length, first.complete], [2, false]);
});

test('projects list skips deleted projects, follows cursors and applies colors', async (t) => {
  const tr = new FakeTransport();
  tr.on('GET /v1/projects', () => ({
    items: [{ projectId: 'P1', title: ' Alpha ', state: 'active' }, { projectId: 'P2', title: 'Gone', state: 'Deleting' }, { title: 'no id' }],
    nextCursor: 'n1',
  }));
  tr.on('GET /v1/projects?cursor=n1', () => ({ items: [{ projectId: 'P3', title: '', state: 'archived' }], cursor: null }));
  tr.on('GET /v1/settings', () => ({ projectColors: { P1: 'blue', P3: null } }));
  const { p } = provider(t, tr);
  const projects = await p.projects.list();
  assert.deepEqual(
    projects.map((x) => [x.id, x.name, x.color, x.archived]),
    [
      ['P1', 'Alpha', 'blue', false],
      ['P3', '(untitled project)', 'gray', true],
    ],
  );
});

test('list combines chats, Cowork tasks and project membership', async (t) => {
  const tr = new FakeTransport();
  tr.sfn.RefreshNavPane = () =>
    nav([
      {
        conversationId: 'AAA-1',
        chatName: ' Budget review ',
        threadId: '19:t1@thread.v2',
        createTimeUtc: 1767225000000,
        updateTimeUtc: 1767225600000,
        path: '/chat/conversation/AAA-1',
        isUnread: true,
        preview: 'x'.repeat(500),
      },
      { conversationId: 'bbb-2', chatName: '', threadId: '19:t2@thread.v2', updateTimeUtc: 1767312000000, path: '/agents/researcher/bbb-2' },
      { conversationId: 'ccc-3', chatName: 'No thread', updateTimeUtc: 1767000000000 },
    ]);
  tr.on(TASKS_PAGE, () => ({
    tasks: [
      {
        taskId: 'tid:oid:s1',
        sessionId: 'S1',
        title: 'Draft memo',
        state: 'completed',
        lastActivity: 1767398400000,
        ic3ThreadId: '19:task1@thread.v2',
        parentConversationId: 'aaa-1',
        parentName: 'Budget review',
        lastReplySummary: 'Done.',
      },
      { taskId: 'tid:oid:s2', sessionId: 'S2', title: 'Research', state: 'running', createdAt: '2026-01-02T00:00:00Z', scheduledTaskState: 'enabled' },
    ],
    nextCursor: null,
  }));
  tr.on('GET /v1/projects', () => ({ items: [{ projectId: 'P1', title: 'Alpha' }, { projectId: 'P2', title: 'Old', state: 'deleted' }] }));
  const asked: string[] = [];
  tr.sfn.GetNavProjectChats = (d) => {
    asked.push(d.projectId);
    return {
      result: { result: { copilotChats: [{ threadId: '19:t2@thread.v2' }, { conversationId: 'CCC-3' }], tasks: [{ sessionId: 's1' }], isComplete: false } },
    };
  };
  const { p } = provider(t, tr);
  const items = await p.list();
  assert.equal(tr.calls[0], 'connect');
  assert.deepEqual(asked, ['P1']);
  const byId = new Map<string, Conversation>(items.map((i) => [i.id, i]));
  assert.deepEqual(
    items.map((i) => i.id),
    ['bbb-2', 'AAA-1', 'ccc-3', 'tid:oid:s1', 'tid:oid:s2'],
  );

  const budget = byId.get('AAA-1')!;
  assert.equal(budget.title, 'Budget review');
  assert.equal(budget.url, 'https://copilot.cloud.microsoft/chat/conversation/AAA-1');
  assert.equal(budget.location, 'Chat');
  assert.equal(budget.status, 'unread');
  assert.equal(budget.preview?.length, 400);
  assert.equal(budget.createdAt, new Date(1767225000000).toISOString());
  assert.deepEqual(budget.projectIds, []);
  assert.deepEqual(budget.extra?.childTaskIds, ['tid:oid:s1']);
  assert.match(budget.note ?? '', /also deletes the Copilot tasks/);

  const researcher = byId.get('bbb-2')!;
  assert.deepEqual([researcher.title, researcher.location, researcher.projectIds], ['(untitled chat)', 'Researcher', ['P1']]);
  assert.equal(researcher.url, 'https://copilot.cloud.microsoft/agents/researcher/bbb-2');

  const noThread = byId.get('ccc-3')!;
  assert.deepEqual(noThread.projectIds, ['P1']);
  assert.match(noThread.note ?? '', /No thread id/);
  assert.equal(noThread.url, 'https://copilot.cloud.microsoft/chat/conversation/ccc-3');

  const memo = byId.get('tid:oid:s1')!;
  assert.deepEqual([memo.kind, memo.location, memo.status, memo.preview], ['cowork-task', 'Cowork', 'completed', 'Done.']);
  assert.deepEqual(memo.projectIds, ['P1']);
  assert.equal(memo.url, 'https://copilot.cloud.microsoft/cowork/#/task/tid%3Aoid%3As1');
  assert.equal(memo.updatedAt, '2026-01-03T00:00:00.000Z');
  assert.match(memo.note ?? '', /Created from the chat "Budget review"/);

  const research = byId.get('tid:oid:s2')!;
  assert.equal(research.updatedAt, '2026-01-02T00:00:00.000Z');
  assert.match(research.note ?? '', /Scheduled task \(enabled\)/);

  assert.deepEqual((await p.status()).warnings, ['Project "Alpha" has more items than the organizer could list.']);
});

test('list still returns chats when tasks or projects cannot be read', async (t) => {
  const tr = new FakeTransport();
  tr.sfn.RefreshNavPane = () => nav([chat('a', 1)]);
  tr.on(/^GET \/v1\/tasks\/live\?/, () => {
    throw new HttpError('forbidden', 403);
  });
  tr.on('GET /v1/projects', () => {
    throw new Error('projects down');
  });
  const { p } = provider(t, tr);
  assert.deepEqual(
    (await p.list()).map((i) => i.id),
    ['a'],
  );
  assert.deepEqual((await p.status()).warnings, ['Cowork tasks could not be listed: forbidden', 'Project membership could not be read: projects down']);

  tr.phase = 'signin';
  assert.equal((await p.status()).signedIn, false);
  tr.phase = 'idle';
  assert.equal((await p.status()).signedIn, undefined);
});

test('deleteItems deletes chats and tasks and reports failures per item', async (t) => {
  const tr = new FakeTransport();
  tr.sfn.DeleteConversation = (d) => (d.conversationId === 'rejected' ? deleted(500) : deleted(200, [d.conversationId]));
  tr.on('DELETE /v1/conversations/S2', () => ({}));
  const { p } = provider(t, tr);
  const progress: string[] = [];
  const results = await p.deleteItems(
    [
      conv('m365', 'AAA-1', { extra: { childTaskIds: ['tid:oid:s1'] } }),
      conv('m365', 'tid:oid:s2', { kind: 'cowork-task', extra: { sessionId: 'S2' } }),
      conv('m365', 'rejected'),
      conv('m365', 'tid:oid:s9', { kind: 'cowork-task', extra: {} }),
      conv('m365', 'odd', { kind: 'notebook' }),
    ],
    (done, total) => progress.push(`${done}/${total}`),
  );
  assert.deepEqual(
    results.map((r) => [r.id, r.ok, r.alsoRemoved ?? r.error ?? null]),
    [
      ['AAA-1', true, ['tid:oid:s1']],
      ['tid:oid:s2', true, null],
      ['rejected', false, 'Delete was rejected (status 500).'],
      ['tid:oid:s9', false, 'Missing Cowork session id'],
      ['odd', false, 'Unsupported item kind notebook'],
    ],
  );
  assert.equal(progress.at(-1), '5/5');
});

test('adding to a project moves items out of their current project first', async (t) => {
  const tr = new FakeTransport();
  tr.on(/^(DELETE|POST) /, () => ({}));
  const { p } = provider(t, tr);
  const results = await p.projects.addItems('P9', [
    conv('m365', 'bbb-2', { projectIds: ['P1'], extra: { threadId: '19:t2@thread.v2' } }),
    conv('m365', 'ccc-3', { projectIds: [], extra: {} }),
    conv('m365', 'tid:oid:s2', { kind: 'cowork-task', projectIds: [], extra: { sessionId: 'S2' } }),
    conv('m365', 'ddd-4', { projectIds: ['P9'], extra: { threadId: '19:t4@thread.v2' } }),
  ]);
  assert.deepEqual(
    results.map((r) => [r.id, r.ok, r.detail ?? r.error ?? null]),
    [
      ['bbb-2', true, 'Moved from another project'],
      ['ccc-3', false, 'This chat has no thread id, so it cannot be put in a project.'],
      ['tid:oid:s2', true, null],
      ['ddd-4', true, 'Already in the project'],
    ],
  );
  assert.deepEqual(tr.sent, [
    { call: 'DELETE /v1/projects/P1/tasks/19%3At2%40thread.v2', body: undefined },
    { call: 'POST /v1/projects/P9/chats', body: { threadId: '19:t2@thread.v2' } },
    { call: 'POST /v2/tasks/projects/P9/tasks', body: { conversationId: 'tid:oid:s2' } },
  ]);

  tr.sent.length = 0;
  const removed = await p.projects.removeItems('P1', [
    conv('m365', 'bbb-2', { extra: { threadId: '19:t2@thread.v2' } }),
    conv('m365', 'tid:oid:s1', { kind: 'cowork-task' }),
  ]);
  assert.ok(removed.every((r) => r.ok));
  assert.deepEqual(
    tr.sent.map((s) => s.call),
    ['DELETE /v1/projects/P1/tasks/19%3At2%40thread.v2', 'DELETE /v1/projects/P1/tasks/tid%3Aoid%3As1'],
  );
});

test('project settings map to the Projects API', async (t) => {
  const tr = new FakeTransport();
  tr.on('POST /v1/projects', (body) => ({ projectId: 'P10', title: body.title, state: 'active' }));
  tr.on(/^(PATCH|DELETE) /, () => ({}));
  let complete = false;
  tr.sfn.GetNavProjectChats = (d) =>
    d.projectId === 'broken' ? { result: {} } : { result: { result: { copilotChats: [{ threadId: 'a' }], tasks: [{ sessionId: 'b' }], isComplete: complete } } };
  const { p } = provider(t, tr);

  await assert.rejects(p.projects.create('   '), /name is required/);
  assert.deepEqual(await p.projects.create(' New '), {
    id: 'P10',
    name: 'New',
    color: 'gray',
    archived: false,
    createdAt: undefined,
    updatedAt: undefined,
  });
  await assert.rejects(async () => p.projects.rename('P1', '  '), /name is required/);
  await p.projects.rename('P1', ' Beta ');
  await p.projects.setArchived('P1', true);
  await p.projects.setArchived('P1', false);
  await p.projects.setColor('P1', 'gray');
  await p.projects.setColor('P1', null);
  await p.projects.setColor('P1', 'blue');
  await assert.rejects(async () => p.projects.setColor('P1', 'teal'), /Unsupported color/);
  await p.projects.delete('P1');
  assert.deepEqual(tr.sent, [
    { call: 'POST /v1/projects', body: { title: 'New', instructions: '', tags: [] } },
    { call: 'PATCH /v1/projects/P1', body: { title: 'Beta' } },
    { call: 'PATCH /v1/projects/P1', body: { state: 'archived' } },
    { call: 'PATCH /v1/projects/P1', body: { state: 'active' } },
    { call: 'PATCH /v1/settings', body: { projectColors: { P1: null } } },
    { call: 'PATCH /v1/settings', body: { projectColors: { P1: null } } },
    { call: 'PATCH /v1/settings', body: { projectColors: { P1: 'blue' } } },
    { call: 'DELETE /v1/projects/P1', body: undefined },
  ]);

  assert.equal(await p.projects.memberCount!('P1'), 3);
  complete = true;
  assert.equal(await p.projects.memberCount!('P1'), 2);
  await assert.rejects(p.projects.memberCount!('broken'), /Unexpected GetNavProjectChats/);
});

test('Cowork task transcripts: a summary by default, the event replay on request', async (t) => {
  const tr = new FakeTransport();
  tr.on('GET /v1/tasks/live/detail?sessionId=S1', () => ({
    task: {
      state: 'completed',
      sessionState: 'idle',
      progressSummary: 'Wrote the memo',
      parentName: 'Budget review',
      todos: [
        { content: 'Outline', completed: true },
        { content: 'Write', status: 'in_progress' },
      ],
    },
    snapshot: {
      completedSubagents: [{ display_name: 'Writer', description: 'drafts', status: 'completed', duration_ms: 90_000 }],
      messageArtifacts: [{ name: 'memo.docx' }],
      activeModel: 'model-x',
      costCredits: 4,
    },
  }));
  tr.on('GET /v1/tasks/live/messages?threadId=19%3Atask1%40thread.v2&pageSize=50', () => ({
    events: [
      { event: 'dx', id: 'e-2', data: { aid: 'a1', t: 'Here you go.' } },
      { event: 'u', id: 'e-1', data: { id: 'seq:1', t: 'Write a memo', ts: 1767225600000 } },
      { event: 'zz', id: 'e-3', data: { n: 1 } },
    ],
    nextCursor: null,
  }));
  const { p, logs } = provider(t, tr);
  const item = conv('m365', 'tid:oid:s1', {
    kind: 'cowork-task',
    title: 'Draft memo',
    extra: { sessionId: 'S1', threadId: '19:task1@thread.v2', lastReplySummary: 'Memo is ready.' },
  });

  const summary = await p.getTranscript(item);
  assert.deepEqual(pairs(summary.messages), [
    ['status', 'Cowork task (completed / idle)\nWrote the memo'],
    ['status', 'Started from the chat "Budget review"'],
    ['status', 'Plan:\n[x] Outline\n[ ] Write'],
    ['tool', 'Subagent Writer: drafts (completed, 2 min)'],
    ['system', 'Artifacts: memo.docx'],
    ['assistant', 'Memo is ready.'],
    ['system', 'model model-x, 4 credits'],
  ]);
  assert.equal(summary.partial, true);
  assert.ok(!tr.calls.some((c) => c.includes('/messages')));

  const full = await p.getTranscript(item, { full: true });
  assert.deepEqual(pairs(full.messages), [
    ['status', 'Cowork task (completed / idle)\nWrote the memo'],
    ['user', 'Write a memo'],
    ['assistant', 'Here you go.'],
  ]);
  assert.equal(full.partial, false);
  assert.equal(full.messages[1].at, '2026-01-01T00:00:00.000Z');
  const raw = full.raw as { unknownCodes: unknown; unknownEvents: unknown };
  assert.deepEqual(raw.unknownCodes, { zz: 1 });
  assert.deepEqual(raw.unknownEvents, [{ event: 'zz', id: 'e-3', data: { n: 1 } }]);
  assert.match(logs.join('\n'), /unknown Cowork event codes \{"zz":1\}/);

  const noThread = await p.getTranscript({ ...item, extra: { sessionId: 'S1' } }, { full: true });
  assert.equal(noThread.partial, true);
});

test('transcriptFromTaskEvents rebuilds messages, tool calls and sources', () => {
  const events: TaskEvent[] = [
    {
      event: 'u',
      id: 'e-1',
      data: { id: 'seq:1', ts: 1767225000000, t: 'Please draft a memo', att: [{ fn: 'notes.docx', url: 'https://example.com/notes.docx' }, { fn: 'q3.xlsx' }] },
    },
    { event: 'dx', id: 'e-2', data: { aid: 'a1', t: 'Sure, ' } },
    { event: 'th', id: 'e-3', data: { t: 'thinking...' } },
    { event: 'dx', id: 'e-4', data: { aid: 'a1', t: 'drafting now.' } },
    { event: 'ts', id: 'e-5', data: { tid: 'tool1', tn: 'search', d: 'quarterly numbers', ts: 1767225600000 } },
    { event: 'tx', id: 'e-6', data: { tid: 'tool1', dur: 2500 } },
    { event: 'ts', id: 'e-7', data: { tid: 'tool2', tn: 'fetch' } },
    { event: 'tx', id: 'e-8', data: { tid: 'tool2', ok: false } },
    { event: 'sa', id: 'e-9', data: { tid: 'sub1', tn: 'Task', sat: 'general-purpose', d: 'Check the numbers', m: 'model-x', ts: 1767225660000 } },
    { event: 'sa', id: 'e-10', data: { tid: 'sub2', tn: 'Task', sat: 'general-purpose', d: '', ad: 'proofreader', m: 'model-x' } },
    { event: 'ci', id: 'e-11', data: { ttl: 'Q3 report' } },
    { event: 'sx', id: 'e-12', data: { tid: 'sub1', tn: 'Task', d: '', ad: 'numbers', dur: 125_000, ok: true, m: 'model-x' } },
    { event: 'sx', id: 'e-13', data: { tid: 'sub2', tn: 'Task', d: '', ok: false } },
    { event: 'ci', id: 'e-14', data: { src: 'https://example.com/q3' } },
    { event: 'dx', id: 'e-15', data: { aid: 'a2', t: 'Here is the memo.' } },
    { event: 'zz', id: 'e-16', data: { message: 'internal note' } },
    { event: 'qq', id: 'e-17', data: {} },
    { event: 'sx', id: 'e-18', data: { tn: 'Writer', dur: 1500 } },
    { event: 'dx', id: 'e-19', data: { aid: 'a3', t: 'Final words.' } },
    { event: 'fr', id: 'e-20', data: { stop: 'end_turn', ts: 1767226200000 } },
    { event: 'fu', id: 'e-21', data: { rp: 'input/notes.docx', ip: 'Tasks/draft-memo/input/notes.docx', sz: 1200, ts: 1767229200000 } },
    { event: 'fu', id: 'e-22', data: { rp: 'input/q3.xlsx', ip: 'Tasks/draft-memo/input/q3.xlsx', sz: 900, ts: 1767229200001 } },
    { event: 'fu', id: 'e-23', data: {} },
  ];
  const { messages, unknownCodes, unknownEvents } = transcriptFromTaskEvents(events);
  assert.deepEqual(pairs(messages), [
    ['user', 'Please draft a memo\n\nAttached: notes.docx, q3.xlsx'],
    ['assistant', 'Sure, drafting now.'],
    ['tool', '▶ search: quarterly numbers (2.5 s)'],
    ['tool', '▶ fetch (failed)'],
    ['tool', '▶ Subagent: Check the numbers (2 min)'],
    ['tool', '▶ Subagent: proofreader (failed)'],
    ['assistant', 'Here is the memo.'],
    ['system', '[zz] internal note'],
    ['tool', 'Subagent Writer finished in 1.5 s'],
    ['assistant', 'Final words.'],
    ['system', 'Files added to OneDrive:\nTasks/draft-memo/input/notes.docx\nTasks/draft-memo/input/q3.xlsx'],
    ['system', 'Sources: Q3 report; https://example.com/q3'],
  ]);
  assert.deepEqual(
    messages.map((m) => m.at),
    [
      '2025-12-31T23:50:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      undefined,
      '2026-01-01T00:01:00.000Z',
      undefined,
      undefined,
      undefined,
      undefined,
      '2026-01-01T00:10:00.000Z',
      '2026-01-01T01:00:00.000Z',
      undefined,
    ],
  );
  assert.deepEqual(unknownCodes, { zz: 1, qq: 1 });
  assert.deepEqual(
    unknownEvents.map((e) => e.id),
    ['e-16', 'e-17'],
  );
});

test('transcriptFromTaskEvents keeps only the first 50 unknown events', () => {
  const events: TaskEvent[] = Array.from({ length: 60 }, (_, n) => ({ event: 'zz', id: `e-${n}`, data: {} }));
  const { unknownCodes, unknownEvents } = transcriptFromTaskEvents(events);
  assert.deepEqual(unknownCodes, { zz: 60 });
  assert.equal(unknownEvents.length, 50);
});

test('transcriptFromTaskEvents groups parallel subagents and shows questions, answers and changed files', () => {
  const events: TaskEvent[] = [
    { event: 'u', id: 'e-1', data: { ts: 1767225000000, t: 'Review my week' } },
    { event: 'dx', id: 'e-2', data: { t: 'Starting two reviews.' } },
    { event: 'sa', id: 'e-3', data: { tid: 'toolu_A', tn: 'Task', d: 'Read mail', ts: 1767225060000 } },
    { event: 'sa', id: 'e-4', data: { tid: 'toolu_B', tn: 'Task', d: 'Read calendar', ts: 1767225061000 } },
    { event: 'dx', id: 'e-5', data: { aid: 'toolu_A', t: 'Looking at ' } },
    { event: 'dx', id: 'e-6', data: { aid: 'toolu_B', t: 'Checking ' } },
    { event: 'dx', id: 'e-7', data: { aid: 'toolu_A', t: 'your inbox.' } },
    { event: 'ts', id: 'e-8', data: { aid: 'toolu_A', tid: 't1', tn: 'search_mail', ts: 1767225070000 } },
    { event: 'dx', id: 'e-9', data: { aid: 'toolu_B', t: 'the calendar.' } },
    { event: 'ts', id: 'e-10', data: { aid: 'toolu_B', tid: 't3', tn: 'list_events', ts: 1767225071000 } },
    { event: 'ts', id: 'e-11', data: { tid: 'm1', tn: 'update_todo', ts: 1767225120000 } },
    { event: 'tx', id: 'e-12', data: { tid: 'm1', dur: 500 } },
    { event: 'tx', id: 'e-13', data: { aid: 'toolu_A', tid: 't1', dur: 1200 } },
    { event: 'ts', id: 'e-14', data: { aid: 'toolu_A', tid: 't2', tn: 'read_mail', d: 'thread 1' } },
    { event: 'tx', id: 'e-15', data: { aid: 'toolu_B', tid: 't3', dur: 3000 } },
    { event: 'tx', id: 'e-16', data: { aid: 'toolu_A', tid: 't2', ok: false } },
    { event: 'dx', id: 'e-17', data: { aid: 'toolu_A', t: 'Found 3 threads.' } },
    { event: 'fr', id: 'e-18', data: { aid: 'toolu_A' } },
    { event: 'dx', id: 'e-19', data: { aid: 'toolu_A', t: 'Done.' } },
    { event: 'sx', id: 'e-20', data: { tid: 'toolu_A', dur: 180_000, ok: true } },
    { event: 'sx', id: 'e-20b', data: { tid: 'toolu_A', dur: 240_000, ok: true } },
    { event: 'sx', id: 'e-21', data: { tid: 'toolu_B', ok: false } },
    {
      event: 'aq',
      id: 'e-22',
      data: {
        iid: 'q1',
        ts: 1767225300000,
        q: [
          { header: 'Scope', question: 'Include personal mail?', options: ['Yes', { label: 'No' }, { text: 'Only flagged' }, {}] },
          { header: '', question: 'Any deadline?', options: [] },
          { header: 'Empty' },
        ],
      },
    },
    { event: 'ar', id: 'e-23', data: { rid: 'r1', r: '' } },
    { event: 'aa', id: 'e-24', data: { iid: 'q1', ts: 1767225360000, answers: { '0': 'Yes', '1': ['Mon', 'Tue'], '2': '' } } },
    { event: 'aa', id: 'e-25', data: { iid: 'q1', answers: { '0': '' } } },
    { event: 'ar', id: 'e-26', data: { rid: 'r2', r: 'later' } },
    { event: 'fc', id: 'e-27', data: { fid: '', fn: 'output/week.docx', ct: 'created', sz: 100 } },
    { event: 'fc', id: 'e-28', data: { fid: '', fn: 'output/week.docx', ct: 'modified', sz: 120 } },
    { event: 'fc', id: 'e-29', data: { fid: '', fn: 'output/week.docx', ct: 'modified', sz: 140 } },
    { event: 'fc', id: 'e-30', data: { fn: 'output/notes.md' } },
    { event: 'fc', id: 'e-31', data: { fid: '' } },
    { event: 'dx', id: 'e-32', data: { t: "Here's your week." } },
    { event: 'fr', id: 'e-33', data: { ts: 1767225420000 } },
  ];
  const { messages, unknownCodes, unknownEvents } = transcriptFromTaskEvents(events);
  assert.deepEqual(pairs(messages), [
    ['user', 'Review my week'],
    ['assistant', 'Starting two reviews.'],
    ['tool', '▶ Subagent: Read mail (3 min)\n\nLooking at your inbox.\n\n▶ search_mail (1.2 s)\n▶ read_mail: thread 1 (failed)\n\nFound 3 threads.\n\nDone.'],
    ['tool', '▶ Subagent: Read calendar (failed)\n\nChecking the calendar.\n\n▶ list_events (3.0 s)'],
    ['tool', '▶ update_todo (500 ms)'],
    ['assistant', 'Question for you:\nScope: Include personal mail?\nOptions: Yes; No; Only flagged\n\nAny deadline?'],
    ['user', 'Answer: Yes\nMon, Tue'],
    ['assistant', "Here's your week."],
    ['system', 'Files created or changed:\noutput/week.docx (created, modified)\noutput/notes.md'],
  ]);
  assert.deepEqual(
    messages.map((m) => m.at),
    [
      '2025-12-31T23:50:00.000Z',
      '2025-12-31T23:51:00.000Z',
      '2025-12-31T23:51:00.000Z',
      '2025-12-31T23:51:01.000Z',
      '2025-12-31T23:52:00.000Z',
      '2025-12-31T23:55:00.000Z',
      '2025-12-31T23:56:00.000Z',
      '2025-12-31T23:57:00.000Z',
      undefined,
    ],
  );
  assert.deepEqual(unknownCodes, { ar: 1 });
  assert.deepEqual(
    unknownEvents.map((e) => e.id),
    ['e-26'],
  );
});

test('the client retries throttled Projects API calls', async () => {
  const t = new FakeTransport();
  let calls = 0;
  t.on('GET /v1/projects', () => {
    calls++;
    if (calls === 1) throw new HttpError('slow down', 429, 1);
    return { items: [{ projectId: 'P1', title: 'A' }] };
  });
  const projects = await new M365Client(t).listProjects();
  assert.deepEqual(
    projects.map((x) => x.projectId),
    ['P1'],
  );
  assert.equal(calls, 2);
});
