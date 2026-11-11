import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { Store } from '../src/core/store.ts';
import { Organizer, deleteConfirmPhrase, handoffRequest } from '../src/core/organizer.ts';
import { UserError } from '../src/core/errors.ts';
import type { Conversation } from '../src/core/types.ts';
import { FakeProvider, conv, tempDir, waitJob } from './support/fakes.ts';

function setup(t: TestContext, m365Items: Conversation[] = [], ghItems: Conversation[] = []) {
  const dir = tempDir(t);
  const store = new Store(dir);
  const m365 = new FakeProvider('m365', m365Items, { projects: true });
  const ghapp = new FakeProvider('ghapp', ghItems, { trash: true });
  const org = new Organizer(store, [m365, ghapp], () => {}, { projectSettleMs: 1 });
  return { dir, store, m365, ghapp, org, projects: m365.projects! };
}

async function refreshAll(org: Organizer): Promise<void> {
  for (const s of org.sourceIds()) {
    const job = await waitJob(org, org.refresh(s));
    assert.equal(job.status, 'done', job.error ?? '');
  }
}

const ids = (items: Conversation[]) => items.map((i) => i.id).sort();

test('refresh caches the listing and projects, and joins a refresh already running', async (t) => {
  const { org, store, projects } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2')]);
  await projects.create('Alpha');
  const first = org.refresh('m365');
  const second = org.refresh('m365');
  assert.equal(second.id, first.id);
  const done = await waitJob(org, first);
  assert.equal(done.status, 'done');
  assert.match(done.summary ?? '', /^2 conversations/);
  assert.deepEqual(ids(org.items('m365').items), ['c1', 'c2']);
  assert.equal(store.readProjects('m365')?.projects[0].name, 'Alpha');
  assert.ok(org.items().fetchedAt.m365);

  const summaries = await org.summaries();
  const m = summaries.find((s) => s.id === 'm365')!;
  assert.equal(m.count, 2);
  assert.equal(m.hasProjects, true);
  assert.equal(m.hasTrash, false);
  assert.equal(summaries.find((s) => s.id === 'ghapp')!.hasTrash, true);
});

test('unknown sources are reported as user errors', (t) => {
  const { org } = setup(t);
  assert.throws(
    () => org.refresh('vscode'),
    (e: unknown) => e instanceof UserError && e.status === 404,
  );
});

test('planDelete counts delete modes, notes, missing items and cascades', async (t) => {
  const note = 'Deleting this chat also deletes the Copilot tasks created from it.';
  const { org } = setup(
    t,
    [
      conv('m365', 'c1', { note, extra: { childTaskIds: ['t1', 't2'] } }),
      conv('m365', 'c2', { note }),
      conv('m365', 't1', { kind: 'cowork-task' }),
      conv('m365', 't2', { kind: 'cowork-task' }),
    ],
    [conv('ghapp', 's1', { deleteMode: 'handoff' }), conv('ghapp', 's2', { deleteMode: 'none', note: 'In use' })],
  );
  await refreshAll(org);
  const plan = org.planDelete(['m365:c1', 'm365:c2', 'm365:t1', 'ghapp:s1', 'ghapp:s2', 'm365:missing', 'garbage', 'm365:c1']);
  assert.equal(plan.total, 5);
  assert.equal(plan.direct, 3);
  assert.equal(plan.handoff, 1);
  assert.equal(plan.none, 1);
  assert.equal(plan.trash, 0);
  assert.equal(plan.missing, 2);
  assert.deepEqual(plan.bySource, { m365: 3, ghapp: 2 });
  assert.equal(plan.cascade, 1, 't2 is removed with c1 although it was not selected');
  assert.deepEqual(plan.notes.sort(), [`${note} (2 items)`, 'In use'].sort());
  assert.equal(plan.confirmPhrase, deleteConfirmPhrase(5));
});

test('delete refuses without the typed confirmation', async (t) => {
  const { org, m365 } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2')]);
  await refreshAll(org);
  for (const confirm of [undefined, '', 'delete 1', 'yes']) {
    assert.throws(
      () => org.delete(['m365:c1', 'm365:c2'], { confirm }),
      (e: unknown) => e instanceof UserError && /"delete 2"/.test(e.message),
    );
  }
  assert.deepEqual(m365.deletedIds, []);
  const job = await waitJob(org, org.delete(['m365:c1', 'm365:c2'], { confirm: '  DELETE 2 ', backup: 'none' }));
  assert.equal(job.status, 'done');
  assert.deepEqual(m365.deletedIds.sort(), ['c1', 'c2']);
});

test('delete backs up direct items, queues hand-offs and cleans up caches, collections and cascades', async (t) => {
  const { org, store, dir, m365, ghapp } = setup(
    t,
    [conv('m365', 'c1', { extra: { childTaskIds: ['t1'] } }), conv('m365', 't1', { kind: 'cowork-task' }), conv('m365', 'c2')],
    [
      conv('ghapp', 's1', { deleteMode: 'handoff', title: 'App chat', url: 'ghapp://sessions/s1' }),
      conv('ghapp', 's2', { deleteMode: 'none', note: 'Session is in use' }),
      conv('ghapp', 's3', { deleteMode: 'trash' }),
    ],
  );
  m365.cascades.c1 = ['t1'];
  await refreshAll(org);
  const col = store.createCollection('Keep an eye on');
  store.addToCollection(col.id, ['m365:c1', 'm365:t1', 'm365:c2', 'ghapp:s3']);

  const keys = ['m365:c1', 'ghapp:s1', 'ghapp:s2', 'ghapp:s3'];
  const job = await waitJob(org, org.delete(keys, { confirm: 'delete 4', backup: 'full' }));
  assert.equal(job.status, 'done', job.error ?? '');
  assert.equal(job.summary, '3 of 4 handled');
  const byKey = Object.fromEntries((job.results ?? []).map((r) => [r.key, r]));
  assert.equal(byKey['m365:c1'].ok, true);
  assert.equal(byKey['ghapp:s1'].ok, true);
  assert.match(byKey['ghapp:s1'].detail ?? '', /Queued/);
  assert.equal(byKey['ghapp:s2'].ok, false);
  assert.equal(byKey['ghapp:s2'].error, 'Session is in use');
  assert.equal(byKey['ghapp:s3'].ok, true);

  // Only direct deletes are backed up, with the requested depth.
  assert.deepEqual(m365.transcriptCalls, [{ id: 'c1', full: true }]);
  assert.deepEqual(ghapp.transcriptCalls, []);
  const day = new Date().toISOString().slice(0, 10);
  const backups = fs.readdirSync(path.join(dir, 'backups', day, 'm365'));
  assert.equal(backups.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'backups', day, 'm365', backups[0]), 'utf8'));
  assert.equal(saved.data.transcript.messages[0].text, 'hello from c1');

  // The cascade-deleted task disappears too, even before the next refresh.
  assert.deepEqual(ids(org.items('m365').items), ['c2']);
  assert.deepEqual(ids(org.items('ghapp').items), ['s1', 's2']);
  assert.deepEqual(store.listCollections()[0].members, ['m365:c2']);
  assert.deepEqual(
    store.listHandoff().map((h) => h.key),
    ['ghapp:s1'],
  );
  assert.deepEqual(ghapp.deletedIds, ['s3']);
  const op = store.readOps(1)[0];
  assert.equal(op.op, 'delete');
  assert.equal(op.ok, 3);
  assert.equal(op.failed, 1);
});

test('tombstones hide deleted items that a stale listing still returns', async (t) => {
  const { org, m365 } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2')]);
  await refreshAll(org);
  await waitJob(org, org.delete(['m365:c1'], { confirm: 'delete 1', backup: 'none' }));
  m365.items.push(conv('m365', 'c1'));
  await refreshAll(org);
  assert.deepEqual(ids(org.items('m365').items), ['c2']);
});

test('a failed backup keeps the conversation unless backups are turned off', async (t) => {
  const { org, m365 } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2')]);
  m365.failTranscript.add('c1');
  await refreshAll(org);
  const job = await waitJob(org, org.delete(['m365:c1', 'm365:c2'], { confirm: 'delete 2' }));
  const byKey = Object.fromEntries((job.results ?? []).map((r) => [r.key, r]));
  assert.equal(byKey['m365:c1'].ok, false);
  assert.match(byKey['m365:c1'].error ?? '', /Backup failed/);
  assert.equal(byKey['m365:c2'].ok, true);
  assert.deepEqual(m365.deletedIds, ['c2']);
  assert.deepEqual(m365.transcriptCalls, [
    { id: 'c1', full: false },
    { id: 'c2', full: false },
  ]);

  await waitJob(org, org.delete(['m365:c1'], { confirm: 'delete 1', backup: 'none' }));
  assert.deepEqual(m365.deletedIds, ['c2', 'c1']);
});

test('provider failures are reported per item and keep the item listed', async (t) => {
  const { org, m365 } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2')]);
  m365.failDelete.add('c2');
  await refreshAll(org);
  const job = await waitJob(org, org.delete(['m365:c1', 'm365:c2', 'm365:gone'], { confirm: 'delete 2', backup: 'none' }));
  assert.equal(job.summary, '1 of 3 handled');
  const failed = (job.results ?? []).filter((r) => !r.ok).map((r) => r.key);
  assert.deepEqual(failed.sort(), ['m365:c2', 'm365:gone']);
  assert.deepEqual(ids(org.items('m365').items), ['c2']);
});

test('refresh clears hand-off entries that the owning app has deleted', async (t) => {
  const { org, store, ghapp } = setup(t, [], [conv('ghapp', 's1', { deleteMode: 'handoff' }), conv('ghapp', 's2', { deleteMode: 'handoff' })]);
  await refreshAll(org);
  assert.equal(org.queueHandoff(['ghapp:s1', 'ghapp:s2', 'ghapp:s1']), 2);
  assert.match(org.handoff().request, /these 2 GitHub Copilot sessions/);
  ghapp.items = ghapp.items.filter((i) => i.id !== 's1');
  const job = await waitJob(org, org.refresh('ghapp'));
  assert.match(job.summary ?? '', /1 hand-off deletions completed/);
  assert.deepEqual(
    store.listHandoff().map((h) => h.key),
    ['ghapp:s2'],
  );
});

test('assign moves items between projects and keeps the cache in step', async (t) => {
  const { org, projects } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2'), conv('m365', 'c3')]);
  const alpha = await org.createProject('m365', 'Alpha');
  const beta = await org.createProject('m365', 'Beta');
  await refreshAll(org);

  let job = await waitJob(org, org.assign('m365', alpha.id, ['m365:c1', 'm365:c2', 'ghapp:x']));
  assert.equal(job.status, 'done');
  assert.equal(job.summary, '2 of 3 succeeded');
  job = await waitJob(org, org.assign('m365', beta.id, ['m365:c1']));
  assert.equal(job.status, 'done');

  assert.equal(projects.projectOf('c1'), beta.id);
  assert.equal(projects.projectOf('c2'), alpha.id);
  const cached = Object.fromEntries(org.items('m365').items.map((i) => [i.id, i.projectIds]));
  assert.deepEqual(cached, { c1: [beta.id], c2: [alpha.id], c3: [] });
  const counts = Object.fromEntries((await org.projects('m365')).map((p) => [p.name, p.itemCount]));
  assert.deepEqual(counts, { Alpha: 1, Beta: 1 });
});

test('unassign removes items from whichever project holds them', async (t) => {
  const { org, projects } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2'), conv('m365', 'c3')]);
  const alpha = await org.createProject('m365', 'Alpha');
  const beta = await org.createProject('m365', 'Beta');
  await projects.addItems(alpha.id, [conv('m365', 'c1')]);
  await projects.addItems(beta.id, [conv('m365', 'c2')]);
  await refreshAll(org);
  const job = await waitJob(org, org.unassign('m365', ['m365:c1', 'm365:c2', 'm365:c3']));
  assert.equal(job.summary, '2 of 2 succeeded');
  assert.equal(projects.projectOf('c1'), undefined);
  assert.equal(projects.projectOf('c2'), undefined);
  assert.ok(org.items('m365').items.every((i) => !i.projectIds?.length));
});

test('updateProject changes the service and the cached project', async (t) => {
  const { org, projects } = setup(t);
  const p = await org.createProject('m365', 'Alpha');
  assert.deepEqual(
    (await org.projects('m365', { live: true })).map((x) => x.name),
    ['Alpha'],
  );
  await org.updateProject('m365', p.id, { name: '  Renamed ', color: 'blue', archived: true });
  let cached = (await org.projects('m365')).find((x) => x.id === p.id)!;
  assert.deepEqual([cached.name, cached.color, cached.archived], ['Renamed', 'blue', true]);
  assert.equal(projects.projects.get(p.id)?.color, 'blue');
  await org.updateProject('m365', p.id, { color: null });
  cached = (await org.projects('m365')).find((x) => x.id === p.id)!;
  assert.equal(cached.color, 'gray');
  await assert.rejects(org.projects('ghapp'), (e: unknown) => e instanceof UserError);
});

test('deleteProject keeps its conversations by detaching them first', async (t) => {
  const { org, projects, m365, store } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2')]);
  const p = await org.createProject('m365', 'Alpha');
  await projects.addItems(p.id, [conv('m365', 'c1'), conv('m365', 'c2')]);
  await refreshAll(org);
  const job = await waitJob(org, org.deleteProject('m365', p.id, { contents: 'keep' }));
  assert.equal(job.status, 'done', job.error ?? '');
  assert.match(job.summary ?? '', /2 items kept/);
  const order = projects.calls.filter((c) => !c.startsWith('create') && !c.startsWith('add'));
  assert.deepEqual(order, [`remove ${p.id} c1`, `remove ${p.id} c2`, `delete ${p.id}`]);
  assert.deepEqual(m365.deletedIds, []);
  assert.deepEqual(ids(org.items('m365').items), ['c1', 'c2']);
  assert.ok(org.items('m365').items.every((i) => !i.projectIds?.length));
  assert.deepEqual(store.readProjects('m365')?.projects, []);
});

test('deleteProject keeps the project when it still has members the organizer did not know about', async (t) => {
  const { org, projects } = setup(t, [conv('m365', 'c1')]);
  const p = await org.createProject('m365', 'Alpha');
  await projects.addItems(p.id, [conv('m365', 'c1')]);
  projects.hidden.set(p.id, 1);
  await refreshAll(org);
  const job = await waitJob(org, org.deleteProject('m365', p.id, { contents: 'keep' }));
  assert.equal(job.status, 'failed');
  assert.match(job.error ?? '', /still contains 1 item/);
  assert.ok(projects.projects.has(p.id));
});

test('deleteProject keeps the project when a member cannot be detached', async (t) => {
  const { org, projects } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2')]);
  const p = await org.createProject('m365', 'Alpha');
  await projects.addItems(p.id, [conv('m365', 'c1'), conv('m365', 'c2')]);
  projects.failRemove.add('c2');
  await refreshAll(org);
  const job = await waitJob(org, org.deleteProject('m365', p.id, { contents: 'keep' }));
  assert.equal(job.status, 'failed');
  assert.match(job.error ?? '', /1 items could not be removed/);
  assert.ok(projects.projects.has(p.id));
});

test('deleteProject can delete its conversations after a typed confirmation', async (t) => {
  const { org, projects, m365 } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2'), conv('m365', 'c3')]);
  const p = await org.createProject('m365', 'Alpha');
  await projects.addItems(p.id, [conv('m365', 'c1'), conv('m365', 'c2')]);
  await refreshAll(org);
  assert.throws(
    () => org.deleteProject('m365', p.id, { contents: 'delete', confirm: 'delete 3' }),
    (e: unknown) => e instanceof UserError && /"delete 2"/.test(e.message),
  );
  const job = await waitJob(org, org.deleteProject('m365', p.id, { contents: 'delete', confirm: 'delete 2', backup: 'summary' }));
  assert.equal(job.status, 'done', job.error ?? '');
  assert.deepEqual(m365.deletedIds.sort(), ['c1', 'c2']);
  assert.deepEqual(ids(org.items('m365').items), ['c3']);
  assert.ok(!projects.projects.has(p.id));
});

test('restore brings trashed conversations back and clears their tombstones', async (t) => {
  const { org, ghapp } = setup(t, [], [conv('ghapp', 's1', { deleteMode: 'trash' }), conv('ghapp', 's2', { deleteMode: 'trash' })]);
  await refreshAll(org);
  await waitJob(org, org.delete(['ghapp:s1'], { confirm: 'delete 1' }));
  assert.deepEqual(ids(org.items('ghapp').items), ['s2']);
  assert.deepEqual(ids(await org.trash('ghapp')), ['s1']);
  const job = await waitJob(org, org.restore('ghapp', ['s1', 'nope']));
  assert.equal(job.status, 'done', job.error ?? '');
  assert.equal(job.summary, '1 of 2 succeeded');
  assert.deepEqual(ids(org.items('ghapp').items), ['s1', 's2']);
  assert.deepEqual(ghapp.trashed, []);
  assert.throws(() => org.restore('m365', ['x']), (e: unknown) => e instanceof UserError);
});

test('jobs for the same source run one at a time', async (t) => {
  const { org, projects } = setup(t, [conv('m365', 'c1'), conv('m365', 'c2')]);
  const a = await org.createProject('m365', 'A');
  const b = await org.createProject('m365', 'B');
  await refreshAll(org);
  projects.delayMs = 30;
  const jobs = [org.assign('m365', a.id, ['m365:c1']), org.assign('m365', b.id, ['m365:c2']), org.unassign('m365', ['m365:c1'])];
  for (const j of jobs) await waitJob(org, j);
  assert.equal(projects.maxActive, 1);
});

test('handoffRequest lists only GitHub Copilot app sessions', () => {
  const at = new Date().toISOString();
  const text = handoffRequest([
    { key: 'ghapp:s1', source: 'ghapp', id: 's1', title: 'Fix the "build"', queuedAt: at },
    { key: 'vscode:v1', source: 'vscode', id: 'v1', title: 'Other', queuedAt: at },
  ]);
  assert.match(text, /^Please delete these 1 GitHub Copilot sessions/);
  assert.match(text, /1\. "Fix the 'build'" \(id: s1\)/);
  assert.doesNotMatch(text, /v1/);
  assert.equal(handoffRequest([]), '');
});
