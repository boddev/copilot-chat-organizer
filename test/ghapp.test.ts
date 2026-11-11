import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Conversation, ProviderContext } from '../src/core/types.ts';
import { safeName } from '../src/core/store.ts';
import { GhAppProvider } from '../src/providers/ghapp/index.ts';
import { readEventsHead, readEventsTranscript, scanEvents } from '../src/providers/ghapp/events.ts';
import { decodeValue, encodeValue } from '../src/providers/ghapp/storedb.ts';
import { readTopLevelScalars } from '../src/providers/ghapp/yaml.ts';

// Fixtures live under the repo's gitignored .data folder (not the OS temp folder).
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = path.join(REPO, '.data', 'test-tmp');

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S = {
  appChat: id(1),
  project: id(2),
  appCli: id(3),
  deleting: id(4),
  archived: id(5),
  workflow: id(6),
  aliasOnly: id(7),
  cli: id(10),
  inUse: id(11),
  eventsOnly: id(12),
  stale: id(13),
  noYaml: id(14),
  indexOnly: id(20),
};

const APP_DDL = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, session_type TEXT NOT NULL DEFAULT 'workspace', mode TEXT, model TEXT,
  is_running INTEGER NOT NULL DEFAULT 0, was_interrupted INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT,
  execution_location TEXT, title_source TEXT, archived_at TEXT, provisional INTEGER NOT NULL DEFAULT 0);
CREATE TABLE session_deletion_intents (session_id TEXT PRIMARY KEY, created_at TEXT);
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, container_kind TEXT, main_repo_path TEXT NOT NULL UNIQUE,
  default_branch TEXT, github_owner TEXT, github_repo TEXT);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT, workspace_type TEXT, branch TEXT, name TEXT, created_at TEXT,
  updated_at TEXT, archived_at TEXT, session_id TEXT, source_pr_html_url TEXT, source_pr_title TEXT, created_pr_html_url TEXT);
CREATE TABLE workspace_session_aliases (session_id TEXT PRIMARY KEY, workspace_id TEXT, created_at TEXT);
CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, prompt TEXT, project_id TEXT);
CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, task_id TEXT, status TEXT, trigger TEXT, workspace_id TEXT, session_id TEXT,
  started_at TEXT, completed_at TEXT, archived_at TEXT);
`;

// Same schema as the Copilot CLI's session-store.db (subset of columns for the usage table).
const STORE_DDL = `
CREATE TABLE schema_version (version INTEGER);
CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT, summary TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), host_type TEXT);
CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), turn_index INTEGER NOT NULL,
  user_message TEXT, assistant_response TEXT, timestamp TEXT DEFAULT (datetime('now')), UNIQUE(session_id, turn_index));
CREATE TABLE checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
  checkpoint_number INTEGER NOT NULL, title TEXT, overview TEXT, history TEXT, work_done TEXT, technical_details TEXT,
  important_files TEXT, next_steps TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(session_id, checkpoint_number));
CREATE TABLE session_files (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
  file_path TEXT NOT NULL, tool_name TEXT, turn_index INTEGER, first_seen_at TEXT DEFAULT (datetime('now')), UNIQUE(session_id, file_path));
CREATE TABLE session_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
  ref_type TEXT NOT NULL, ref_value TEXT NOT NULL, turn_index INTEGER, created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, ref_type, ref_value));
CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_index INTEGER, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, request_multiplier REAL,
  created_at TEXT DEFAULT (datetime('now')), output_ttft_ms REAL);
CREATE TABLE dynamic_context_items (id INTEGER PRIMARY KEY, content TEXT);
CREATE VIRTUAL TABLE search_index USING fts5(content, session_id UNINDEXED, source_type UNINDEXED, source_id UNINDEXED);
`;

const T0 = '2026-10-01T09:00:00.000Z';

function ev(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}, at = '2026-11-01T10:00:00.000Z'): string {
  return JSON.stringify({ type, data, id: crypto.randomUUID(), timestamp: at, parentId: null, ...extra });
}

interface Fixture {
  root: string;
  home: string;
  ctx: ProviderContext;
  appDb: string;
  storeDb: string;
  stateDir: string;
}

function makeFixture(root: string): Fixture {
  const home = path.join(root, 'home');
  const stateDir = path.join(home, 'session-state');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(stateDir, { recursive: true });
  const ctx: ProviderContext = { dataDir, trashDir: path.join(dataDir, 'trash', 'ghapp'), log: () => {} };

  // ---- data.db -----------------------------------------------------------------------
  const appDb = path.join(home, 'data.db');
  const app = new DatabaseSync(appDb);
  app.exec('PRAGMA journal_mode = WAL');
  app.exec(APP_DDL);
  const addSession = app.prepare(
    `INSERT INTO sessions (id, title, session_type, created_at, updated_at, archived_at, title_source, is_running, execution_location)
     VALUES (?, ?, ?, ?, ?, ?, 'auto', 0, 'local')`,
  );
  addSession.run(S.appChat, 'Planning chat', 'general_chat', '2026-11-01T08:00:00.000Z', '2026-11-01T09:00:00.000Z', null);
  addSession.run(S.project, '', 'project', '2026-11-02T08:00:00.000Z', '2026-11-02T09:00:00.000Z', null);
  addSession.run(S.appCli, 'Imported CLI run', 'cli_session', '2026-09-01T08:00:00.000Z', '2026-09-01T09:00:00.000Z', null);
  addSession.run(S.deleting, 'Being deleted', 'general_chat', '2026-09-01T08:00:00.000Z', '2026-09-01T09:00:00.000Z', null);
  addSession.run(S.archived, 'Old chat', 'general_chat', '2026-08-01T08:00:00.000Z', '2026-08-01T09:00:00.000Z', '2026-08-20T00:00:00.000Z');
  addSession.run(S.workflow, null, 'workflow_workspace', '2026-10-05T08:00:00.000Z', '2026-10-05T09:00:00.000Z', null);
  app.prepare('INSERT INTO session_deletion_intents (session_id, created_at) VALUES (?, ?)').run(S.deleting, T0);
  app.prepare(
    `INSERT INTO projects (id, name, container_kind, main_repo_path, default_branch, github_owner, github_repo)
     VALUES ('proj-1', 'widgets', 'repository', 'C:\\src\\widgets', 'main', 'octo', 'widgets')`,
  ).run();
  const addWs = app.prepare(
    `INSERT INTO workspaces (id, project_id, workspace_type, branch, name, updated_at, archived_at, session_id, source_pr_html_url, source_pr_title)
     VALUES (?, 'proj-1', 'worktree', ?, ?, ?, ?, ?, ?, ?)`,
  );
  addWs.run('ws-old', 'old/attempt', 'Old attempt', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z', S.project, null, null);
  addWs.run('ws-1', 'fix/login', 'Fix login bug', '2026-11-02T09:00:00.000Z', null, S.project, 'https://github.com/octo/widgets/pull/7', 'Login fix');
  app.prepare(`INSERT INTO workspace_session_aliases (session_id, workspace_id, created_at) VALUES (?, 'ws-1', ?)`).run(S.aliasOnly, T0);
  app.prepare(`INSERT INTO workflows (id, name, prompt) VALUES ('wf-1', 'Nightly triage', 'triage issues')`).run();
  app.prepare(`INSERT INTO workflow_runs (id, task_id, status, session_id) VALUES ('run-1', 'wf-1', 'completed', ?)`).run(S.workflow);
  app.close();

  // ---- session-store.db --------------------------------------------------------------
  const storeDb = path.join(home, 'session-store.db');
  const store = new DatabaseSync(storeDb);
  store.exec('PRAGMA journal_mode = WAL');
  store.exec(STORE_DDL);
  store.exec('INSERT INTO schema_version (version) VALUES (8)');
  const addStore = store.prepare(
    'INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const addTurn = store.prepare('INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)');
  const addFts = store.prepare('INSERT INTO search_index (content, session_id, source_type, source_id) VALUES (?, ?, ?, ?)');
  addStore.run(S.cli, 'C:\\src\\parser', 'octo/parser', 'main', 'Store summary for parser', T0, '2026-10-01T09:30:00.000Z', 'github');
  addTurn.run(S.cli, 0, '<context>today</context> Please refactor the parser', 'Refactored the parser.', '2026-10-01T09:05:00.000Z');
  addTurn.run(S.cli, 1, 'Add tests', 'Added tests.', '2026-10-01T09:30:00.000Z');
  store
    .prepare('INSERT INTO checkpoints (session_id, checkpoint_number, title, overview, created_at) VALUES (?, 1, ?, ?, ?)')
    .run(S.cli, 'Parser refactor', 'Split the parser into modules', '2026-10-01T09:20:00.000Z');
  store.prepare(`INSERT INTO session_files (session_id, file_path, tool_name, turn_index) VALUES (?, 'src/parser.ts', 'edit', 0)`).run(S.cli);
  store
    .prepare(
      `INSERT INTO assistant_usage_events (session_id, turn_index, model, input_tokens, output_tokens, request_multiplier, output_ttft_ms)
       VALUES (?, 0, 'model-x', 100, 50, 1.0, 123.5)`,
    )
    .run(S.cli);
  addFts.run('Please refactor the parser', S.cli, 'turn', 1n);
  addFts.run('Parser refactor checkpoint', S.cli, 'checkpoint', 'cp-1');
  addStore.run(S.indexOnly, 'C:\\src\\old', null, null, 'Old index-only session', '2026-07-01T09:00:00.000Z', '2026-07-01T09:10:00.000Z', null);
  addTurn.run(S.indexOnly, 0, 'old question', 'old answer', '2026-07-01T09:05:00.000Z');
  addFts.run('old question about zebras', S.indexOnly, 'turn', 5n);
  addStore.run(S.appCli, 'C:\\src\\tools', 'octo/tools', 'main', 'tools run', '2026-09-01T08:00:00.000Z', '2026-09-01T09:00:00.000Z', 'github');
  for (let i = 0; i < 3; i++) addTurn.run(S.appCli, i, `q${i}`, `a${i}`, `2026-09-01T08:0${i}:00.000Z`);
  addStore.run(S.stale, 'C:\\src\\stale', 'octo/stale', 'main', 'Stale store summary', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'github');
  addTurn.run(S.stale, 0, 'Old question', 'Old answer', '2026-01-01T00:00:00.000Z');
  store.close();

  // ---- session-state -----------------------------------------------------------------
  const dir = (sid: string) => {
    const d = path.join(stateDir, sid);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const chatCwd = path.join(home, 'chats', '2026-11-01', 'plan-abc');
  fs.writeFileSync(
    path.join(dir(S.appChat), 'workspace.yaml'),
    `id: ${S.appChat}\ncwd: ${chatCwd}\nrepository: boddev/copilot-config\nclient_name: github/cli\n`,
  );
  fs.writeFileSync(
    path.join(dir(S.appCli), 'workspace.yaml'),
    `id: ${S.appCli}\ncwd: C:\\src\\tools\nrepository: octo/tools\nbranch: main\nclient_name: github/cli\n`,
  );
  fs.writeFileSync(path.join(dir(S.deleting), 'workspace.yaml'), `id: ${S.deleting}\n`);
  fs.writeFileSync(path.join(dir(S.aliasOnly), 'workspace.yaml'), `id: ${S.aliasOnly}\nsummary: alias session\n`);

  const cliDir = dir(S.cli);
  fs.writeFileSync(
    path.join(cliDir, 'workspace.yaml'),
    [
      `id: ${S.cli}`,
      'cwd: C:\\src\\parser',
      'git_root: C:\\src\\parser',
      'repository: octo/parser',
      'host_type: github',
      'branch: main',
      'client_name: github/cli',
      'name: |-',
      '  Refactor the parser',
      '  module',
      'user_named: true',
      "summary: 'Parser work'",
      `created_at: ${T0}`,
      'updated_at: 2026-10-01T09:31:00.000Z',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(cliDir, 'events.jsonl'), `${ev('session.start', { sessionId: S.cli })}\n`);
  fs.utimesSync(path.join(cliDir, 'events.jsonl'), new Date('2026-10-01T09:31:00.000Z'), new Date('2026-10-01T09:31:00.000Z'));
  fs.writeFileSync(path.join(cliDir, 'inuse.999999999.lock'), '');
  fs.mkdirSync(path.join(cliDir, 'files'));
  fs.writeFileSync(path.join(cliDir, 'files', 'notes.md'), 'notes');
  fs.mkdirSync(path.join(cliDir, 'checkpoints'));
  fs.writeFileSync(path.join(cliDir, 'checkpoints', 'index.md'), '# checkpoints');

  const busy = dir(S.inUse);
  fs.writeFileSync(path.join(busy, 'workspace.yaml'), `id: ${S.inUse}\nname: "Busy \\"session\\""\ncwd: C:\\src\\busy\n`);
  fs.writeFileSync(path.join(busy, `inuse.${process.pid}.lock`), String(process.pid));

  const evDir = dir(S.eventsOnly);
  fs.writeFileSync(path.join(evDir, 'workspace.yaml'), `id: ${S.eventsOnly}\ncwd: '"C:\\src\\events"'\nclient_name: github/autopilot\n`);
  fs.writeFileSync(path.join(evDir, 'events.jsonl'), eventsOnlyLog());

  const staleDir = dir(S.stale);
  fs.writeFileSync(path.join(staleDir, 'workspace.yaml'), `id: ${S.stale}\nsummary: Stale summary\nrepository: octo/stale\n`);
  fs.writeFileSync(
    path.join(staleDir, 'events.jsonl'),
    [
      ev('user.message', { content: 'Old question' }, {}, '2026-01-01T00:00:00.000Z'),
      ev('assistant.message', { messageId: 'o1', content: 'Old answer' }, {}, '2026-01-01T00:00:01.000Z'),
      ev('user.message', { content: 'New question' }, {}, '2026-11-01T00:00:00.000Z'),
      ev('assistant.message', { messageId: 'n1', content: 'New answer' }, {}, '2026-11-01T00:00:01.000Z'),
      '',
    ].join('\n'),
  );

  fs.mkdirSync(path.join(dir(S.noYaml), 'files'));
  // Not sessions: hidden lock folder, optimistic placeholders and probe folders.
  fs.mkdirSync(path.join(stateDir, '.session-operation-locks'));
  fs.writeFileSync(path.join(stateDir, '.session-operation-locks', `${S.cli}.lock`), '');
  fs.mkdirSync(path.join(stateDir, 'optimistic-chat-123', 'files'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'pdf-critic-probe'));
  fs.writeFileSync(path.join(stateDir, 'pdf-critic-probe', 'probe.js'), '');

  return { root, home, ctx, appDb, storeDb, stateDir };
}

function eventsOnlyLog(): string {
  return [
    ev('session.start', { sessionId: S.eventsOnly, version: 1 }),
    ev('user.message', { content: 'Hello there', transformedContent: '<x>Hello there</x>' }, {}, '2026-11-01T10:00:00.000Z'),
    ev('user.message', { content: 'Injected skill text', source: 'skill-pdf' }),
    ev('assistant.turn_start', { turnId: '0' }),
    ev('assistant.message', { messageId: 'm1', content: 'Part one, ', chunkIndex: 0 }, {}, '2026-11-01T10:00:05.000Z'),
    ev('assistant.message', { messageId: 'm1', content: 'part two.', chunkIndex: 1 }),
    ev('tool.execution_complete', { toolCallId: 'c1', result: { content: 'x'.repeat(6000) } }),
    ev('user.message', { content: 'Sub-agent prompt' }, { agentId: 'agent-1' }),
    ev('assistant.message', { messageId: 'm2', content: 'Sub-agent answer', parentToolCallId: 'c2' }),
    ev('assistant.message', { messageId: 'm3', content: '', toolRequests: [{ name: 'view' }] }),
    ev('user.message', { content: 'Continue autonomously', source: 'autopilot' }),
    ev('user.message', { content: 'Thanks!' }, {}, '2026-11-01T10:01:00.000Z'),
    ev('assistant.message', { messageId: 'm4', content: 'You are welcome.' }, {}, '2026-11-01T10:01:05.000Z'),
    ev('abort', { reason: 'user' }),
    // The last line has no trailing newline.
    ev('session.error', { errorType: 'network', message: 'boom' }),
  ].join('\n');
}

const EXPECTED_EVENTS_TRANSCRIPT = [
  { role: 'user', text: 'Hello there', at: '2026-11-01T10:00:00.000Z' },
  { role: 'assistant', text: 'Part one, part two.', at: '2026-11-01T10:00:05.000Z' },
  { role: 'system', text: 'Continue autonomously', at: '2026-11-01T10:00:00.000Z' },
  { role: 'user', text: 'Thanks!', at: '2026-11-01T10:01:00.000Z' },
  { role: 'assistant', text: 'You are welcome.', at: '2026-11-01T10:01:05.000Z' },
  { role: 'status', text: 'Stopped: user', at: '2026-11-01T10:00:00.000Z' },
  { role: 'status', text: 'Error: boom', at: '2026-11-01T10:00:00.000Z' },
];

function sha1(file: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

/** Every row of a session in session-store.db, excluding FTS rowids. */
function storeRows(file: string, sid: string): Record<string, unknown[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out: Record<string, unknown[]> = {};
    for (const t of ['sessions', 'turns', 'checkpoints', 'session_files', 'session_refs', 'assistant_usage_events']) {
      const key = t === 'sessions' ? 'id' : 'session_id';
      const rows = db.prepare(`SELECT * FROM ${t} WHERE ${key} = ? ORDER BY rowid`).all(sid);
      const types = db
        .prepare(`SELECT ${t === 'assistant_usage_events' ? 'typeof(request_multiplier) AS a, typeof(output_ttft_ms) AS b' : "'' AS a"} FROM ${t} WHERE ${key} = ?`)
        .all(sid);
      out[t] = [...rows, ...types];
    }
    out.search_index = db
      .prepare('SELECT content, session_id, source_type, source_id, typeof(source_id) AS t FROM search_index WHERE session_id = ? ORDER BY content')
      .all(sid);
    return out;
  } finally {
    db.close();
  }
}

function ftsMatches(file: string, query: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare('SELECT session_id FROM search_index WHERE search_index MATCH ? ORDER BY session_id')
      .all(query)
      .map((r) => String(r.session_id));
  } finally {
    db.close();
  }
}

let root: string;
let fx: Fixture;
let provider: GhAppProvider;

before(() => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  root = fs.mkdtempSync(path.join(SCRATCH, 'ghapp-'));
  fx = makeFixture(root);
  provider = new GhAppProvider(fx.ctx, { copilotHome: fx.home });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  try {
    fs.rmdirSync(SCRATCH);
  } catch {
    // other test files may still use it
  }
});

const byId = (items: Conversation[]) => new Map(items.map((i) => [i.id, i]));

describe('workspace.yaml reader', () => {
  test('reads flat scalars in the forms the CLI writes', () => {
    const y = readTopLevelScalars(
      [
        'id: abc',
        'cwd: C:\\Users\\me\\src',
        'plain: hello world # comment',
        'url: https://example.com/a#b',
        'dq: "line \\"one\\"\\n\\ttab \\u00e9"',
        "sq: 'it''s here'",
        'folded_plain: first',
        '  second',
        'block: |-',
        '  line 1',
        '',
        '  line 2',
        'keep: |+',
        '  kept',
        '',
        'folded: >',
        '  a',
        '  b',
        'nested:',
        '  child: 1',
        'list:',
        '  - x',
        'empty:',
        'nul: ~',
        'id: second-occurrence-ignored',
      ].join('\n'),
    );
    assert.equal(y.id, 'abc');
    assert.equal(y.cwd, 'C:\\Users\\me\\src');
    assert.equal(y.plain, 'hello world');
    assert.equal(y.url, 'https://example.com/a#b');
    assert.equal(y.dq, 'line "one"\n\ttab é');
    assert.equal(y.sq, "it's here");
    assert.equal(y.folded_plain, 'first second');
    assert.equal(y.block, 'line 1\n\nline 2');
    assert.equal(y.keep, 'kept\n\n');
    assert.equal(y.folded, 'a b\n');
    assert.equal('nested' in y, false);
    assert.equal('list' in y, false);
    assert.equal(y.empty, '');
    assert.equal(y.nul, '');
  });

  test('survives a torn tail and CRLF line endings', () => {
    const y = readTopLevelScalars('id: one\r\nname: "unterminated\r\nsummary: ok\r\nname: later');
    assert.equal(y.id, 'one');
    assert.equal(y.name, 'unterminated');
    assert.equal(y.summary, 'ok');
  });
});

describe('index row encoding', () => {
  test('round-trips SQLite storage classes through JSON', () => {
    const values = [null, 'text', 42n, 2n ** 60n, 1.0, 2.5, new Uint8Array([1, 2, 3])];
    const json = JSON.parse(JSON.stringify(values.map((v) => encodeValue(v))));
    const back = json.map(decodeValue);
    assert.deepEqual(back.slice(0, 6), [null, 'text', 42n, 2n ** 60n, 1, 2.5]);
    assert.equal(typeof back[4], 'number');
    assert.deepEqual([...(back[6] as Uint8Array)], [1, 2, 3]);
  });
});

describe('GhAppProvider listing', () => {
  test('status reports availability and missing pieces', async () => {
    const ok = await provider.status();
    assert.equal(ok.available, true);
    assert.equal(ok.warnings, undefined);

    const bare = path.join(root, 'bare-home');
    fs.mkdirSync(path.join(bare, 'session-state'), { recursive: true });
    const partial = await new GhAppProvider(fx.ctx, { copilotHome: bare }).status();
    assert.equal(partial.available, true);
    assert.ok(partial.warnings?.some((w) => w.includes('data.db')));
    assert.ok(partial.warnings?.some((w) => w.includes('session-store.db')));

    const missing = await new GhAppProvider(fx.ctx, { copilotHome: path.join(root, 'nope') }).status();
    assert.equal(missing.available, false);
    await assert.rejects(new GhAppProvider(fx.ctx, { copilotHome: path.join(root, 'nope') }).list());
  });

  test('classifies app-managed, CLI-only and index-only sessions', async () => {
    const before = { app: sha1(fx.appDb), store: sha1(fx.storeDb), dirs: fs.readdirSync(fx.stateDir).sort() };
    const progress: string[] = [];
    const items = await provider.list((_d, _t, message) => progress.push(message));
    const m = byId(items);
    assert.ok(progress.length > 0);

    const kinds = Object.fromEntries([...m.values()].map((i) => [i.id, `${i.kind}/${i.deleteMode}`]));
    assert.deepEqual(kinds, {
      [S.appChat]: 'app-chat/handoff',
      [S.project]: 'app-session/handoff',
      [S.appCli]: 'app-cli-session/handoff',
      [S.archived]: 'app-chat/handoff',
      [S.workflow]: 'app-session/handoff',
      [S.aliasOnly]: 'app-session/none',
      [S.cli]: 'cli-session/trash',
      [S.inUse]: 'cli-session/none',
      [S.eventsOnly]: 'cli-session/trash',
      [S.stale]: 'cli-session/trash',
      [S.noYaml]: 'cli-session/trash',
      [S.indexOnly]: 'cli-index-only/trash',
    });
    assert.equal(m.has(S.deleting), false, 'sessions pending deletion in the app are excluded');

    const chat = m.get(S.appChat)!;
    assert.equal(chat.title, 'Planning chat');
    assert.equal(chat.url, `ghapp://sessions/${S.appChat}`);
    assert.equal(chat.location, undefined, 'app chats run in <home>/chats, which is not a location');
    assert.match(chat.note ?? '', /handed off to the app/);

    const project = m.get(S.project)!;
    assert.equal(project.title, 'Fix login bug', 'falls back to the active workspace name');
    assert.equal(project.location, 'octo/widgets');
    assert.equal(project.extra?.branch, 'fix/login');
    assert.equal(project.extra?.sourcePrUrl, 'https://github.com/octo/widgets/pull/7');
    assert.equal(project.status, undefined);

    const appCli = m.get(S.appCli)!;
    assert.equal(appCli.location, 'octo/tools');
    assert.equal(appCli.messageCount, 3);
    assert.equal(appCli.extra?.clientName, 'github/cli');

    assert.equal(m.get(S.archived)!.status, 'Archived');
    assert.equal(m.get(S.workflow)!.title, 'Nightly triage');
    assert.equal(m.get(S.workflow)!.extra?.workflowStatus, 'completed');
    assert.equal(m.get(S.aliasOnly)!.location, 'octo/widgets');

    const cli = m.get(S.cli)!;
    assert.equal(cli.title, 'Refactor the parser module', 'workspace.yaml name wins');
    assert.equal(cli.location, 'octo/parser');
    assert.equal(cli.messageCount, 2);
    assert.equal(cli.preview, 'Added tests.');
    assert.equal(cli.createdAt, T0);
    assert.equal(cli.updatedAt, '2026-10-01T09:31:00.000Z');
    assert.equal(cli.note, undefined, 'a stale lock (dead pid) does not block deletion');
    assert.equal(cli.url, undefined);
    assert.equal(cli.extra?.branch, 'main');

    const busy = m.get(S.inUse)!;
    assert.equal(busy.title, 'Busy "session"');
    assert.equal(busy.status, 'In use');
    assert.equal(busy.note, 'In use by a running Copilot process');
    assert.equal(busy.location, 'C:\\src\\busy');
    assert.equal(busy.messageCount, 0);

    const events = m.get(S.eventsOnly)!;
    assert.equal(events.title, 'Hello there', 'first user message from events.jsonl');
    assert.equal(events.messageCount, 2);
    assert.equal(events.preview, 'You are welcome.');
    assert.equal(events.location, 'C:\\src\\events', 'quotes the CLI wrote around the folder are dropped');
    assert.equal(events.extra?.cwd, 'C:\\src\\events');

    const stale = m.get(S.stale)!;
    assert.equal(stale.title, 'Stale summary');
    assert.equal(stale.messageCount, 2, 'the newer event log wins over the stale index');
    assert.equal(stale.preview, 'New answer');

    assert.equal(m.get(S.noYaml)!.title, 'Untitled session');
    assert.equal(m.get(S.noYaml)!.messageCount, 0);

    const indexOnly = m.get(S.indexOnly)!;
    assert.equal(indexOnly.title, 'Old index-only session');
    assert.equal(indexOnly.location, 'C:\\src\\old');
    assert.match(indexOnly.note ?? '', /no longer exists/);

    for (let i = 1; i < items.length; i++) assert.ok((items[i - 1].updatedAt ?? '') >= (items[i].updatedAt ?? ''), 'sorted newest first');

    // Listing never writes.
    assert.equal(sha1(fx.appDb), before.app);
    assert.equal(sha1(fx.storeDb), before.store);
    assert.deepEqual(fs.readdirSync(fx.stateDir).sort(), before.dirs);
  });
});

describe('GhAppProvider transcripts', () => {
  test('falls back to the CLI index when the event log has no messages, and appends checkpoints', async () => {
    const item = byId(await provider.list()).get(S.cli)!;
    const t = await provider.getTranscript(item);
    assert.equal(t.source, 'ghapp');
    assert.equal(t.title, 'Refactor the parser module');
    assert.deepEqual(t.messages, [
      { role: 'user', text: '<context>today</context> Please refactor the parser', at: '2026-10-01T09:05:00.000Z' },
      { role: 'assistant', text: 'Refactored the parser.', at: '2026-10-01T09:05:00.000Z' },
      { role: 'user', text: 'Add tests', at: '2026-10-01T09:30:00.000Z' },
      { role: 'assistant', text: 'Added tests.', at: '2026-10-01T09:30:00.000Z' },
      { role: 'system', text: 'Checkpoint 1: Parser refactor\n\nSplit the parser into modules', at: '2026-10-01T09:20:00.000Z' },
    ]);
    assert.equal(t.partial, undefined);
    assert.equal((t.raw as { from: string }).from, 'session-store');
  });

  test('reads events.jsonl when the index has no turns', async () => {
    const item = byId(await provider.list()).get(S.eventsOnly)!;
    const t = await provider.getTranscript(item);
    assert.deepEqual(t.messages, EXPECTED_EVENTS_TRANSCRIPT);
    assert.equal(t.partial, undefined);
    assert.equal((t.raw as { from: string }).from, 'events.jsonl');
  });

  test('parses identically across chunk boundaries', async () => {
    const file = path.join(fx.stateDir, S.eventsOnly, 'events.jsonl');
    for (const chunk of [7, 64, 255, 300, 4096]) {
      const r = await readEventsTranscript(file, 1e9, { chunkSize: chunk });
      assert.deepEqual(r.messages, EXPECTED_EVENTS_TRANSCRIPT, `chunk size ${chunk}`);
      assert.equal(r.truncated, false);
    }
  });

  test('scans from an offset, skipping only a partial first line', async () => {
    const lines = [ev('a', { n: 1 }), ev('b', { n: 2 }), ev('c', { n: 3 })];
    const file = path.join(root, 'offset.jsonl');
    fs.writeFileSync(file, lines.join('\n'));
    const lineTwo = Buffer.byteLength(lines[0]) + 1;
    const types = async (start: number) => {
      const out: string[] = [];
      await scanEvents(file, { start, maxBytes: 1e6, chunkSize: 16 }, () => true, (e) => {
        out.push(e.type);
      });
      return out;
    };
    assert.deepEqual(await types(0), ['a', 'b', 'c']);
    assert.deepEqual(await types(lineTwo - 1), ['b', 'c']);
    assert.deepEqual(await types(lineTwo), ['b', 'c']);
    assert.deepEqual(await types(lineTwo + 1), ['c']);
    assert.deepEqual(await types(Buffer.byteLength(lines.join('\n'))), []);
  });

  test('summarises large logs from a user-message pass plus the tail', async () => {
    const file = path.join(root, 'head.jsonl');
    fs.writeFileSync(
      file,
      [
        ev('session.start', {}),
        ev('user.message', { content: 'First question' }),
        ev('assistant.message', { messageId: 'a1', content: 'x'.repeat(2000) }),
        ev('user.message', { content: 'Continue', source: 'autopilot' }),
        ev('user.message', { content: 'Second question' }),
        ev('assistant.message', { messageId: 'a2', content: 'Final ', chunkIndex: 0 }),
        ev('assistant.message', { messageId: 'a2', content: 'answer.', chunkIndex: 1 }),
        ev('assistant.message', { messageId: 'a3', content: 'sub-agent', parentToolCallId: 't1' }),
        '',
      ].join('\n'),
    );
    const size = fs.statSync(file).size;
    const expected = { userMessages: 2, firstUser: 'First question', lastAssistant: 'Final answer.' };
    const limits = { fullBytes: 1024, countBytes: 1 << 20, scanBytes: 1 << 20, tailBytes: 1000 };
    assert.deepEqual(await readEventsHead(file, { ...limits, fullBytes: size }), expected, 'one pass');
    assert.deepEqual(await readEventsHead(file, limits), expected, 'user-message pass + tail');
    const { userMessages: _count, ...uncounted } = expected;
    assert.deepEqual(await readEventsHead(file, { ...limits, countBytes: 1024 }), uncounted, 'too large to count');
  });

  test('prefers the event log over the CLI index', async () => {
    const item = byId(await provider.list()).get(S.stale)!;
    const t = await provider.getTranscript(item);
    assert.deepEqual(
      t.messages.map((x) => x.text),
      ['Old question', 'Old answer', 'New question', 'New answer'],
    );
    assert.equal((t.raw as { from: string }).from, 'events.jsonl');
    assert.equal(t.note, undefined);
  });

  test('shows replies the CLI index left empty, even when the index is newer than the log', async () => {
    // The CLI index keeps only each turn's last assistant message, which is empty when the turn
    // ended with a tool call, and stamps turns when they are indexed rather than when they happened.
    const sub = makeFixture(fs.mkdtempSync(path.join(root, 'lossy-')));
    const sid = id(30);
    const db = new DatabaseSync(sub.storeDb);
    db.prepare('INSERT INTO sessions (id, cwd, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      sid,
      'C:\\src\\build',
      'Build fix',
      '2026-11-01T00:00:00.000Z',
      '2026-11-05T00:00:00.000Z',
    );
    db.prepare('INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, 0, ?, ?, ?)').run(
      sid,
      'Fix the build',
      '',
      '2026-11-05T00:00:00.000Z',
    );
    db.close();
    const dir = path.join(sub.stateDir, sid);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${sid}\ncwd: C:\\src\\build\n`);
    const log = path.join(dir, 'events.jsonl');
    fs.writeFileSync(
      log,
      [
        ev('user.message', { content: 'Fix the build' }, {}, '2026-11-01T00:00:00.000Z'),
        ev('assistant.message', { messageId: 'b1', content: 'Working on it.' }, {}, '2026-11-01T00:00:01.000Z'),
        ev('assistant.message', { messageId: 'b2', content: 'The build is fixed.' }, {}, '2026-11-01T00:00:09.000Z'),
        ev('assistant.message', { messageId: 'b3', content: '', toolRequests: [{ name: 'task_complete' }] }, {}, '2026-11-01T00:00:10.000Z'),
        '',
      ].join('\n'),
    );
    fs.utimesSync(log, new Date('2026-11-01T00:00:10.000Z'), new Date('2026-11-01T00:00:10.000Z'));

    const p = new GhAppProvider(sub.ctx, { copilotHome: sub.home });
    const t = await p.getTranscript(byId(await p.list()).get(sid)!);
    assert.deepEqual(
      t.messages.map((x) => [x.role, x.text]),
      [
        ['user', 'Fix the build'],
        ['assistant', 'Working on it.'],
        ['assistant', 'The build is fixed.'],
      ],
    );
    assert.equal((t.raw as { from: string }).from, 'events.jsonl');
  });

  test('reads the start and end of an event log larger than the read limit', async () => {
    const sub = makeFixture(fs.mkdtempSync(path.join(root, 'ends-')));
    const sid = id(31);
    const dir = path.join(sub.stateDir, sid);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${sid}\ncwd: C:\\src\\big\n`);
    const at = (s: number) => `2026-11-01T00:00:${String(s).padStart(2, '0')}.000Z`;
    // Padding keeps the read limit above the provider's 1 KB minimum.
    const pad = { pad: 'p'.repeat(400) };
    const head = [
      ev('user.message', { content: 'First question' }, pad, at(0)),
      ev('assistant.message', { messageId: 'a1', content: 'First answer' }, pad, at(1)),
    ];
    const middle = [
      ev('user.message', { content: 'Middle question' }, {}, at(10)),
      ev('tool.execution_complete', { result: 'x'.repeat(4000) }, {}, at(11)),
      ev('assistant.message', { messageId: 'a2', content: 'Middle answer' }, {}, at(12)),
    ];
    const tail = [
      ev('user.message', { content: 'Last question' }, pad, at(20)),
      ev('assistant.message', { messageId: 'a3', content: 'Last answer' }, pad, at(21)),
    ];
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, [...head, ...middle, ...tail, ''].join('\n'));
    const size = fs.statSync(file).size;
    // Each end gets half the limit: its two lines plus part of a middle line, which is dropped.
    const half = Math.max(Buffer.byteLength(head.join('\n')), Buffer.byteLength(tail.join('\n'))) + 50;
    assert.ok(2 * half > 1024 && 2 * half < size, 'the limit is above the provider minimum and below the log size');

    const r = await readEventsTranscript(file, 2 * half, { tailBytes: half });
    assert.equal(r.truncated, true);
    assert.deepEqual(r.messages.map((m) => m.text), ['First question', 'First answer']);
    assert.deepEqual(r.tail?.messages.map((m) => m.text), ['Last question', 'Last answer']);
    assert.equal(r.tail?.bytesRead, half);
    assert.equal(r.tail?.skippedBytes, size - 2 * half);
    assert.equal(r.bytesRead, 2 * half);
    const whole = await readEventsTranscript(file, size, { tailBytes: half });
    assert.equal(whole.tail, undefined);
    assert.equal(whole.truncated, false);
    assert.equal(whole.messages.length, 6);

    const p = new GhAppProvider(sub.ctx, { copilotHome: sub.home, maxTranscriptBytes: 2 * half });
    const item = byId(await p.list()).get(sid)!;
    const t = await p.getTranscript(item);
    assert.equal(t.partial, true);
    assert.match(t.note ?? '', /^Showing the first .+ MB and last .+ MB of a .+ MB event log; open the full transcript/);
    assert.deepEqual(
      t.messages.map((m) => [m.role, m.text]),
      [
        ['user', 'First question'],
        ['assistant', 'First answer'],
        ['status', 'Skipped 0.1 MB of the event log here'],
        ['user', 'Last question'],
        ['assistant', 'Last answer'],
      ],
    );
    assert.equal((t.raw as { skippedBytes?: number }).skippedBytes, size - 2 * half);

    const full = await p.getTranscript(item, { full: true });
    assert.equal(full.partial, undefined);
    assert.equal(full.note, undefined);
    assert.deepEqual(
      full.messages.map((m) => m.text),
      ['First question', 'First answer', 'Middle question', 'Middle answer', 'Last question', 'Last answer'],
    );
  });

  test('hides injected skill text in transcripts from the CLI index', async () => {
    const sub = makeFixture(fs.mkdtempSync(path.join(root, 'skills-')));
    const sid = id(32);
    const db = new DatabaseSync(sub.storeDb);
    db.prepare('INSERT INTO sessions (id, cwd, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(sid, 'C:\\src\\deck', 'Deck', T0, T0);
    const turn = db.prepare('INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)');
    // A skill injection starts a new index turn, so the reply to the prompt is filed under it.
    turn.run(sid, 0, 'Make a deck', 'Loading the PowerPoint skill.', T0);
    turn.run(sid, 1, '<skill-context name="pptx">\nSkill instructions', 'Here is your deck.', T0);
    db.close();
    const p = new GhAppProvider(sub.ctx, { copilotHome: sub.home });
    const t = await p.getTranscript(byId(await p.list()).get(sid)!);
    assert.deepEqual(
      t.messages.map((m) => [m.role, m.text]),
      [
        ['user', 'Make a deck'],
        ['assistant', 'Loading the PowerPoint skill.'],
        ['assistant', 'Here is your deck.'],
      ],
    );
    assert.equal((t.raw as { from: string }).from, 'session-store');
  });

  test('notes that a running session may be missing its latest messages', async () => {
    const item = byId(await provider.list()).get(S.eventsOnly)!;
    const t = await provider.getTranscript({ ...item, extra: { ...item.extra, isRunning: true } });
    assert.match(t.note ?? '', /still running/);
    assert.deepEqual(t.messages, EXPECTED_EVENTS_TRANSCRIPT);
  });
});

describe('GhAppProvider trash', () => {
  test('refuses app-managed, in-use, linked and invalid items', async () => {
    const m = byId(await provider.list());
    const forged = (sid: string, kind = 'cli-session'): Conversation => ({
      source: 'ghapp',
      id: sid,
      kind,
      title: 'forged',
      deleteMode: 'trash',
    });
    const results = await provider.deleteItems([
      m.get(S.appChat)!,
      m.get(S.inUse)!,
      forged(S.inUse),
      forged(S.appCli),
      forged(S.aliasOnly),
      forged(S.deleting),
      forged('../escape'),
      { ...forged(S.cli), source: 'm365' },
      forged(S.cli, 'app-chat'),
    ]);
    assert.equal(results.length, 9);
    for (const r of results) assert.equal(r.ok, false, `${r.id}: ${r.error}`);
    assert.match(results[0].error ?? '', /handed off/);
    assert.match(results[1].error ?? '', /running Copilot process/);
    assert.match(results[2].error ?? '', /running Copilot process/);
    assert.match(results[3].error ?? '', /Owned by the GitHub Copilot app/);
    assert.match(results[4].error ?? '', /Owned by the GitHub Copilot app/);
    assert.match(results[5].error ?? '', /Owned by the GitHub Copilot app/);
    assert.match(results[6].error ?? '', /Invalid session id/);
    for (const sid of [S.appChat, S.inUse, S.appCli, S.aliasOnly, S.deleting, S.cli]) {
      assert.ok(fs.existsSync(path.join(fx.stateDir, sid)), `${sid} untouched`);
    }
    assert.equal(fs.existsSync(fx.ctx.trashDir), false, 'nothing was written to the trash');

    const overlapping = new GhAppProvider({ ...fx.ctx, trashDir: path.join(fx.home, 'trash') }, { copilotHome: fx.home });
    const [r] = await overlapping.deleteItems([m.get(S.cli)!]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /overlaps/);
  });

  test('moves a CLI session to the trash and restores it exactly', async () => {
    const item = byId(await provider.list()).get(S.cli)!;
    const sessionDir = path.join(fx.stateDir, S.cli);
    const yamlBefore = fs.readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf8');
    const rowsBefore = storeRows(fx.storeDb, S.cli);
    const otherBefore = storeRows(fx.storeDb, S.indexOnly);
    assert.equal(rowsBefore.turns.length, 4);
    assert.deepEqual(ftsMatches(fx.storeDb, 'parser'), [S.cli, S.cli]);

    const progress: Array<[number, number | undefined]> = [];
    const [res] = await provider.deleteItems([item], (d, t) => progress.push([d, t]));
    assert.equal(res.ok, true, res.error ?? 'expected ok');
    assert.match(res.detail ?? '', /index rows/);
    assert.deepEqual(progress.at(-1), [1, 1]);

    const folder = path.join(fx.ctx.trashDir, safeName(S.cli));
    assert.equal(fs.existsSync(sessionDir), false);
    assert.equal(fs.readFileSync(path.join(folder, 'session-state', 'workspace.yaml'), 'utf8'), yamlBefore);
    const meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'));
    assert.equal(meta.id, S.cli);
    assert.equal(meta.kind, 'cli-session');
    assert.equal(meta.originalDir, sessionDir);
    assert.ok(meta.deletedAt);
    const exported = JSON.parse(fs.readFileSync(path.join(folder, 'index-rows.json'), 'utf8'));
    assert.deepEqual(Object.keys(exported.tables).sort(), [
      'assistant_usage_events',
      'checkpoints',
      'search_index',
      'session_files',
      'sessions',
      'turns',
    ]);
    const gone = storeRows(fx.storeDb, S.cli);
    for (const [table, rows] of Object.entries(gone)) assert.equal(rows.length, 0, `${table} rows deleted`);
    assert.deepEqual(ftsMatches(fx.storeDb, 'parser'), []);
    assert.deepEqual(storeRows(fx.storeDb, S.indexOnly), otherBefore, 'other sessions untouched');

    const listed = byId(await provider.list());
    assert.equal(listed.has(S.cli), false);
    const trash = await provider.listTrash();
    assert.equal(trash.length, 1);
    assert.equal(trash[0].id, S.cli);
    assert.equal(trash[0].status, 'In trash');
    assert.equal(trash[0].deleteMode, 'none');
    assert.equal(trash[0].deletedAt, meta.deletedAt);
    assert.equal(trash[0].title, 'Refactor the parser module');
    assert.equal(trash[0].extra?.hasSessionFolder, true);

    const trashed = await provider.getTranscript(trash[0]);
    assert.equal(trashed.messages.filter((x) => x.role !== 'system').length, 4);
    assert.match(trashed.note ?? '', /organizer trash/);

    const [restored] = await provider.restoreItems([S.cli]);
    assert.equal(restored.ok, true, restored.error ?? 'expected ok');
    assert.equal(fs.readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf8'), yamlBefore);
    assert.ok(fs.existsSync(path.join(sessionDir, 'files', 'notes.md')));
    assert.deepEqual(storeRows(fx.storeDb, S.cli), rowsBefore);
    assert.deepEqual(ftsMatches(fx.storeDb, 'parser'), [S.cli, S.cli]);
    assert.equal(fs.existsSync(folder), false);
    assert.deepEqual(await provider.listTrash(), []);
    assert.equal(byId(await provider.list()).get(S.cli)?.kind, 'cli-session');
  });

  test('round-trips an index-only session', async () => {
    const item = byId(await provider.list()).get(S.indexOnly)!;
    const before = storeRows(fx.storeDb, S.indexOnly);
    const [res] = await provider.deleteItems([item]);
    assert.equal(res.ok, true, res.error ?? 'expected ok');
    assert.deepEqual(ftsMatches(fx.storeDb, 'zebras'), []);
    assert.equal(byId(await provider.list()).has(S.indexOnly), false);
    const [restored] = await provider.restoreItems([S.indexOnly]);
    assert.equal(restored.ok, true, restored.error ?? 'expected ok');
    assert.deepEqual(storeRows(fx.storeDb, S.indexOnly), before);
    assert.deepEqual(ftsMatches(fx.storeDb, 'zebras'), [S.indexOnly]);
  });

  test('refuses to restore over an existing session folder', async () => {
    const item = byId(await provider.list()).get(S.eventsOnly)!;
    const [res] = await provider.deleteItems([item]);
    assert.equal(res.ok, true, res.error ?? 'expected ok');
    const dest = path.join(fx.stateDir, S.eventsOnly);
    fs.mkdirSync(dest);
    const [refused] = await provider.restoreItems([S.eventsOnly]);
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /already exists/);
    assert.equal((await provider.listTrash()).length, 1, 'trash copy kept');
    fs.rmdirSync(dest);
    const [restored] = await provider.restoreItems([S.eventsOnly]);
    assert.equal(restored.ok, true, restored.error ?? 'expected ok');
    assert.ok(fs.existsSync(path.join(dest, 'events.jsonl')));
    const [unknown] = await provider.restoreItems([S.eventsOnly]);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /Not found/);
  });
});
