import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/core/store.ts';
import { Organizer } from '../src/core/organizer.ts';
import { createHandler } from '../src/server/app.ts';
import { FakeProvider, conv, tempDir } from './support/fakes.ts';
import { sleep } from '../src/lib/async.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token-0123456789abcdef';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

async function start(t: TestContext) {
  const store = new Store(tempDir(t));
  const m365 = new FakeProvider('m365', [conv('m365', 'c1'), conv('m365', 'c2')], { projects: true });
  const ghapp = new FakeProvider('ghapp', [conv('ghapp', 's1', { deleteMode: 'handoff' })], { trash: true });
  const organizer = new Organizer(store, [m365, ghapp], () => {}, { projectSettleMs: 1 });
  let handler: http.RequestListener = (_req, res) => res.end();
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  handler = createHandler({ organizer, publicDir: path.join(ROOT, 'public'), token: TOKEN, port, info: { mode: 'test' } });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const request = (method: string, pathname: string, options: { headers?: Record<string, string>; body?: unknown; token?: boolean } = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const data = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      const headers: Record<string, string | number> = { host: `127.0.0.1:${port}` };
      if (options.token !== false) headers['x-organizer-token'] = TOKEN;
      if (data !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(data);
      }
      Object.assign(headers, options.headers);
      const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      if (data !== undefined) req.write(data);
      req.end();
    });

  const waitForJob = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await request('GET', `/api/jobs/${id}`);
      if (r.json.status !== 'running') return r.json;
      await sleep(10);
    }
    throw new Error('job did not finish');
  };

  return { port, request, waitForJob, store, m365, organizer };
}

test('serves the UI with the per-launch token and strict security headers', async (t) => {
  const { request } = await start(t);
  const page = await request('GET', '/', { token: false });
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.ok(page.text.includes(TOKEN));
  assert.ok(!page.text.includes('%%ORGANIZER_TOKEN%%'));
  const csp = String(page.headers['content-security-policy']);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');

  for (const [file, type] of [
    ['/app.js', /javascript/],
    ['/app.css', /text\/css/],
  ] as const) {
    const r = await request('GET', file, { token: false });
    assert.equal(r.status, 200, file);
    assert.match(String(r.headers['content-type']), type);
  }
});

test('never serves files outside public/', async (t) => {
  const { request } = await start(t);
  for (const p of ['/../package.json', '/..%2F..%2Fpackage.json', '/..%5C..%5Cpackage.json', '/%2e%2e/src/server/app.ts', '/missing.js']) {
    const r = await request('GET', p, { token: false });
    assert.equal(r.status, 404, p);
  }
  assert.equal((await request('GET', '/%E0%A4%A', { token: false })).status, 400);
  assert.equal((await request('POST', '/index.html', { token: false, body: {} })).status, 405);
});

test('rejects foreign hosts and origins (DNS rebinding and cross-site calls)', async (t) => {
  const { request, port } = await start(t);
  assert.equal((await request('GET', '/', { token: false, headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await request('GET', '/api/sources', { headers: { host: 'localhost:1' } })).status, 403);
  assert.equal((await request('GET', '/api/sources', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('GET', '/api/sources', { headers: { origin: 'null' } })).status, 403);
  assert.equal((await request('GET', '/api/sources', { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await request('GET', '/api/sources', { headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` } })).status, 200);
});

test('requires the API token', async (t) => {
  const { request } = await start(t);
  assert.equal((await request('GET', '/api/sources', { token: false })).status, 401);
  assert.equal((await request('GET', '/api/sources', { headers: { 'x-organizer-token': 'x'.repeat(TOKEN.length) } })).status, 401);
  assert.equal((await request('GET', '/api/sources', { headers: { 'x-organizer-token': 'short' } })).status, 401);
  const ok = await request('GET', '/api/sources');
  assert.equal(ok.status, 200);
  assert.deepEqual(
    ok.json.map((s: { id: string }) => s.id),
    ['m365', 'ghapp'],
  );
  assert.equal(ok.headers['cache-control'], 'no-store');
});

test('accepts only JSON object bodies for writes', async (t) => {
  const { request } = await start(t);
  const textPlain = await request('POST', '/api/collections', { body: '{"name":"x"}', headers: { 'content-type': 'text/plain' } });
  assert.equal(textPlain.status, 415);
  assert.equal((await request('POST', '/api/collections', { body: '[1,2]' })).status, 400);
  assert.equal((await request('POST', '/api/collections', { body: 'not json' })).status, 400);
  assert.equal((await request('POST', '/api/collections', { body: { name: '   ' } })).status, 400);
});

test('reports unknown endpoints, wrong methods and bad input with clear errors', async (t) => {
  const { request } = await start(t);
  assert.equal((await request('GET', '/api/nothing')).status, 404);
  assert.equal((await request('DELETE', '/api/sources')).status, 405);
  assert.equal((await request('GET', '/api/jobs/nope')).status, 404);
  const badSource = await request('POST', '/api/refresh', { body: { source: 'nope' } });
  assert.equal(badSource.status, 400);
  assert.match(badSource.json.error, /Unknown source/);
  const noKeys = await request('POST', '/api/delete/plan', { body: { keys: [] } });
  assert.equal(noKeys.status, 400);
  const badBackup = await request('POST', '/api/delete', { body: { keys: ['m365:c1'], backup: 'maybe', confirm: 'delete 1' } });
  assert.equal(badBackup.status, 400);
  const noTranscript = await request('GET', '/api/transcript?key=m365%3Amissing');
  assert.equal(noTranscript.status, 404);
});

test('refreshes, plans and deletes through the API', async (t) => {
  const { request, waitForJob, m365 } = await start(t);
  const refresh = await request('POST', '/api/refresh', { body: { source: 'm365' } });
  assert.equal(refresh.status, 200);
  assert.equal((await waitForJob(refresh.json.id)).status, 'done');

  const items = await request('GET', '/api/items?source=m365');
  assert.deepEqual(items.json.items.map((i: { id: string }) => i.id).sort(), ['c1', 'c2']);

  const transcript = await request('GET', '/api/transcript?key=m365%3Ac1');
  assert.equal(transcript.json.messages[0].text, 'hello from c1');

  const plan = await request('POST', '/api/delete/plan', { body: { keys: ['m365:c1'] } });
  assert.equal(plan.json.confirmPhrase, 'delete 1');

  const refused = await request('POST', '/api/delete', { body: { keys: ['m365:c1'], confirm: 'delete 2' } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /delete 1/);
  assert.deepEqual(m365.deletedIds, []);

  const del = await request('POST', '/api/delete', { body: { keys: ['m365:c1'], confirm: 'delete 1', backup: 'none' } });
  assert.equal(del.status, 200);
  assert.equal((await waitForJob(del.json.id)).summary, '1 of 1 handled');
  assert.deepEqual(m365.deletedIds, ['c1']);

  const ops = await request('GET', '/api/ops?limit=5');
  assert.equal(ops.json[0].op, 'delete');
});

test('manages collections, projects and hand-offs through the API', async (t) => {
  const { request, waitForJob, m365 } = await start(t);
  for (const source of ['m365', 'ghapp']) await waitForJob((await request('POST', '/api/refresh', { body: { source } })).json.id);

  const created = await request('POST', '/api/collections', { body: { name: 'Research', color: '#123456' } });
  assert.equal(created.status, 200);
  const id = created.json.id;
  assert.equal((await request('POST', '/api/collections', { body: { name: 'research' } })).status, 400);
  assert.equal((await request('POST', `/api/collections/${id}/add`, { body: { keys: ['m365:c1', 'm365:c2'] } })).json.added, 2);
  assert.equal((await request('POST', `/api/collections/${id}/remove`, { body: { keys: ['m365:c2'] } })).json.removed, 1);
  assert.equal((await request('PATCH', `/api/collections/${id}`, { body: { name: 'Renamed', color: null } })).json.name, 'Renamed');
  const list = await request('GET', '/api/collections');
  assert.deepEqual(list.json[0].members, ['m365:c1']);
  assert.equal(list.json[0].color, undefined);
  assert.equal((await request('DELETE', `/api/collections/${id}`)).status, 200);
  assert.deepEqual((await request('GET', '/api/collections')).json, []);

  const project = await request('POST', '/api/projects', { body: { source: 'm365', name: 'Alpha' } });
  assert.equal(project.status, 200);
  const pid = project.json.id;
  const live = await request('GET', '/api/projects?source=m365&live=1');
  assert.deepEqual(
    live.json.map((p: { name: string }) => p.name),
    ['Alpha'],
  );
  const assign = await request('POST', `/api/projects/m365/${pid}/assign`, { body: { keys: ['m365:c1'] } });
  assert.equal((await waitForJob(assign.json.id)).status, 'done');
  assert.equal(m365.projects!.projectOf('c1'), pid);
  assert.equal((await request('PATCH', `/api/projects/m365/${pid}`, { body: { archived: 'yes' } })).status, 400);
  assert.equal((await request('PATCH', `/api/projects/m365/${pid}`, { body: { name: 'Beta', color: 'blue' } })).status, 200);
  const cached = await request('GET', '/api/projects?source=m365');
  assert.deepEqual([cached.json[0].name, cached.json[0].color, cached.json[0].itemCount], ['Beta', 'blue', 1]);
  assert.equal((await request('POST', `/api/projects/m365/${pid}/delete`, { body: { contents: 'maybe' } })).status, 400);
  const removed = await request('POST', `/api/projects/m365/${pid}/delete`, { body: { contents: 'keep' } });
  assert.equal((await waitForJob(removed.json.id)).status, 'done');
  assert.ok(!m365.projects!.projects.has(pid));

  const handoff = await request('POST', '/api/delete', { body: { keys: ['ghapp:s1'], confirm: 'delete 1' } });
  await waitForJob(handoff.json.id);
  const queue = await request('GET', '/api/handoff');
  assert.deepEqual(
    queue.json.entries.map((e: { key: string }) => e.key),
    ['ghapp:s1'],
  );
  assert.match(queue.json.request, /\(id: s1\)/);
  const cleared = await request('POST', '/api/handoff/remove', { body: { keys: ['ghapp:s1'] } });
  assert.deepEqual(cleared.json.entries, []);
});
