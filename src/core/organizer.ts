// Orchestrates providers for the UI: cached listings, background jobs with progress,
// backups before deletion, hand-off queue, native projects and local collections.
import crypto from 'node:crypto';
import { Store, type HandoffEntry } from './store.ts';
import {
  itemKey,
  parseItemKey,
  type Conversation,
  type ItemResult,
  type Progress,
  type Project,
  type Provider,
  type ProviderStatus,
  type SourceId,
  type Transcript,
} from './types.ts';
import { mapLimit, sleep } from '../lib/async.ts';
import { UserError } from './errors.ts';

export type BackupMode = 'none' | 'summary' | 'full';

export interface JobResult extends ItemResult {
  key: string;
  title?: string;
}

export interface Job {
  id: string;
  kind: string;
  label: string;
  source?: SourceId;
  status: 'running' | 'done' | 'failed';
  progress: { done: number; total?: number; message: string };
  startedAt: string;
  finishedAt?: string;
  error?: string;
  summary?: string;
  results?: JobResult[];
}

export interface SourceSummary {
  id: SourceId;
  label: string;
  status: ProviderStatus;
  count: number;
  fetchedAt?: string;
  hasProjects: boolean;
  projectColors?: string[];
  hasTrash: boolean;
}

export interface DeletePlan {
  total: number;
  direct: number;
  trash: number;
  handoff: number;
  none: number;
  missing: number;
  bySource: Partial<Record<SourceId, number>>;
  /** Side effects worth reading before confirming (deduplicated). */
  notes: string[];
  /** Number of extra items the services remove together with the selection. */
  cascade: number;
  confirmPhrase: string;
}

export const deleteConfirmPhrase = (count: number): string => `delete ${count}`;

export interface OrganizerOptions {
  /** Wait between live checks that a project is empty before deleting it. */
  projectSettleMs?: number;
}

const MAX_JOBS = 50;

export class Organizer {
  readonly store: Store;
  private readonly providers = new Map<SourceId, Provider>();
  private readonly jobs = new Map<string, Job>();
  private readonly locks = new Map<SourceId, Promise<unknown>>();
  private readonly log: (message: string) => void;
  private readonly projectSettleMs: number;

  constructor(store: Store, providers: Provider[], log: (message: string) => void = () => {}, options: OrganizerOptions = {}) {
    this.store = store;
    for (const p of providers) this.providers.set(p.id, p);
    this.log = log;
    this.projectSettleMs = options.projectSettleMs ?? 1500;
  }

  sourceIds(): SourceId[] {
    return [...this.providers.keys()];
  }

  provider(source: SourceId): Provider {
    const p = this.providers.get(source);
    if (!p) throw new UserError(`Unknown source "${source}"`, 404);
    return p;
  }

  // ---- jobs ----------------------------------------------------------------------

  private startJob(
    kind: string,
    label: string,
    source: SourceId | undefined,
    run: (job: Job, progress: Progress) => Promise<void>,
  ): Job {
    const job: Job = {
      id: crypto.randomUUID(),
      kind,
      label,
      source,
      status: 'running',
      progress: { done: 0, message: 'Starting' },
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    while (this.jobs.size > MAX_JOBS) {
      const oldest = [...this.jobs.values()].find((j) => j.status !== 'running');
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
    const progress: Progress = (done, total, message) => {
      job.progress = { done, total, message };
    };
    const body = source ? () => this.withLock(source, () => run(job, progress)) : () => run(job, progress);
    body()
      .then(() => {
        job.status = 'done';
      })
      .catch((e) => {
        job.status = 'failed';
        job.error = String((e as Error)?.message ?? e);
        this.log(`job ${kind} failed: ${job.error}`);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
      });
    return job;
  }

  private withLock<T>(source: SourceId, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(source) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      source,
      run.catch(() => undefined),
    );
    return run;
  }

  job(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  listJobs(): Job[] {
    return [...this.jobs.values()].reverse();
  }

  // ---- status and listings ------------------------------------------------------

  async summaries(): Promise<SourceSummary[]> {
    return Promise.all(
      [...this.providers.values()].map(async (p) => {
        let status: ProviderStatus;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          status = await Promise.race([
            p.status(),
            new Promise<ProviderStatus>((resolve) => {
              timer = setTimeout(() => resolve({ available: true, message: 'Status check timed out' }), 5_000);
            }),
          ]);
        } catch (e) {
          status = { available: false, message: String((e as Error).message ?? e) };
        } finally {
          clearTimeout(timer);
        }
        const cache = this.store.readCache(p.id);
        return {
          id: p.id,
          label: p.label,
          status,
          count: cache ? this.store.withoutTombstoned(cache.items).length : 0,
          fetchedAt: cache?.fetchedAt,
          hasProjects: !!p.projects,
          projectColors: p.projects?.colors,
          hasTrash: typeof p.listTrash === 'function',
        };
      }),
    );
  }

  items(source?: SourceId): { items: Conversation[]; fetchedAt: Partial<Record<SourceId, string>> } {
    const items: Conversation[] = [];
    const fetchedAt: Partial<Record<SourceId, string>> = {};
    for (const id of source ? [source] : this.sourceIds()) {
      const cache = this.store.readCache(id);
      if (!cache) continue;
      fetchedAt[id] = cache.fetchedAt;
      items.push(...this.store.withoutTombstoned(cache.items));
    }
    return { items, fetchedAt };
  }

  private findItems(keys: string[]): { found: Conversation[]; missing: string[] } {
    const bySource = new Map<SourceId, Map<string, Conversation>>();
    const found: Conversation[] = [];
    const missing: string[] = [];
    for (const key of [...new Set(keys)]) {
      let parsed: { source: SourceId; id: string };
      try {
        parsed = parseItemKey(key);
      } catch {
        missing.push(key);
        continue;
      }
      if (!this.providers.has(parsed.source)) {
        missing.push(key);
        continue;
      }
      let index = bySource.get(parsed.source);
      if (!index) {
        index = new Map(this.items(parsed.source).items.map((i) => [i.id, i]));
        bySource.set(parsed.source, index);
      }
      const item = index.get(parsed.id);
      if (item) found.push(item);
      else missing.push(key);
    }
    return { found, missing };
  }

  private groupBySource(items: Conversation[]): Map<SourceId, Conversation[]> {
    const out = new Map<SourceId, Conversation[]>();
    for (const i of items) out.set(i.source, [...(out.get(i.source) ?? []), i]);
    return out;
  }

  refresh(source: SourceId): Job {
    this.provider(source);
    const running = [...this.jobs.values()].find((j) => j.kind === 'refresh' && j.source === source && j.status === 'running');
    if (running) return running;
    return this.startJob('refresh', `Refresh ${this.provider(source).label}`, source, async (job, progress) => {
      const provider = this.provider(source);
      const items = await provider.list(progress);
      this.store.writeCache(source, items);
      let projectNote = '';
      if (provider.projects) {
        try {
          this.store.writeProjects(source, await provider.projects.list());
        } catch (e) {
          projectNote = `; projects could not be read (${String((e as Error).message ?? e)})`;
        }
      }
      // Hand-off entries that disappeared from the source were deleted by the owning app.
      const present = new Set(items.map((i) => itemKey(i.source, i.id)));
      const gone = this.store
        .listHandoff()
        .filter((h) => h.source === source && !present.has(h.key))
        .map((h) => h.key);
      if (gone.length) this.store.removeHandoff(gone);
      job.summary = `${items.length} conversations${gone.length ? `; ${gone.length} hand-off deletions completed` : ''}${projectNote}`;
    });
  }

  async transcript(key: string, full = false): Promise<Transcript> {
    const { found } = this.findItems([key]);
    const item = found[0];
    if (!item) throw new UserError('Conversation not found. Refresh the list.', 404);
    return this.provider(item.source).getTranscript(item, { full });
  }

  // ---- deletion -------------------------------------------------------------------

  planDelete(keys: string[]): DeletePlan {
    const { found, missing } = this.findItems(keys);
    const plan: DeletePlan = {
      total: found.length,
      direct: 0,
      trash: 0,
      handoff: 0,
      none: 0,
      missing: missing.length,
      bySource: {},
      notes: [],
      cascade: 0,
      confirmPhrase: deleteConfirmPhrase(found.length),
    };
    const notes = new Map<string, number>();
    const selected = new Set(found.map((i) => i.id));
    const cascade = new Set<string>();
    for (const item of found) {
      plan[item.deleteMode]++;
      plan.bySource[item.source] = (plan.bySource[item.source] ?? 0) + 1;
      if (item.note) notes.set(item.note, (notes.get(item.note) ?? 0) + 1);
      const children = item.extra?.childTaskIds;
      if (Array.isArray(children)) for (const c of children) if (!selected.has(String(c))) cascade.add(String(c));
    }
    plan.cascade = cascade.size;
    plan.notes = [...notes.entries()].map(([note, n]) => (n > 1 ? `${note} (${n} items)` : note));
    return plan;
  }

  delete(keys: string[], options: { backup?: BackupMode; confirm?: string } = {}): Job {
    const { found, missing } = this.findItems(keys);
    const expected = deleteConfirmPhrase(found.length);
    if ((options.confirm ?? '').trim().toLowerCase() !== expected) {
      throw new UserError(`Confirmation text must be "${expected}".`);
    }
    const backup = options.backup ?? 'summary';
    return this.startJob('delete', `Delete ${found.length} conversations`, undefined, async (job, progress) => {
      const results: JobResult[] = missing.map((key) => ({ key, id: key, ok: false, error: 'Not found; refresh the list' }));
      for (const [source, items] of this.groupBySource(found)) {
        await this.withLock(source, () => this.deleteFromSource(source, items, backup, results, progress));
      }
      job.results = results;
      const ok = results.filter((r) => r.ok).length;
      job.summary = `${ok} of ${results.length} handled`;
      this.store.appendOp({
        op: 'delete',
        ok,
        failed: results.length - ok,
        details: results.slice(0, 500).map((r) => ({ key: r.key, title: r.title, ok: r.ok, error: r.error, detail: r.detail })),
      });
    });
  }

  private async deleteFromSource(
    source: SourceId,
    items: Conversation[],
    backup: BackupMode,
    results: JobResult[],
    progress: Progress,
  ): Promise<void> {
    const provider = this.provider(source);
    const push = (item: Conversation, r: ItemResult) => results.push({ ...r, key: itemKey(source, item.id), title: item.title });
    const handoff = items.filter((i) => i.deleteMode === 'handoff');
    if (handoff.length) {
      this.store.queueHandoff(handoff);
      for (const item of handoff) push(item, { id: item.id, ok: true, detail: 'Queued for deletion in the GitHub Copilot app' });
    }
    for (const item of items.filter((i) => i.deleteMode === 'none')) {
      push(item, { id: item.id, ok: false, error: item.note ?? 'This conversation cannot be deleted from the organizer' });
    }
    let deletable = items.filter((i) => i.deleteMode === 'direct' || i.deleteMode === 'trash');
    if (!deletable.length) return;

    const needsBackup = deletable.filter((i) => i.deleteMode === 'direct');
    if (backup !== 'none' && needsBackup.length) {
      let done = 0;
      const failed = new Set<string>();
      await mapLimit(needsBackup, 3, async (item) => {
        try {
          const transcript = await provider.getTranscript(item, { full: backup === 'full' });
          this.store.writeBackup(source, item.id, { item, transcript });
        } catch (e) {
          failed.add(item.id);
          push(item, {
            id: item.id,
            ok: false,
            error: `Backup failed (${String((e as Error).message ?? e)}), so it was not deleted. Turn off backups to delete it anyway.`,
          });
        } finally {
          done++;
          progress(done, needsBackup.length, `${provider.label}: backing up ${done}/${needsBackup.length}`);
        }
      });
      deletable = deletable.filter((i) => !failed.has(i.id));
    }
    if (!deletable.length) return;

    const byId = new Map(deletable.map((i) => [i.id, i]));
    let res: ItemResult[];
    try {
      res = await provider.deleteItems(deletable, (d, t, m) => progress(d, t, `${provider.label}: ${m}`));
    } catch (e) {
      res = deletable.map((i) => ({ id: i.id, ok: false, error: String((e as Error).message ?? e) }));
    }
    const removed = new Set<string>();
    for (const r of res) {
      const item = byId.get(r.id);
      if (item) push(item, r);
      if (r.ok) {
        removed.add(r.id);
        for (const extra of r.alsoRemoved ?? []) removed.add(extra);
      }
    }
    if (removed.size) {
      const keys = [...removed].map((id) => itemKey(source, id));
      this.store.addTombstones(keys);
      this.store.forgetItems(keys);
      this.store.patchCache(source, (all) => all.filter((i) => !removed.has(i.id)));
    }
  }

  // ---- native projects ---------------------------------------------------------------

  private nativeProjects(source: SourceId) {
    const projects = this.provider(source).projects;
    if (!projects) throw new UserError(`${this.provider(source).label} has no projects.`);
    return projects;
  }

  /** Cached projects (no network) unless `live`, with item counts from the cached listing. */
  async projects(source: SourceId, options: { live?: boolean } = {}): Promise<Project[]> {
    const native = this.nativeProjects(source);
    if (options.live) this.store.writeProjects(source, await native.list());
    const list = this.store.readProjects(source)?.projects ?? [];
    const counts = new Map<string, number>();
    for (const i of this.items(source).items) for (const p of i.projectIds ?? []) counts.set(p, (counts.get(p) ?? 0) + 1);
    return list.map((p) => ({ ...p, itemCount: counts.get(p.id) ?? 0 }));
  }

  async createProject(source: SourceId, name: string): Promise<Project> {
    const project = await this.nativeProjects(source).create(name);
    this.store.patchProjects(source, (all) => [...all.filter((p) => p.id !== project.id), project]);
    this.store.appendOp({ op: 'project-create', source, target: project.id, ok: 1, failed: 0, details: { name } });
    return project;
  }

  async updateProject(source: SourceId, projectId: string, patch: { name?: string; color?: string | null; archived?: boolean }): Promise<void> {
    const projects = this.nativeProjects(source);
    if (patch.name !== undefined) await projects.rename(projectId, patch.name);
    if (patch.color !== undefined) await projects.setColor(projectId, patch.color);
    if (patch.archived !== undefined) await projects.setArchived(projectId, patch.archived);
    this.store.patchProjects(source, (all) =>
      all.map((p) =>
        p.id !== projectId
          ? p
          : {
              ...p,
              ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
              ...(patch.color !== undefined ? { color: patch.color ?? projects.colors[0] } : {}),
              ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
            },
      ),
    );
    this.store.appendOp({ op: 'project-update', source, target: projectId, ok: 1, failed: 0, details: patch });
  }

  /** Adds items to a project, moving them out of their current project when needed. */
  assign(source: SourceId, projectId: string, keys: string[]): Job {
    const projects = this.nativeProjects(source);
    const { found, missing } = this.findItems(keys);
    const items = found.filter((i) => i.source === source);
    return this.startJob('assign', `Add ${items.length} to project`, source, async (job, progress) => {
      const res = await projects.addItems(projectId, items, progress);
      job.results = this.collect(source, items, res, missing);
      this.patchProjects(source, res, () => [projectId]);
      this.finishOp(job, 'project-assign', source, projectId);
    });
  }

  /** Removes items from whatever project they are in. */
  unassign(source: SourceId, keys: string[]): Job {
    const projects = this.nativeProjects(source);
    const { found, missing } = this.findItems(keys);
    const items = found.filter((i) => i.source === source && i.projectIds?.length);
    return this.startJob('unassign', `Remove ${items.length} from projects`, source, async (job, progress) => {
      const res: ItemResult[] = [];
      const byProject = new Map<string, Conversation[]>();
      for (const i of items) for (const p of i.projectIds ?? []) byProject.set(p, [...(byProject.get(p) ?? []), i]);
      for (const [pid, members] of byProject) res.push(...(await projects.removeItems(pid, members, progress)));
      job.results = this.collect(source, items, res, missing);
      this.patchProjects(source, res, () => []);
      this.finishOp(job, 'project-unassign', source);
    });
  }

  /**
   * Deletes a project. `contents: 'keep'` first detaches its items so they survive;
   * `contents: 'delete'` deletes them (with backups) before deleting the project.
   */
  deleteProject(source: SourceId, projectId: string, options: { contents: 'keep' | 'delete'; backup?: BackupMode; confirm?: string }): Job {
    const projects = this.nativeProjects(source);
    const members = this.items(source).items.filter((i) => i.projectIds?.includes(projectId));
    if (options.contents === 'delete') {
      const expected = deleteConfirmPhrase(members.length);
      if ((options.confirm ?? '').trim().toLowerCase() !== expected) throw new UserError(`Confirmation text must be "${expected}".`);
    }
    return this.startJob('project-delete', 'Delete project', source, async (job, progress) => {
      const results: JobResult[] = [];
      if (members.length && options.contents === 'keep') {
        const res = await projects.removeItems(projectId, members, progress);
        results.push(...this.collect(source, members, res, []));
        this.patchProjects(source, res, () => []);
        const failed = res.filter((r) => !r.ok).length;
        if (failed) throw new Error(`${failed} items could not be removed from the project, so the project was kept.`);
      } else if (members.length) {
        await this.deleteFromSource(source, members, options.backup ?? 'summary', results, progress);
        const failed = results.filter((r) => !r.ok).length;
        if (failed) throw new Error(`${failed} items could not be deleted, so the project was kept.`);
      }
      // The cache can be stale, and the service may delete whatever is still inside the
      // project, so confirm it is really empty before deleting it.
      if (projects.memberCount) {
        progress(members.length, members.length, 'Checking that the project is empty');
        let remaining = await projects.memberCount(projectId);
        for (let attempt = 0; remaining > 0 && attempt < 3; attempt++) {
          await sleep(this.projectSettleMs);
          remaining = await projects.memberCount(projectId);
        }
        if (remaining > 0) {
          throw new Error(
            `The project still contains ${remaining} item(s) the organizer did not know about, so it was kept. Refresh the list and try again.`,
          );
        }
      }
      progress(members.length, members.length, 'Deleting the project');
      await projects.delete(projectId);
      this.store.patchProjects(source, (all) => all.filter((p) => p.id !== projectId));
      job.results = results;
      job.summary = `Project deleted${members.length ? `; ${members.length} items ${options.contents === 'keep' ? 'kept' : 'deleted'}` : ''}`;
      this.store.appendOp({ op: 'project-delete', source, target: projectId, ok: 1, failed: 0, details: { contents: options.contents, items: members.length } });
    });
  }

  private collect(source: SourceId, items: Conversation[], res: ItemResult[], missing: string[]): JobResult[] {
    const byId = new Map(items.map((i) => [i.id, i]));
    return [
      ...res.map((r) => ({ ...r, key: itemKey(source, r.id), title: byId.get(r.id)?.title })),
      ...missing.map((key) => ({ key, id: key, ok: false, error: 'Not found; refresh the list' })),
    ];
  }

  private patchProjects(source: SourceId, res: ItemResult[], next: (item: Conversation) => string[]): void {
    const ok = new Set(res.filter((r) => r.ok).map((r) => r.id));
    if (!ok.size) return;
    this.store.patchCache(source, (all) => all.map((i) => (ok.has(i.id) ? { ...i, projectIds: next(i) } : i)));
  }

  private finishOp(job: Job, op: string, source: SourceId, target?: string): void {
    const results = job.results ?? [];
    const ok = results.filter((r) => r.ok).length;
    job.summary = `${ok} of ${results.length} succeeded`;
    this.store.appendOp({
      op,
      source,
      target,
      ok,
      failed: results.length - ok,
      details: results.slice(0, 500).map((r) => ({ key: r.key, title: r.title, ok: r.ok, error: r.error })),
    });
  }

  // ---- hand-off, trash ---------------------------------------------------------------

  handoff(): { entries: HandoffEntry[]; request: string } {
    const entries = this.store.listHandoff();
    return { entries, request: handoffRequest(entries) };
  }

  queueHandoff(keys: string[]): number {
    const { found } = this.findItems(keys);
    return this.store.queueHandoff(found.filter((i) => i.deleteMode === 'handoff'));
  }

  async trash(source: SourceId): Promise<Conversation[]> {
    const p = this.provider(source);
    return p.listTrash ? p.listTrash() : [];
  }

  restore(source: SourceId, ids: string[]): Job {
    const p = this.provider(source);
    if (!p.restoreItems) throw new UserError(`${p.label} has no trash.`);
    return this.startJob('restore', `Restore ${ids.length} conversations`, source, async (job, progress) => {
      progress(0, ids.length, 'Restoring');
      const res = await p.restoreItems!(ids);
      job.results = res.map((r) => ({ ...r, key: itemKey(source, r.id) }));
      this.store.removeTombstones(res.filter((r) => r.ok).map((r) => itemKey(source, r.id)));
      progress(ids.length, ids.length, 'Refreshing the list');
      this.store.writeCache(source, await p.list());
      this.finishOp(job, 'restore', source);
    });
  }

  async close(): Promise<void> {
    for (const p of this.providers.values()) await p.close?.().catch(() => {});
  }
}

/** Builds the request to paste into the GitHub Copilot app, which deletes its own sessions. */
export function handoffRequest(entries: HandoffEntry[]): string {
  const gh = entries.filter((e) => e.source === 'ghapp');
  if (!gh.length) return '';
  const lines = gh.map((e, i) => `${i + 1}. "${e.title.replace(/"/g, "'")}" (id: ${e.id})`);
  return [
    `Please delete these ${gh.length} GitHub Copilot sessions/chats with the delete_item tool.`,
    'I reviewed this list in Copilot Chat Organizer and confirm I want every one of them deleted:',
    '',
    ...lines,
    '',
    'Skip any id you cannot find and tell me which ones were skipped.',
  ].join('\n');
}
