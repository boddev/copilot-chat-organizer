// Tests for the VS Code Copilot Chat provider. Every test that writes runs against synthetic
// fixtures in a project-local temp folder (.data/test-tmp); the real VS Code data is only read
// (smoke test at the end, with deleting disabled).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Conversation, ProviderContext } from '../src/core/types.ts';
import { safeName } from '../src/core/store.ts';
import { VsCodeProvider, editionLabel } from '../src/providers/vscode/index.ts';
import { defaultRoots, describeWorkspaceUri, isInside, makeItemId, parseItemId } from '../src/providers/vscode/paths.ts';
import {
  applyMutation,
  readSessionFile,
  summarize,
  summarizeSessionFile,
  type JsonObject,
} from '../src/providers/vscode/session.ts';
import { CHAT_INDEX_KEY, putIndexEntry, readChatIndex, removeIndexEntry } from '../src/providers/vscode/stateDb.ts';
import { ProcessDetector, editionIsRunning, executableNames, parseTasklistCsv } from '../src/providers/vscode/running.ts';
import { boundRaw, buildTranscriptMessages } from '../src/providers/vscode/transcript.ts';

// ---- temp folders ------------------------------------------------------------------------

const REPO = path.resolve(import.meta.dirname, '..');
const TMP_PARENT = path.join(REPO, '.data', 'test-tmp');
const tempDirs: string[] = [];

function makeTempDir(): string {
  fs.mkdirSync(TMP_PARENT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_PARENT, 'vscode-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    fs.rmdirSync(TMP_PARENT); // only succeeds when no other test left files there
  } catch {
    // not empty or already gone
  }
});

// ---- helpers -------------------------------------------------------------------------------

const T0 = Date.UTC(2025, 0, 15, 10, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

const WS_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REMOTE_HASH = 'f00dfeedf00dfeedf00dfeedf00dfeed';
const JSON_ID = '11111111-1111-4111-8111-111111111111';
const JSONL_ID = '22222222-2222-4222-8222-222222222222';
const EMPTY_ID = '33333333-3333-4333-8333-333333333333';
const TITLED_ID = '44444444-4444-4444-8444-444444444444';
const EW_ID = '55555555-5555-4555-8555-555555555555';
const INS_ID = '66666666-6666-4666-8666-666666666666';
const EXTERNAL_ID = '77777777-7777-4777-8777-777777777777';
const UNRELATED_KEY = 'workbench.view.extension.test.state';
const UNRELATED_VALUE = '{"keep":true}';

const JSON_ITEM = makeItemId('stable', WS_HASH, JSON_ID);
const JSONL_ITEM = makeItemId('stable', WS_HASH, JSONL_ID);
const TITLED_ITEM = makeItemId('stable', WS_HASH, TITLED_ID);
const EW_ITEM = makeItemId('stable', 'empty-window', EW_ID);
const INS_ITEM = makeItemId('insiders', REMOTE_HASH, INS_ID);

function write(file: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const toJsonl = (entries: unknown[], eol = '\n'): string => entries.map((e) => JSON.stringify(e)).join(eol) + eol;

/** Creates a state.vscdb like VS Code's (values stored as JSON text unless given as bytes). */
function createStateDb(file: string, rows: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(rows)) {
      insert.run(key, typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value));
    }
  } finally {
    db.close();
  }
}

function readRow(file: string, key: string): string | Uint8Array | undefined {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const value = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)?.value;
    return typeof value === 'string' || value instanceof Uint8Array ? value : undefined;
  } finally {
    db.close();
  }
}

function deleteRow(file: string, key: string): void {
  const db = new DatabaseSync(file);
  try {
    db.prepare('DELETE FROM ItemTable WHERE key = ?').run(key);
  } finally {
    db.close();
  }
}

/** Index entries of a state database, parsed with a plain prototype (for deepEqual). */
function indexOf(file: string): { version?: unknown; entries: Record<string, unknown> } | undefined {
  const raw = readRow(file, CHAT_INDEX_KEY);
  if (raw === undefined) return undefined;
  return JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as {
    version?: unknown;
    entries: Record<string, unknown>;
  };
}

function indexEntry(sessionId: string, title: string, created: number, last: number, extra: JsonObject = {}): JsonObject {
  return {
    sessionId,
    title,
    lastMessageDate: last,
    timing: { created, lastRequestEnded: last + 5_000 },
    initialLocation: 'panel',
    hasPendingEdits: false,
    isEmpty: false,
    isExternal: false,
    lastResponseState: 1,
    ...extra,
  };
}

type TestContext = ProviderContext & { logs: string[] };

function makeContext(base: string): TestContext {
  const logs: string[] = [];
  return {
    dataDir: path.join(base, 'data'),
    trashDir: path.join(base, 'data', 'trash', 'vscode'),
    log: (m: string) => {
      logs.push(m);
    },
    logs,
  };
}

const roles = (messages: Array<{ role: string; text: string }>): Array<[string, string]> =>
  messages.map((m) => [m.role, m.text]);

// ---- fixtures --------------------------------------------------------------------------------

/** Older full-JSON session format (version 3). */
function jsonSession(): JsonObject {
  const appTs = 'file:///c%3A/src/demo%20app/src/app.ts#1-10';
  return {
    version: 3,
    requesterUsername: 'tester',
    responderUsername: 'GitHub Copilot',
    initialLocation: 'panel',
    sessionId: JSON_ID,
    creationDate: T0,
    lastMessageDate: T0 + 60_000,
    isImported: false,
    requests: [
      {
        requestId: 'request_json_1',
        timestamp: T0 + 1_000,
        modelId: 'copilot/test-model',
        message: { text: 'How do I   run\nthe tests?', parts: [{ kind: 'text', text: 'How do I   run\nthe tests?' }] },
        variableData: { variables: [] },
        response: [
          { kind: 'thinking', value: 'secret reasoning that must not appear' },
          { value: 'Run the suite with ', supportThemeIcons: false, supportHtml: false },
          {
            kind: 'inlineReference',
            inlineReference: {
              $mid: 1,
              fsPath: 'c:\\src\\demo app\\package.json',
              external: 'file:///c%3A/src/demo%20app/package.json',
              path: '/c:/src/demo app/package.json',
              scheme: 'file',
            },
          },
          { value: ' scripts.' },
          {
            kind: 'toolInvocationSerialized',
            toolId: 'run_in_terminal',
            invocationMessage: 'Running `npm test`',
            isComplete: true,
            toolSpecificData: { kind: 'terminal', commandLine: { original: 'npm test' }, language: 'pwsh' },
          },
          {
            kind: 'toolInvocationSerialized',
            toolId: 'copilot_readFile',
            invocationMessage: { value: `Reading [](${appTs}), lines 1 to 10` },
            pastTenseMessage: { value: `Read [](${appTs}), lines 1 to 10` },
            isComplete: true,
          },
          {
            kind: 'textEditGroup',
            uri: { $mid: 1, fsPath: 'c:\\src\\demo app\\src\\app.ts', path: '/c:/src/demo app/src/app.ts', scheme: 'file' },
            edits: [[{ text: 'export {};', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }]],
            done: true,
          },
          { kind: 'undoStop', id: 'stop-1' },
          { value: 'All tests pass.' },
        ],
        result: { timings: { firstProgress: 500, totalElapsed: 4_000 }, metadata: {} },
        followups: [],
        isCanceled: false,
      },
      {
        requestId: 'request_json_2',
        timestamp: T0 + 30_000,
        message: { text: 'Thanks!', parts: [] },
        response: [{ value: 'You are welcome.' }],
        result: { errorDetails: { message: 'Rate limited', responseIsFiltered: false }, timings: { totalElapsed: 1_000 } },
      },
    ],
  };
}

const JSON_TRANSCRIPT: Array<[string, string]> = [
  ['user', 'How do I   run\nthe tests?'],
  ['assistant', 'Run the suite with package.json scripts.'],
  ['tool', 'Ran: npm test'],
  ['tool', 'Read app.ts, lines 1 to 10'],
  ['tool', 'Edited app.ts'],
  ['assistant', 'All tests pass.'],
  ['user', 'Thanks!'],
  ['assistant', 'You are welcome.'],
  ['status', 'Error: Rate limited'],
];

/** Current mutation-log format: kind 0 = initial state, 1 = set, 2 = push (i = truncate first), 3 = delete. */
function jsonlEntries(): unknown[] {
  return [
    {
      kind: 0,
      v: {
        version: 3,
        creationDate: T0 + 100_000,
        initialLocation: 'panel',
        responderUsername: 'GitHub Copilot',
        sessionId: JSONL_ID,
        hasPendingEdits: false,
        requests: [],
        pendingRequests: [],
        inputState: { inputText: '', attachments: [], mode: { id: 'agent', kind: 'agent' } },
      },
    },
    { kind: 1, k: ['inputState', 'inputText'], v: 'Explain the build' },
    {
      kind: 2,
      k: ['requests'],
      v: [
        {
          requestId: 'request_l1',
          timestamp: T0 + 110_000,
          message: { text: 'Explain the build', parts: [{ kind: 'text', text: 'Explain the build' }] },
          variableData: { variables: [] },
          response: [],
          modelId: 'copilot/test-model',
        },
      ],
    },
    { kind: 1, k: ['inputState', 'inputText'], v: '' },
    { kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'Partial ans' }] },
    {
      kind: 2,
      k: ['requests', 0, 'response'],
      v: [
        { value: 'The build uses tsc.' },
        {
          kind: 'toolInvocationSerialized',
          toolId: 'copilot_findFiles',
          invocationMessage: { value: 'Searching for files' },
          pastTenseMessage: { value: 'Searched for files' },
          isComplete: true,
        },
      ],
      i: 0,
    },
    { kind: 1, k: ['requests', 0, 'result'], v: { timings: { totalElapsed: 2_500 }, metadata: {} } },
    { kind: 1, k: ['customTitle'], v: 'Custom JSONL title' },
    {
      kind: 2,
      k: ['requests'],
      v: [{ requestId: 'request_l2', timestamp: T0 + 200_000, message: { text: 'And tests?', parts: [] }, response: [] }],
    },
    { kind: 2, k: ['requests', 1, 'response'], v: [{ value: 'Use node --test.' }] },
    { kind: 1, k: ['requests', 1, 'isCanceled'], v: true },
  ];
}

const JSONL_TRANSCRIPT: Array<[string, string]> = [
  ['user', 'Explain the build'],
  ['assistant', 'The build uses tsc.'],
  ['tool', 'Searched for files'],
  ['user', 'And tests?'],
  ['assistant', 'Use node --test.'],
  ['status', 'Canceled'],
];

/** Empty-window chat whose log starts from a compacted state that already holds a request. */
function emptyWindowEntries(): unknown[] {
  return [
    {
      kind: 0,
      v: {
        version: 3,
        sessionId: EW_ID,
        creationDate: T0 + 390_000,
        initialLocation: 'panel',
        requests: [
          {
            requestId: 'request_e1',
            timestamp: T0 + 391_000,
            message: { text: 'Quick question about regex' },
            response: [{ value: 'Use a lookahead.' }],
            result: { timings: { totalElapsed: 1_000 } },
          },
        ],
      },
    },
    { kind: 1, k: ['inputState'], v: { inputText: '' } },
  ];
}

interface Fixture {
  base: string;
  ctx: TestContext;
  roots: Array<{ edition: string; userDir: string }>;
  stableDir: string;
  insidersDir: string;
  wsDir: string;
  wsDb: string;
  globalDb: string;
  insidersDb: string;
  files: { json: string; jsonl: string; empty: string; titled: string; emptyWindow: string; insiders: string };
  /** Per-chat data of the JSONL chat that VS Code keeps next to the session. */
  companions: string[];
  /** Editing-session data of the JSON chat (must not move when another chat is deleted). */
  otherCompanion: string;
}

function makeFixture(): Fixture {
  const base = makeTempDir();
  const stableDir = path.join(base, 'Code', 'User');
  const insidersDir = path.join(base, 'Code - Insiders', 'User');
  const wsDir = path.join(stableDir, 'workspaceStorage', WS_HASH);
  const insWsDir = path.join(insidersDir, 'workspaceStorage', REMOTE_HASH);
  const files = {
    json: path.join(wsDir, 'chatSessions', `${JSON_ID}.json`),
    jsonl: path.join(wsDir, 'chatSessions', `${JSONL_ID}.jsonl`),
    empty: path.join(wsDir, 'chatSessions', `${EMPTY_ID}.jsonl`),
    titled: path.join(wsDir, 'chatSessions', `${TITLED_ID}.json`),
    emptyWindow: path.join(stableDir, 'globalStorage', 'emptyWindowChatSessions', `${EW_ID}.jsonl`),
    insiders: path.join(insWsDir, 'chatSessions', `${INS_ID}.json`),
  };
  write(path.join(wsDir, 'workspace.json'), JSON.stringify({ folder: 'file:///c%3A/src/demo%20app' }));
  write(files.json, JSON.stringify(jsonSession(), null, 2));
  write(files.jsonl, toJsonl(jsonlEntries()));
  write(files.empty, toJsonl([{ kind: 0, v: { version: 3, sessionId: EMPTY_ID, creationDate: T0, requests: [] } }]));
  write(
    files.titled,
    JSON.stringify({
      version: 3,
      sessionId: TITLED_ID,
      creationDate: T0 + 300_000,
      lastMessageDate: T0 + 300_000,
      customTitle: 'Kept because titled',
      requests: [],
    }),
  );
  write(files.emptyWindow, toJsonl(emptyWindowEntries()));
  write(path.join(insWsDir, 'workspace.json'), JSON.stringify({ folder: 'vscode-remote://ssh-remote%2Bmybox/home/me/proj' }));
  write(
    files.insiders,
    JSON.stringify({
      version: 3,
      sessionId: INS_ID,
      creationDate: T0 + 480_000,
      requests: [
        { requestId: 'request_i1', timestamp: T0 + 490_000, message: { text: 'Check the remote build' }, response: [{ value: 'It builds.' }] },
      ],
    }),
  );
  const companions = [
    path.join(wsDir, 'chatEditingSessions', JSONL_ID, 'state.json'),
    path.join(wsDir, 'GitHub.copilot-chat', 'transcripts', `${JSONL_ID}.jsonl`),
  ];
  write(companions[0], '{"version":2,"timeline":[]}');
  write(companions[1], '{"type":"session.start"}\n');
  const otherCompanion = path.join(wsDir, 'chatEditingSessions', JSON_ID, 'state.json');
  write(otherCompanion, '{"version":2}');

  const wsDb = path.join(wsDir, 'state.vscdb');
  const globalDb = path.join(stableDir, 'globalStorage', 'state.vscdb');
  const insidersDb = path.join(insWsDir, 'state.vscdb');
  createStateDb(wsDb, {
    [CHAT_INDEX_KEY]: {
      version: 1,
      entries: {
        [JSON_ID]: indexEntry(JSON_ID, 'Index title for JSON chat', T0, T0 + 60_000),
        [JSONL_ID]: indexEntry(JSONL_ID, 'Custom JSONL title', T0 + 100_000, T0 + 200_000),
        [EMPTY_ID]: indexEntry(EMPTY_ID, 'New Chat', T0, T0, { isEmpty: true }),
        [EXTERNAL_ID]: indexEntry(EXTERNAL_ID, 'Cloud agent session', T0, T0 + 1_000, { isExternal: true }),
      },
    },
    [UNRELATED_KEY]: UNRELATED_VALUE,
  });
  createStateDb(globalDb, {
    [CHAT_INDEX_KEY]: { version: 1, entries: { [EW_ID]: indexEntry(EW_ID, 'New Chat', T0 + 390_000, T0 + 395_000) } },
    [UNRELATED_KEY]: UNRELATED_VALUE,
  });
  createStateDb(insidersDb, {
    [CHAT_INDEX_KEY]: { version: 1, entries: { [INS_ID]: indexEntry(INS_ID, 'Remote chat title', T0 + 480_000, T0 + 495_000) } },
  });
  return {
    base,
    ctx: makeContext(base),
    roots: [
      { edition: 'stable', userDir: stableDir },
      { edition: 'insiders', userDir: insidersDir },
    ],
    stableDir,
    insidersDir,
    wsDir,
    wsDb,
    globalDb,
    insidersDb,
    files,
    companions,
    otherCompanion,
  };
}

/** Provider over a fixture; Insiders counts as running unless `running` says otherwise. */
function providerFor(fx: Fixture, running: (edition: string) => boolean = (e) => e === 'insiders'): VsCodeProvider {
  return new VsCodeProvider(fx.ctx, { roots: fx.roots, isRunning: async (e) => running(e) });
}

function byId(items: Conversation[], id: string): Conversation {
  const item = items.find((i) => i.id === id);
  assert.ok(item, `missing item ${id}`);
  return item;
}

// ---- listing ---------------------------------------------------------------------------------

describe('VsCodeProvider listing', () => {
  test('lists JSON, JSONL and empty-window chats with titles, locations and dates', async () => {
    const fx = makeFixture();
    const provider = providerFor(fx);
    assert.equal(provider.id, 'vscode');
    assert.equal(provider.label, 'VS Code Copilot Chat');
    const progress: Array<[number, number | undefined]> = [];
    const items = await provider.list((done, total) => progress.push([done, total]));

    // Newest first; the empty untitled chat and the external index entry are not listed.
    assert.deepEqual(
      items.map((i) => i.id),
      [INS_ITEM, EW_ITEM, TITLED_ITEM, JSONL_ITEM, JSON_ITEM],
    );
    assert.deepEqual(progress.at(-1), [6, 6]);
    for (const item of items) {
      assert.equal(item.source, 'vscode');
      assert.equal(item.kind, 'vscode-chat');
      const parsed = parseItemId(item.id);
      assert.ok(parsed);
      assert.equal(makeItemId(parsed.edition, parsed.workspaceHash, parsed.sessionId), item.id);
      assert.equal(item.extra?.sessionId, parsed.sessionId);
    }

    const json = byId(items, JSON_ITEM);
    assert.equal(json.title, 'Index title for JSON chat');
    assert.equal(json.location, 'C:\\src\\demo app');
    assert.equal(json.messageCount, 2);
    assert.equal(json.preview, 'How do I run the tests?');
    assert.equal(json.createdAt, iso(T0));
    assert.equal(json.updatedAt, iso(T0 + 65_000));
    assert.equal(json.deleteMode, 'trash');
    assert.equal(json.note, undefined);
    assert.equal(json.extra?.format, 'json');
    assert.equal(json.extra?.edition, 'stable');
    assert.equal(json.extra?.workspaceHash, WS_HASH);
    assert.equal(json.extra?.file, fx.files.json);
    assert.equal(json.extra?.indexed, true);
    assert.equal(json.extra?.indexDb, fx.wsDb);

    const jsonl = byId(items, JSONL_ITEM);
    assert.equal(jsonl.title, 'Custom JSONL title');
    assert.equal(jsonl.messageCount, 2);
    assert.equal(jsonl.preview, 'Explain the build');
    assert.equal(jsonl.createdAt, iso(T0 + 100_000));
    assert.equal(jsonl.updatedAt, iso(T0 + 205_000));
    assert.equal(jsonl.extra?.format, 'jsonl');
    assert.equal(jsonl.extra?.file, fx.files.jsonl);
    assert.equal(jsonl.deleteMode, 'trash');

    const titled = byId(items, TITLED_ITEM);
    assert.equal(titled.title, 'Kept because titled');
    assert.equal(titled.messageCount, 0);
    assert.equal(titled.preview, undefined);
    assert.equal(titled.extra?.indexed, false);
    assert.equal(titled.updatedAt, iso(T0 + 300_000));

    const ew = byId(items, EW_ITEM);
    assert.equal(ew.title, 'Quick question about regex'); // the index only has the placeholder 'New Chat'
    assert.equal(ew.location, 'Empty window');
    assert.equal(ew.messageCount, 1);
    assert.equal(ew.createdAt, iso(T0 + 390_000));
    assert.equal(ew.updatedAt, iso(T0 + 400_000));
    assert.equal(ew.extra?.indexDb, fx.globalDb);
    assert.equal(ew.extra?.workspaceHash, 'empty-window');

    const ins = byId(items, INS_ITEM);
    assert.equal(ins.title, 'Remote chat title');
    assert.equal(ins.location, 'ssh-remote+mybox:/home/me/proj');
    assert.equal(ins.updatedAt, iso(T0 + 500_000));
    assert.equal(ins.deleteMode, 'none');
    assert.equal(ins.note, 'Close VS Code (insiders) to delete this chat');
  });

  test('second listing reuses cached summaries and sees file changes', async () => {
    const fx = makeFixture();
    const provider = providerFor(fx);
    await provider.list();
    const entries = jsonlEntries();
    entries.push({ kind: 1, k: ['customTitle'], v: 'Renamed later' });
    write(fx.files.jsonl, toJsonl(entries));
    const items = await provider.list();
    assert.equal(byId(items, JSONL_ITEM).title, 'Renamed later');
  });

  test('clips long titles, falls back to Untitled/Unreadable chat and reads legacy empty-window folders', async () => {
    const base = makeTempDir();
    const userDir = path.join(base, 'User');
    const legacy = path.join(userDir, 'workspaceStorage', 'no-workspace', 'chatSessions');
    const long = `Please   ${'explain this code '.repeat(30)}`;
    write(
      path.join(legacy, 'long-1.json'),
      JSON.stringify({ sessionId: 'long-1', creationDate: T0, requests: [{ message: { text: long }, timestamp: T0 }] }),
    );
    write(
      path.join(legacy, 'untitled-1.jsonl'),
      toJsonl([{ kind: 0, v: { sessionId: 'untitled-1', creationDate: T0, requests: [{ message: { text: '  ' }, timestamp: T0 + 1 }] } }]),
    );
    write(path.join(legacy, 'broken-1.json'), '{ not json');
    write(path.join(legacy, 'zero-1.json'), '');
    write(path.join(legacy, 'ignored.txt'), 'not a session');
    write(path.join(legacy, '..evil.json'), JSON.stringify({ requests: [{ message: { text: 'x' } }] }));
    const ctx = makeContext(base);
    const provider = new VsCodeProvider(ctx, { roots: [{ edition: 'stable', userDir }], isRunning: async () => false });
    const items = await provider.list();
    assert.deepEqual(items.map((i) => i.extra?.sessionId).sort(), ['broken-1', 'long-1', 'untitled-1']);

    const longItem = byId(items, 'stable:no-workspace:long-1');
    assert.equal(longItem.title.length, 140);
    assert.ok(longItem.title.startsWith('Please explain this code explain'));
    assert.ok(longItem.title.endsWith('…'));
    assert.equal(longItem.preview?.length, 200);
    assert.equal(longItem.location, 'Empty window');

    assert.equal(byId(items, 'stable:no-workspace:untitled-1').title, 'Untitled chat');
    const broken = byId(items, 'stable:no-workspace:broken-1');
    assert.equal(broken.title, 'Unreadable chat');
    assert.match(broken.note ?? '', /Could not read this chat file/);
    assert.ok(ctx.logs.some((m) => m.includes('broken-1.json')));
  });

  test('a failing running check disables deleting', async () => {
    const fx = makeFixture();
    const provider = new VsCodeProvider(fx.ctx, {
      roots: fx.roots,
      isRunning: async () => {
        throw new Error('no process list');
      },
    });
    const items = await provider.list();
    assert.equal(items.length, 5);
    assert.ok(items.every((i) => i.deleteMode === 'none'));
    const status = await provider.status();
    assert.equal(status.warnings?.length, 2);
  });
});

describe('VsCodeProvider status', () => {
  test('is available with a warning for the running edition', async () => {
    const fx = makeFixture();
    const status = await providerFor(fx).status();
    assert.equal(status.available, true);
    assert.equal(status.message, 'Reading chats from VS Code and VS Code Insiders');
    assert.deepEqual(status.warnings, ['VS Code Insiders is running — deleting is disabled until it is closed']);
    const idle = await providerFor(fx, () => false).status();
    assert.equal(idle.warnings, undefined);
  });

  test('is unavailable when no user data folder exists', async () => {
    const base = makeTempDir();
    const provider = new VsCodeProvider(makeContext(base), {
      roots: [{ edition: 'stable', userDir: path.join(base, 'missing') }],
      isRunning: async () => false,
    });
    const status = await provider.status();
    assert.equal(status.available, false);
    assert.deepEqual(await provider.list(), []);
  });

  test('labels editions', () => {
    assert.equal(editionLabel('stable'), 'VS Code');
    assert.equal(editionLabel('insiders'), 'VS Code Insiders');
    assert.equal(editionLabel('exploration'), 'VS Code (exploration)');
  });
});

// ---- transcripts -----------------------------------------------------------------------------

describe('VsCodeProvider transcripts', () => {
  test('assembles a JSON-format chat', async () => {
    const fx = makeFixture();
    const provider = providerFor(fx);
    const item = byId(await provider.list(), JSON_ITEM);
    const transcript = await provider.getTranscript(item);
    assert.equal(transcript.source, 'vscode');
    assert.equal(transcript.id, JSON_ITEM);
    assert.equal(transcript.title, 'Index title for JSON chat');
    assert.deepEqual(roles(transcript.messages), JSON_TRANSCRIPT);
    assert.equal(transcript.messages[0].at, iso(T0 + 1_000));
    assert.equal(transcript.messages[1].at, iso(T0 + 5_000));
    assert.ok(!transcript.messages.some((m) => m.text.includes('secret reasoning')));
    assert.equal(transcript.partial, undefined);
    assert.equal((transcript.raw as JsonObject).sessionId, JSON_ID);
  });

  test('reconstructs a JSONL mutation log', async () => {
    const fx = makeFixture();
    const provider = providerFor(fx);
    const item = byId(await provider.list(), JSONL_ITEM);
    const transcript = await provider.getTranscript(item);
    assert.equal(transcript.title, 'Custom JSONL title');
    assert.deepEqual(roles(transcript.messages), JSONL_TRANSCRIPT);
    assert.equal(transcript.messages[0].at, iso(T0 + 110_000));
    assert.equal(transcript.messages[1].at, iso(T0 + 112_500));
    const raw = transcript.raw as { requests: Array<{ response: unknown[] }>; inputState: JsonObject };
    assert.equal(raw.requests.length, 2);
    assert.equal(raw.requests[0].response.length, 2); // 'Partial ans' was replaced (push with i: 0)
    assert.equal(raw.inputState.inputText, '');
  });

  test('reads empty-window chats and rejects bad ids', async () => {
    const fx = makeFixture();
    const provider = providerFor(fx);
    const item = byId(await provider.list(), EW_ITEM);
    const transcript = await provider.getTranscript(item);
    assert.deepEqual(roles(transcript.messages), [
      ['user', 'Quick question about regex'],
      ['assistant', 'Use a lookahead.'],
    ]);
    await assert.rejects(provider.getTranscript({ ...item, id: 'stable:..:x' }), /Invalid VS Code chat id/);
    await assert.rejects(provider.getTranscript({ ...item, id: `stable:${WS_HASH}:does-not-exist` }), /not found/);
  });

  test('marks a log with a torn last line as partial', async () => {
    const fx = makeFixture();
    fs.appendFileSync(fx.files.jsonl, '{"kind":2,"k":["requests",1,"response"],"v":[{"value":"cut of');
    const provider = providerFor(fx);
    const transcript = await provider.getTranscript(byId(await provider.list(), JSONL_ITEM));
    assert.equal(transcript.partial, true);
    assert.match(transcript.note ?? '', /could not be read/);
    assert.deepEqual(roles(transcript.messages), JSONL_TRANSCRIPT);
  });

  test('bounds the raw copy of oversized sessions', () => {
    const session = { ...jsonSession(), padding: 'x'.repeat(20_000) };
    assert.equal(boundRaw(session), session);
    const slim = boundRaw(session, 5_000) as {
      truncated: boolean;
      originalChars: number;
      omittedRequests?: number;
      requests: Array<{ message: { text: string }; response: string }>;
    };
    assert.equal(slim.truncated, true);
    assert.equal(slim.originalChars, JSON.stringify(session).length);
    assert.equal(slim.omittedRequests, undefined);
    assert.equal(slim.requests.length, 2);
    assert.equal(slim.requests[0].message.text, 'How do I   run\nthe tests?');
    assert.equal(slim.requests[0].response, 'Run the suite with package.json scripts.\n\nAll tests pass.');
    assert.ok(JSON.stringify(slim).length <= 5_000);
    const tiny = boundRaw(session, 2_050) as { omittedRequests?: number; requests: unknown[] };
    assert.equal(tiny.requests.length, 0);
    assert.equal(tiny.omittedRequests, 2);
  });

  test('renders system-initiated requests, subagents and unknown tools', () => {
    const messages = buildTranscriptMessages({
      requests: [
        {
          isSystemInitiated: true,
          message: { text: 'Continue the task' },
          response: [
            { kind: 'toolInvocationSerialized', toolSpecificData: { kind: 'subagent', description: 'Review the diff' } },
            { kind: 'toolInvocationSerialized', toolId: 'mystery_tool' },
            { kind: 'toolInvocationSerialized', toolId: 'mystery_tool' },
            { kind: 'progressMessage', content: { value: 'Working…' } },
            { kind: 'markdownContent', content: { value: 'Done ' } },
            { kind: 'inlineReference', inlineReference: { name: 'parseItemId', kind: 12 } },
            'and more.',
          ],
        },
      ],
    });
    assert.deepEqual(roles(messages), [
      ['system', 'Continue the task'],
      ['tool', 'Subagent: Review the diff'],
      ['tool', 'Used tool mystery_tool'],
      ['assistant', 'Done `parseItemId`and more.'],
    ]);
  });
});

// ---- delete / restore ----------------------------------------------------------------------

describe('VsCodeProvider trash', () => {
  test('moves chats to the trash and restores them (files, companions and index entries)', async () => {
    const fx = makeFixture();
    const provider = providerFor(fx);
    const items = await provider.list();
    const jsonl = byId(items, JSONL_ITEM);
    const ew = byId(items, EW_ITEM);
    const bytes = new Map([fx.files.jsonl, fx.files.emptyWindow, ...fx.companions].map((f) => [f, fs.readFileSync(f)]));
    const wsIndexBefore = indexOf(fx.wsDb);
    const globalIndexBefore = indexOf(fx.globalDb);
    assert.ok(wsIndexBefore && globalIndexBefore);

    const progress: string[] = [];
    const results = await provider.deleteItems([jsonl, ew], (_d, _t, message) => progress.push(message));
    assert.deepEqual(
      results.map((r) => [r.id, r.ok, r.error]),
      [
        [JSONL_ITEM, true, undefined],
        [EW_ITEM, true, undefined],
      ],
    );
    assert.equal(results[0].detail, 'Moved to the organizer trash');
    assert.equal(progress.at(-1), 'Moved 2 of 2 chats to the trash');

    // Files and per-chat data left VS Code's folders; everything else stayed.
    for (const f of [fx.files.jsonl, fx.files.emptyWindow, ...fx.companions]) assert.equal(fs.existsSync(f), false, f);
    for (const f of [fx.files.json, fx.files.empty, fx.files.titled, fx.otherCompanion]) assert.equal(fs.existsSync(f), true, f);
    const wsIndex = indexOf(fx.wsDb);
    assert.ok(wsIndex);
    assert.deepEqual(Object.keys(wsIndex.entries).sort(), [JSON_ID, EMPTY_ID, EXTERNAL_ID].sort());
    assert.equal(wsIndex.version, 1);
    assert.deepEqual(indexOf(fx.globalDb)?.entries, {});
    assert.equal(readRow(fx.wsDb, UNRELATED_KEY), UNRELATED_VALUE);
    assert.equal(readRow(fx.globalDb, UNRELATED_KEY), UNRELATED_VALUE);

    // Trash layout and metadata.
    const trashDir = path.join(fx.ctx.trashDir, safeName(JSONL_ITEM));
    assert.ok(fs.existsSync(path.join(trashDir, `${JSONL_ID}.jsonl`)));
    const meta = JSON.parse(fs.readFileSync(path.join(trashDir, 'meta.json'), 'utf8')) as JsonObject;
    assert.equal(meta.id, JSONL_ITEM);
    assert.equal(meta.kind, 'vscode-chat');
    assert.equal(meta.title, 'Custom JSONL title');
    assert.equal(meta.location, 'C:\\src\\demo app');
    assert.equal(meta.complete, true);
    assert.equal(typeof meta.deletedAt, 'string');
    assert.deepEqual(meta.files, [{ original: fx.files.jsonl, name: `${JSONL_ID}.jsonl` }]);
    assert.deepEqual(meta.indexEntries, [
      { db: fx.wsDb, key: CHAT_INDEX_KEY, entry: wsIndexBefore.entries[JSONL_ID], indexVersion: 1 },
    ]);
    assert.equal((meta.companions as unknown[]).length, 2);

    // The chats leave the listing and show up in the trash, where they can still be read.
    assert.deepEqual(
      (await provider.list()).map((i) => i.id),
      [INS_ITEM, TITLED_ITEM, JSON_ITEM],
    );
    const trash = await provider.listTrash();
    assert.deepEqual(trash.map((i) => i.id).sort(), [EW_ITEM, JSONL_ITEM].sort());
    for (const t of trash) {
      assert.equal(t.status, 'In trash');
      assert.equal(t.deleteMode, 'none');
      assert.equal(t.kind, 'vscode-chat');
      assert.equal(t.note, undefined);
      assert.equal(typeof t.extra?.deletedAt, 'string');
    }
    assert.equal(byId(trash, EW_ITEM).title, 'Quick question about regex');
    assert.equal(byId(trash, EW_ITEM).location, 'Empty window');
    const fromTrash = await provider.getTranscript(jsonl);
    assert.deepEqual(roles(fromTrash.messages), JSONL_TRANSCRIPT);
    assert.match(fromTrash.note ?? '', /trash/);
    const again = await provider.deleteItems([jsonl]);
    assert.equal(again[0].ok, false);

    // Restore puts back the exact bytes and index entries and empties the trash.
    const restored = await provider.restoreItems([JSONL_ITEM, EW_ITEM]);
    assert.deepEqual(
      restored.map((r) => [r.id, r.ok, r.error, r.detail]),
      [
        [JSONL_ITEM, true, undefined, 'Restored to VS Code'],
        [EW_ITEM, true, undefined, 'Restored to VS Code'],
      ],
    );
    for (const [f, content] of bytes) assert.deepEqual(fs.readFileSync(f), content, f);
    assert.deepEqual(indexOf(fx.wsDb)?.entries[JSONL_ID], wsIndexBefore.entries[JSONL_ID]);
    assert.deepEqual(indexOf(fx.wsDb)?.entries, wsIndexBefore.entries);
    assert.deepEqual(indexOf(fx.globalDb), globalIndexBefore);
    assert.equal(readRow(fx.wsDb, UNRELATED_KEY), UNRELATED_VALUE);
    assert.deepEqual(await provider.listTrash(), []);
    assert.deepEqual(fs.readdirSync(fx.ctx.trashDir), []);
    assert.equal((await provider.list()).length, 5);
  });

  test('refuses to delete while that edition of VS Code is running', async () => {
    const fx = makeFixture();
    let stableRunning = false;
    const provider = providerFor(fx, (e) => e === 'insiders' || stableRunning);
    const items = await provider.list();
    const before = indexOf(fx.insidersDb);

    const insiders = await provider.deleteItems([byId(items, INS_ITEM)]);
    assert.equal(insiders[0].ok, false);
    assert.equal(insiders[0].error, 'Close VS Code first');
    assert.ok(fs.existsSync(fx.files.insiders));
    assert.deepEqual(indexOf(fx.insidersDb), before);

    // Listed while closed, started before the delete: re-checked at delete time.
    const json = byId(items, JSON_ITEM);
    assert.equal(json.deleteMode, 'trash');
    stableRunning = true;
    const stable = await provider.deleteItems([json]);
    assert.equal(stable[0].error, 'Close VS Code first');
    assert.ok(fs.existsSync(fx.files.json));
    assert.ok(indexOf(fx.wsDb)?.entries[JSON_ID]);
    assert.equal(fs.existsSync(fx.ctx.trashDir), false);

    // Restoring is refused the same way.
    stableRunning = false;
    assert.equal((await provider.deleteItems([json]))[0].ok, true);
    stableRunning = true;
    const restore = await provider.restoreItems([JSON_ITEM]);
    assert.equal(restore[0].error, 'Close VS Code first');
    assert.equal(fs.existsSync(fx.files.json), false);
    stableRunning = false;
    assert.equal((await provider.restoreItems([JSON_ITEM]))[0].ok, true);
    assert.ok(fs.existsSync(fx.files.json));
  });

  test('restore refuses to overwrite and re-creates a missing index key', async () => {
    const fx = makeFixture();
    const provider = providerFor(fx);
    const json = byId(await provider.list(), JSON_ITEM);
    const original = fs.readFileSync(fx.files.json);
    const entry = indexOf(fx.wsDb)?.entries[JSON_ID];
    assert.equal((await provider.deleteItems([json]))[0].ok, true);
    assert.equal(fs.existsSync(fx.otherCompanion), false); // its editing session moved along

    write(fx.files.json, '{"sessionId":"someone else"}');
    const conflict = await provider.restoreItems([JSON_ITEM]);
    assert.equal(conflict[0].ok, false);
    assert.equal(conflict[0].error, 'A chat with this id already exists in VS Code');
    assert.equal(indexOf(fx.wsDb)?.entries[JSON_ID], undefined);
    assert.equal((await provider.listTrash()).length, 1);

    fs.rmSync(fx.files.json);
    deleteRow(fx.wsDb, CHAT_INDEX_KEY); // VS Code may rewrite or drop the index meanwhile
    const ok = await provider.restoreItems([JSON_ITEM]);
    assert.equal(ok[0].ok, true, ok[0].error ?? 'restore failed');
    assert.deepEqual(fs.readFileSync(fx.files.json), original);
    assert.deepEqual(indexOf(fx.wsDb), { version: 1, entries: { [JSON_ID]: entry } });
    assert.ok(fs.existsSync(fx.otherCompanion));
    assert.deepEqual(await provider.listTrash(), []);
  });

  test('reports per-item errors for bad requests without throwing', async () => {
    const fx = makeFixture();
    const provider = providerFor(fx);
    const items = await provider.list();
    const json = byId(items, JSON_ITEM);
    const results = await provider.deleteItems([
      { ...json, id: 'stable:..:x' },
      { ...json, id: 'nope' },
      { ...json, id: `beta:${WS_HASH}:${JSON_ID}` },
      { ...json, source: 'm365' },
      { ...json, id: `stable:${WS_HASH}:missing-session` },
    ]);
    assert.deepEqual(
      results.map((r) => r.error),
      [
        'Invalid VS Code chat id',
        'Invalid VS Code chat id',
        'VS Code (beta) is not configured',
        'Not a VS Code chat',
        'Chat file not found; it may already be deleted',
      ],
    );
    const restore = await provider.restoreItems([JSON_ITEM, 'nope', '../../etc']);
    assert.deepEqual(
      restore.map((r) => r.error),
      ['Not in the trash', 'Invalid VS Code chat id', 'Invalid VS Code chat id'],
    );
    assert.ok(fs.existsSync(fx.files.json));
    assert.equal(fs.existsSync(fx.ctx.trashDir), false);
  });

  test('restore rejects tampered trash metadata', async () => {
    const fx = makeFixture();
    const provider = providerFor(fx);
    assert.equal((await provider.deleteItems([byId(await provider.list(), JSONL_ITEM)]))[0].ok, true);
    const metaFile = path.join(fx.ctx.trashDir, safeName(JSONL_ITEM), 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JsonObject;
    const tamper = async (patch: JsonObject, error: string): Promise<void> => {
      fs.writeFileSync(metaFile, JSON.stringify({ ...meta, ...patch }));
      const [r] = await provider.restoreItems([JSONL_ITEM]);
      assert.equal(r.ok, false);
      assert.equal(r.error, error);
    };
    await tamper({ files: [{ original: 'x', name: '../../evil.jsonl' }] }, 'Invalid trash metadata');
    await tamper({ indexEntries: [{ db: path.join(fx.base, 'other.vscdb'), key: CHAT_INDEX_KEY, entry: {} }] }, 'Invalid trash metadata');
    await tamper({ companions: [{ original: path.join(fx.base, 'outside.txt'), trashed: 'companions/x' }] }, 'Invalid trash metadata');
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    assert.equal((await provider.restoreItems([JSONL_ITEM]))[0].ok, true);
    assert.equal(fs.existsSync(path.join(fx.base, 'outside.txt')), false);
  });
});

// ---- session files -----------------------------------------------------------------------------

describe('VS Code session files', () => {
  test('applyMutation implements set, push, truncate and delete', () => {
    let state = applyMutation(undefined, { kind: 0, v: { a: 1, list: [1, 2, 3] } }) as JsonObject;
    assert.deepEqual(state, { a: 1, list: [1, 2, 3] });
    state = applyMutation(state, { kind: 1, k: ['deep', 0, 'x'], v: 'y' }) as JsonObject;
    assert.deepEqual(state.deep, [{ x: 'y' }]);
    applyMutation(state, { kind: 2, k: ['list'], v: [9], i: 1 });
    assert.deepEqual(state.list, [1, 9]);
    applyMutation(state, { kind: 2, k: ['list'], v: [7], i: 5 }); // i beyond the end only appends
    assert.deepEqual(state.list, [1, 9, 7]);
    applyMutation(state, { kind: 2, k: ['fresh'], v: ['a'] });
    assert.deepEqual(state.fresh, ['a']);
    applyMutation(state, { kind: 3, k: ['list', 0] });
    assert.deepEqual(state.list, [9, 7]);
    applyMutation(state, { kind: 3, k: ['a'] });
    assert.equal('a' in state, false);
    applyMutation(state, { kind: 3, k: ['missing', 'path'] });
    applyMutation(state, { kind: 99, k: ['a'], v: 1 });
    assert.deepEqual(applyMutation(state, { kind: 1, k: [], v: { replaced: true } }), { replaced: true });
  });

  test('applyMutation never writes to prototypes', () => {
    const state: JsonObject = {};
    applyMutation(state, { kind: 1, k: ['__proto__', 'polluted'], v: true });
    applyMutation(state, { kind: 1, k: ['constructor', 'prototype', 'polluted'], v: true });
    applyMutation(state, { kind: 2, k: ['__proto__'], v: [1] });
    applyMutation(state, { kind: 1, k: ['x', '__proto__'], v: { polluted: true } });
    assert.equal(({} as JsonObject).polluted, undefined);
    assert.equal(Object.getPrototypeOf(state), Object.prototype);
  });

  test('fast summaries match full reconstruction', async () => {
    const fx = makeFixture();
    for (const file of [fx.files.json, fx.files.jsonl, fx.files.emptyWindow, fx.files.empty]) {
      const full = await readSessionFile(file);
      assert.deepEqual(await summarizeSessionFile(file), summarize(full.session), file);
    }
    const summary = await summarizeSessionFile(fx.files.jsonl);
    assert.equal(summary.customTitle, 'Custom JSONL title');
    assert.equal(summary.requestCount, 2);
    assert.equal(summary.firstRequestText, 'Explain the build');
    assert.equal(summary.lastRequestAt, T0 + 200_000);
  });

  test('reads CRLF logs with a BOM, torn lines and lines larger than the read chunk', async () => {
    const base = makeTempDir();
    const crlf = path.join(base, 'crlf.jsonl');
    write(crlf, `\uFEFF${toJsonl(jsonlEntries(), '\r\n')}`);
    const loaded = await readSessionFile(crlf);
    assert.equal(loaded.partial, false);
    assert.deepEqual(roles(buildTranscriptMessages(loaded.session)), JSONL_TRANSCRIPT);
    assert.equal((await summarizeSessionFile(crlf)).customTitle, 'Custom JSONL title');

    const torn = path.join(base, 'torn.jsonl');
    write(torn, `${toJsonl(jsonlEntries())}{"kind":1,"k":["customTitle"],"v":"Half`);
    assert.equal((await readSessionFile(torn)).partial, true);
    const tornSummary = await summarizeSessionFile(torn);
    assert.equal(tornSummary.partial, true);
    assert.equal(tornSummary.customTitle, 'Custom JSONL title');

    const big = path.join(base, 'big.jsonl');
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const entries = jsonlEntries();
    entries.splice(5, 0, { kind: 2, k: ['requests', 0, 'response'], v: [{ value: huge }] });
    write(big, toJsonl(entries));
    const bigSession = await readSessionFile(big);
    assert.equal(bigSession.partial, false);
    assert.deepEqual(roles(buildTranscriptMessages(bigSession.session)), JSONL_TRANSCRIPT);
    assert.deepEqual(await summarizeSessionFile(big), summarize(bigSession.session));

    const noState = path.join(base, 'nostate.jsonl');
    write(noState, '{"kind":1,"k":["customTitle"],"v":"x"}\n');
    await assert.rejects(readSessionFile(noState), /no initial state/);
    write(path.join(base, 'array.json'), '[]');
    await assert.rejects(readSessionFile(path.join(base, 'array.json')), /not a JSON object/);
  });
});

// ---- chat index ----------------------------------------------------------------------------------

describe('VS Code chat index', () => {
  test('reads, removes and re-adds entries and keeps the value type', () => {
    const base = makeTempDir();
    const db = path.join(base, 'state.vscdb');
    const doc = { version: 1, entries: { a: { sessionId: 'a', title: 'A' }, b: { sessionId: 'b', title: 'B' } } };
    createStateDb(db, { [CHAT_INDEX_KEY]: new TextEncoder().encode(JSON.stringify(doc)), other: 'x' });
    assert.deepEqual(readChatIndex(db)?.entries.a, { sessionId: 'a', title: 'A' });
    assert.equal(readChatIndex(db)?.entries.constructor, undefined);

    assert.deepEqual(removeIndexEntry(db, 'a'), { sessionId: 'a', title: 'A' });
    assert.equal(removeIndexEntry(db, 'a'), undefined);
    assert.equal(removeIndexEntry(db, '__proto__'), undefined);
    assert.ok(readRow(db, CHAT_INDEX_KEY) instanceof Uint8Array);
    assert.deepEqual(indexOf(db), { version: 1, entries: { b: { sessionId: 'b', title: 'B' } } });

    assert.equal(putIndexEntry(db, 'a', { sessionId: 'a', title: 'A' }), undefined);
    assert.deepEqual(putIndexEntry(db, 'b', { sessionId: 'b', title: 'B2' }), { sessionId: 'b', title: 'B' });
    assert.deepEqual(indexOf(db)?.entries, { a: { sessionId: 'a', title: 'A' }, b: { sessionId: 'b', title: 'B2' } });
    assert.equal(readRow(db, 'other'), 'x');
    assert.throws(() => putIndexEntry(db, 'constructor', {}), /invalid session id/);
  });

  test('never creates databases and never overwrites an unreadable index', () => {
    const base = makeTempDir();
    const missing = path.join(base, 'missing.vscdb');
    assert.equal(readChatIndex(missing), undefined);
    assert.throws(() => removeIndexEntry(missing, 'a'), /not found/);
    assert.throws(() => putIndexEntry(missing, 'a', {}), /not found/);
    assert.equal(fs.existsSync(missing), false);

    const db = path.join(base, 'bad.vscdb');
    createStateDb(db, { [CHAT_INDEX_KEY]: '{oops' });
    assert.equal(readChatIndex(db), undefined);
    assert.throws(() => putIndexEntry(db, 'a', {}), /not valid JSON/);
    assert.equal(readRow(db, CHAT_INDEX_KEY), '{oops');

    const empty = path.join(base, 'empty.vscdb');
    createStateDb(empty, {});
    assert.equal(readChatIndex(empty), undefined);
    assert.equal(removeIndexEntry(empty, 'a'), undefined);
    assert.equal(readRow(empty, CHAT_INDEX_KEY), undefined);
    putIndexEntry(empty, 'a', { sessionId: 'a' }, 1);
    assert.deepEqual(indexOf(empty), { version: 1, entries: { a: { sessionId: 'a' } } });
  });
});

// ---- process detection ---------------------------------------------------------------------------

describe('VS Code process detection', () => {
  test('parses tasklist output and matches executables per platform', () => {
    const csv = '"System Idle Process","0","Services","0","8 K"\r\n"Code.exe","1234","Console","1","123,456 K"\r\n\r\n"Code - Insiders.exe","99","Console","1","1 K"\r\n';
    assert.deepEqual(parseTasklistCsv(csv), ['System Idle Process', 'Code.exe', 'Code - Insiders.exe']);
    assert.deepEqual(executableNames('stable', 'win32'), ['code.exe']);
    assert.deepEqual(executableNames('Insiders', 'win32'), ['code - insiders.exe']);
    assert.equal(editionIsRunning(new Set(['code.exe']), 'stable', 'win32'), true);
    assert.equal(editionIsRunning(new Set(['code.exe']), 'insiders', 'win32'), false);
    assert.equal(editionIsRunning(new Set(['code - insiders.exe']), 'insiders', 'win32'), true);
    assert.equal(editionIsRunning(new Set(['vscode.exe', 'code.exe.bak']), 'stable', 'win32'), false);
    const mac = new Set(['/applications/visual studio code.app/contents/macos/electron']);
    assert.equal(editionIsRunning(mac, 'stable', 'darwin'), true);
    assert.equal(editionIsRunning(mac, 'insiders', 'darwin'), false);
    assert.equal(editionIsRunning(new Set(['code']), 'stable', 'linux'), true);
    assert.equal(editionIsRunning(new Set(['code-insiders']), 'insiders', 'linux'), true);
    assert.equal(editionIsRunning(new Set(['code-exploratio']), 'exploration', 'linux'), true);
    assert.equal(editionIsRunning(new Set(['code-insiders']), 'stable', 'linux'), false);
  });

  test('caches the process list, refreshes on demand and assumes running on failure', async () => {
    let calls = 0;
    let names = ['Code.exe', 'explorer.exe'];
    const detector = new ProcessDetector({ platform: 'win32', ttlMs: 60_000, listProcesses: async () => (calls++, names) });
    const [a, b] = await Promise.all([detector.isRunning('stable'), detector.isRunning('insiders')]);
    assert.deepEqual([a, b, calls], [true, false, 1]);
    names = ['explorer.exe'];
    assert.equal(await detector.isRunning('stable'), true); // cached
    assert.equal(calls, 1);
    assert.equal(await detector.isRunning('stable', true), false); // fresh
    assert.equal(calls, 2);

    const logs: string[] = [];
    const failing = new ProcessDetector({
      platform: 'win32',
      log: (m) => logs.push(m),
      listProcesses: async () => {
        throw new Error('tasklist unavailable');
      },
    });
    assert.equal(await failing.isRunning('stable'), true);
    assert.match(logs[0] ?? '', /tasklist unavailable/);
  });

  test('the default detector answers on this machine', async () => {
    const running = await new ProcessDetector().isRunning('stable');
    assert.equal(typeof running, 'boolean');
  });
});

// ---- ids and paths -------------------------------------------------------------------------------

describe('VS Code ids and paths', () => {
  test('ids round-trip and reject unsafe segments', () => {
    assert.deepEqual(parseItemId(`stable:${WS_HASH}:${JSON_ID}`), { edition: 'stable', workspaceHash: WS_HASH, sessionId: JSON_ID });
    assert.deepEqual(parseItemId('insiders:empty-window:abc'), { edition: 'insiders', workspaceHash: 'empty-window', sessionId: 'abc' });
    for (const bad of ['', 'nope', 'a:b', 'a:b:c:d', 'stable:..:x', 'stable:abc:..', 'stable:a/b:c', 'stable:a\\b:c', 'stable::c', ' stable:a:b']) {
      assert.equal(parseItemId(bad), undefined, bad);
    }
  });

  test('describes workspace URIs', () => {
    assert.equal(describeWorkspaceUri('file:///c%3A/src/demo%20app'), 'C:\\src\\demo app');
    assert.equal(describeWorkspaceUri('file:///d%3A/work/proj.code-workspace'), 'D:\\work\\proj.code-workspace');
    assert.equal(describeWorkspaceUri('file://server/share/folder'), '\\\\server\\share\\folder');
    assert.equal(describeWorkspaceUri('file:///home/me/proj'), '/home/me/proj');
    assert.equal(describeWorkspaceUri('vscode-remote://ssh-remote%2Bmybox/home/me/proj'), 'ssh-remote+mybox:/home/me/proj');
    assert.equal(describeWorkspaceUri('vscode-vfs://github/owner/repo'), 'vscode-vfs://github/owner/repo');
    assert.equal(describeWorkspaceUri('not a uri'), 'not a uri');
  });

  test('isInside only accepts strict descendants', () => {
    const root = path.resolve('some', 'root');
    assert.equal(isInside(path.join(root, 'a', 'b'), [root]), true);
    assert.equal(isInside(root, [root]), false);
    assert.equal(isInside(path.join(root, '..', 'other'), [root]), false);
    assert.equal(isInside(path.join(root + '-sibling', 'x'), [root]), false);
  });
});

// ---- real data (read-only) ---------------------------------------------------------------------

describe('real VS Code data (read-only smoke test)', () => {
  test('lists and reads the chats on this machine', { timeout: 600_000 }, async (t) => {
    const roots = defaultRoots();
    if (!roots.length || process.env.SKIP_REAL_DATA_TESTS) {
      t.skip('no VS Code user data folder on this machine (or SKIP_REAL_DATA_TESTS is set)');
      return;
    }
    const ctx = makeContext(makeTempDir());
    // Only list() and getTranscript() are called; every edition also counts as running, so
    // this provider could not delete even if asked to.
    const provider = new VsCodeProvider(ctx, { roots, isRunning: async () => true });
    assert.equal((await provider.status()).available, true);

    let started = performance.now();
    const items = await provider.list();
    const listMs = performance.now() - started;
    started = performance.now();
    assert.equal((await provider.list()).length, items.length);
    const cachedMs = performance.now() - started;

    const counts = new Map<string, number>();
    let unreadable = 0;
    for (const item of items) {
      const key = `${String(item.extra?.edition)}/${String(item.extra?.format)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (item.title === 'Unreadable chat') unreadable++;
      assert.equal(item.deleteMode, 'none');
      assert.ok(parseItemId(item.id), item.id);
      assert.ok(item.title.length > 0 && item.title.length <= 140);
    }
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);

    started = performance.now();
    let messages = 0;
    let partial = 0;
    let failures = 0;
    for (const item of items) {
      try {
        const transcript = await provider.getTranscript(item);
        messages += transcript.messages.length;
        if (transcript.partial) partial++;
      } catch {
        failures++;
      }
    }
    const transcriptMs = performance.now() - started;
    t.diagnostic(`roots: ${roots.map((r) => r.edition).join(', ')}`);
    t.diagnostic(`chats: ${items.length} [${[...counts].map(([k, n]) => `${k}: ${n}`).join(', ')}], unreadable: ${unreadable}`);
    t.diagnostic(`list: ${listMs.toFixed(0)} ms (cached: ${cachedMs.toFixed(0)} ms)`);
    t.diagnostic(`transcripts: ${messages} messages, ${partial} partial, ${failures} failed, ${transcriptMs.toFixed(0)} ms`);
    assert.ok(failures <= unreadable, `${failures} transcripts failed`);
    assert.equal(fs.existsSync(ctx.trashDir), false);
  });
});
