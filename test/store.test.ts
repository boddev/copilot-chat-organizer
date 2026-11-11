import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, readJson, safeName, writeJsonAtomic } from '../src/core/store.ts';
import { UserError } from '../src/core/errors.ts';
import { sleep } from '../src/lib/async.ts';
import { conv, tempDir } from './support/fakes.ts';

const userError = (pattern: RegExp) => (e: unknown) => e instanceof UserError && e.status === 400 && pattern.test(e.message);

test('safeName keeps ids readable, unique and free of path separators', () => {
  assert.match(safeName('tid:oid:s1'), /^tid_oid_s1-[0-9a-f]{8}$/);
  assert.notEqual(safeName('a/b'), safeName('a:b'));
  assert.equal(safeName('x'.repeat(200)).length, 80 + 1 + 8);
  for (const id of ['../../evil', '..\\..\\evil', '..', 'C:\\Windows']) {
    const name = safeName(id);
    assert.doesNotMatch(name, /[\\/:]/, id);
    assert.equal(path.dirname(path.join('base', `${name}.json`)), 'base', id);
  }
});

test('readJson falls back on missing or malformed files and writeJsonAtomic leaves no temp files', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'value.json');
  assert.deepEqual(readJson(file, { fallback: true }), { fallback: true });
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(readJson(file, {}), { a: 2 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['value.json']);
  fs.writeFileSync(file, '{"torn":');
  assert.deepEqual(readJson(file, 'fallback'), 'fallback');
});

test('listing and project caches round-trip and patch in place', (t) => {
  const store = new Store(tempDir(t));
  assert.equal(store.readCache('m365'), undefined);
  store.patchCache('m365', () => [conv('m365', 'never')]);
  assert.equal(store.readCache('m365'), undefined, 'patching without a cache must not create one');

  const written = store.writeCache('m365', [conv('m365', 'a'), conv('m365', 'b')]);
  store.patchCache('m365', (items) => items.filter((i) => i.id !== 'a'));
  const cache = store.readCache('m365')!;
  assert.equal(cache.fetchedAt, written.fetchedAt);
  assert.deepEqual(
    cache.items.map((i) => i.id),
    ['b'],
  );

  fs.writeFileSync(store.file('cache', 'ghapp.json'), '{"items": 5}');
  assert.equal(store.readCache('ghapp'), undefined);

  assert.equal(store.readProjects('m365'), undefined);
  store.patchProjects('m365', () => [{ id: 'p', name: 'never' }]);
  assert.equal(store.readProjects('m365'), undefined);
  store.writeProjects('m365', [{ id: 'p1', name: 'Alpha' }]);
  store.patchProjects('m365', (ps) => ps.map((p) => ({ ...p, name: 'Beta' })));
  assert.deepEqual(store.readProjects('m365')!.projects, [{ id: 'p1', name: 'Beta' }]);
});

test('tombstones hide items until they expire or are removed', async (t) => {
  const store = new Store(tempDir(t), { tombstoneTtlMs: 40 });
  const items = [conv('m365', 'a'), conv('m365', 'b'), conv('ghapp', 'a')];
  const ids = () => store.withoutTombstoned(items).map((i) => `${i.source}:${i.id}`);
  store.addTombstones([]);
  assert.equal(fs.existsSync(store.file('tombstones.json')), false);

  store.addTombstones(['m365:a']);
  assert.deepEqual(ids(), ['m365:b', 'ghapp:a']);
  await sleep(80);
  assert.deepEqual(ids(), ['m365:a', 'm365:b', 'ghapp:a']);

  store.addTombstones(['m365:a', 'm365:b']);
  store.removeTombstones(['m365:a', 'm365:unknown']);
  assert.deepEqual(ids(), ['m365:a', 'ghapp:a']);
});

test('collections group items across sources', (t) => {
  const store = new Store(tempDir(t));
  const research = store.createCollection('  Research  ', '#336699');
  assert.equal(research.name, 'Research');
  assert.throws(() => store.createCollection('research'), userError(/already exists/));
  assert.throws(() => store.createCollection('   '), userError(/required/));
  const other = store.createCollection('Other');

  assert.equal(store.addToCollection(research.id, ['m365:a', 'ghapp:b']), 2);
  assert.equal(store.addToCollection(research.id, ['m365:a', 'vscode:c']), 1);
  assert.equal(store.addToCollection(other.id, ['m365:a']), 1);
  assert.equal(store.removeFromCollection(research.id, ['vscode:c', 'missing']), 1);
  assert.throws(() => store.addToCollection('nope', ['m365:a']), userError(/Unknown collection/));
  assert.throws(() => store.removeFromCollection('nope', ['m365:a']), userError(/Unknown collection/));

  assert.equal(store.updateCollection(research.id, { name: ' Renamed ' }).name, 'Renamed');
  assert.equal(store.updateCollection(research.id, { color: null }).color, undefined);
  assert.throws(() => store.updateCollection(research.id, { name: ' ' }), userError(/required/));
  assert.throws(() => store.updateCollection('nope', { name: 'x' }), userError(/Unknown collection/));

  store.forgetItems(['m365:a']);
  assert.deepEqual(
    store.listCollections().map((c) => [c.name, c.members]),
    [
      ['Renamed', ['ghapp:b']],
      ['Other', []],
    ],
  );

  store.deleteCollection(research.id);
  assert.deepEqual(
    store.listCollections().map((c) => c.name),
    ['Other'],
  );
  const raw = readJson<{ members: Record<string, string[]> }>(store.file('collections.json'), { members: {} });
  assert.deepEqual(Object.keys(raw.members), [other.id]);
});

test('the hand-off queue ignores duplicates', (t) => {
  const store = new Store(tempDir(t));
  assert.equal(store.queueHandoff([conv('ghapp', 'a'), conv('ghapp', 'b')]), 2);
  assert.equal(store.queueHandoff([conv('ghapp', 'a'), conv('ghapp', 'c', { url: 'ghapp://sessions/c' })]), 1);
  assert.deepEqual(
    store.listHandoff().map((e) => e.key),
    ['ghapp:a', 'ghapp:b', 'ghapp:c'],
  );
  assert.equal(store.listHandoff()[2].url, 'ghapp://sessions/c');
  store.removeHandoff(['ghapp:b']);
  assert.deepEqual(
    store.listHandoff().map((e) => e.key),
    ['ghapp:a', 'ghapp:c'],
  );
});

test('the operation log returns the newest entries first and skips torn lines', (t) => {
  const store = new Store(tempDir(t));
  assert.deepEqual(store.readOps(), []);
  for (const op of ['a', 'b', 'c']) store.appendOp({ op, ok: 1, failed: 0 });
  assert.deepEqual(
    store.readOps(2).map((e) => e.op),
    ['c', 'b'],
  );
  fs.appendFileSync(store.file('oplog.jsonl'), '{"at":"2026-01-01","op":\n');
  store.appendOp({ op: 'd', ok: 0, failed: 1 });
  const ops = store.readOps();
  assert.deepEqual(
    ops.map((e) => e.op),
    ['d', 'c', 'b', 'a'],
  );
  assert.match(ops[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('backups are written per day and source under a safe file name', (t) => {
  const store = new Store(tempDir(t));
  const file = store.writeBackup('m365', 'tid:oid:s1', { transcript: 'hello' });
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(path.dirname(file), store.file('backups', day, 'm365'));
  assert.equal(path.basename(file), `${safeName('tid:oid:s1')}.json`);
  const saved = readJson<{ source: string; id: string; data: unknown }>(file, { source: '', id: '', data: null });
  assert.deepEqual([saved.source, saved.id, saved.data], ['m365', 'tid:oid:s1', { transcript: 'hello' }]);
});
