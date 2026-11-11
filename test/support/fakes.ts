// In-memory providers for organizer and server tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type {
  Conversation,
  ItemResult,
  NativeProjects,
  Progress,
  Project,
  Provider,
  ProviderStatus,
  SourceId,
  Transcript,
} from '../../src/core/types.ts';
import type { Job, Organizer } from '../../src/core/organizer.ts';
import { sleep } from '../../src/lib/async.ts';

export function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cco-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function conv(source: SourceId, id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    source,
    id,
    kind: 'chat',
    title: `Chat ${id}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    deleteMode: 'direct',
    ...extra,
  };
}

export async function waitJob(organizer: Organizer, job: Job, timeoutMs = 5_000): Promise<Job> {
  const started = Date.now();
  for (;;) {
    const current = organizer.job(job.id);
    if (!current) throw new Error(`job ${job.id} disappeared`);
    if (current.status !== 'running') return current;
    if (Date.now() - started > timeoutMs) throw new Error(`job ${job.kind} did not finish`);
    await sleep(5);
  }
}

export class FakeProjects implements NativeProjects {
  readonly colors = ['gray', 'blue', 'green'];
  readonly projects = new Map<string, Project>();
  /** projectId -> member item ids. */
  readonly members = new Map<string, Set<string>>();
  /** Members the organizer's listing does not know about (projectId -> count). */
  readonly hidden = new Map<string, number>();
  readonly calls: string[] = [];
  readonly failAdd = new Set<string>();
  readonly failRemove = new Set<string>();
  delayMs = 0;
  active = 0;
  maxActive = 0;
  private next = 1;

  private get(projectId: string): Project {
    const p = this.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    return p;
  }

  projectOf(itemId: string): string | undefined {
    for (const [pid, set] of this.members) if (set.has(itemId)) return pid;
    return undefined;
  }

  forget(itemId: string): void {
    for (const set of this.members.values()) set.delete(itemId);
  }

  async list(): Promise<Project[]> {
    return [...this.projects.values()].map((p) => ({ ...p }));
  }

  async create(name: string): Promise<Project> {
    const p: Project = { id: `p${this.next++}`, name, color: this.colors[0] };
    this.projects.set(p.id, p);
    this.members.set(p.id, new Set());
    this.calls.push(`create ${p.id}`);
    return { ...p };
  }

  async rename(projectId: string, name: string): Promise<void> {
    this.get(projectId).name = name;
  }

  async setColor(projectId: string, color: string | null): Promise<void> {
    this.get(projectId).color = color ?? this.colors[0];
  }

  async setArchived(projectId: string, archived: boolean): Promise<void> {
    this.get(projectId).archived = archived;
  }

  async delete(projectId: string): Promise<void> {
    this.get(projectId);
    this.calls.push(`delete ${projectId}`);
    this.projects.delete(projectId);
    this.members.delete(projectId);
  }

  private async track<T>(fn: () => T): Promise<T> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) await sleep(this.delayMs);
      return fn();
    } finally {
      this.active--;
    }
  }

  addItems(projectId: string, items: Conversation[], progress?: Progress): Promise<ItemResult[]> {
    return this.track(() => {
      this.get(projectId);
      return items.map((item, i) => {
        progress?.(i + 1, items.length, 'adding');
        if (this.failAdd.has(item.id)) return { id: item.id, ok: false, error: 'add failed' };
        this.forget(item.id);
        this.members.get(projectId)!.add(item.id);
        this.calls.push(`add ${projectId} ${item.id}`);
        return { id: item.id, ok: true };
      });
    });
  }

  removeItems(projectId: string, items: Conversation[], progress?: Progress): Promise<ItemResult[]> {
    return this.track(() =>
      items.map((item, i) => {
        progress?.(i + 1, items.length, 'removing');
        if (this.failRemove.has(item.id)) return { id: item.id, ok: false, error: 'remove failed' };
        this.members.get(projectId)?.delete(item.id);
        this.calls.push(`remove ${projectId} ${item.id}`);
        return { id: item.id, ok: true };
      }),
    );
  }

  async memberCount(projectId: string): Promise<number> {
    return (this.members.get(projectId)?.size ?? 0) + (this.hidden.get(projectId) ?? 0);
  }
}

export class FakeProvider implements Provider {
  readonly id: SourceId;
  readonly label: string;
  items: Conversation[];
  readonly projects?: FakeProjects;
  readonly trashed: Conversation[] = [];
  readonly deletedIds: string[] = [];
  readonly transcriptCalls: Array<{ id: string; full: boolean }> = [];
  readonly failTranscript = new Set<string>();
  readonly failDelete = new Set<string>();
  /** item id -> ids the "service" removes together with it. */
  readonly cascades: Record<string, string[]> = {};
  statusValue: ProviderStatus = { available: true };
  listTrash?: () => Promise<Conversation[]>;
  restoreItems?: (ids: string[]) => Promise<ItemResult[]>;

  constructor(id: SourceId, items: Conversation[], options: { projects?: boolean; trash?: boolean } = {}) {
    this.id = id;
    this.label = `Fake ${id}`;
    this.items = items;
    if (options.projects) this.projects = new FakeProjects();
    if (options.trash) {
      this.listTrash = async () => this.trashed.map((i) => ({ ...i }));
      this.restoreItems = async (ids) =>
        ids.map((id) => {
          const idx = this.trashed.findIndex((i) => i.id === id);
          if (idx < 0) return { id, ok: false, error: 'not in trash' };
          this.items.push(...this.trashed.splice(idx, 1));
          return { id, ok: true };
        });
    }
  }

  async status(): Promise<ProviderStatus> {
    return this.statusValue;
  }

  async list(progress?: Progress): Promise<Conversation[]> {
    progress?.(this.items.length, this.items.length, 'listed');
    return this.items.map((i) => {
      const pid = this.projects?.projectOf(i.id);
      return { ...i, ...(this.projects ? { projectIds: pid ? [pid] : [] } : {}) };
    });
  }

  async getTranscript(item: Conversation, options: { full?: boolean } = {}): Promise<Transcript> {
    this.transcriptCalls.push({ id: item.id, full: options.full === true });
    if (this.failTranscript.has(item.id)) throw new Error('transcript unavailable');
    return { source: this.id, id: item.id, title: item.title, messages: [{ role: 'user', text: `hello from ${item.id}` }] };
  }

  async deleteItems(items: Conversation[], progress?: Progress): Promise<ItemResult[]> {
    return items.map((item, i) => {
      progress?.(i + 1, items.length, 'deleting');
      if (this.failDelete.has(item.id)) return { id: item.id, ok: false, error: 'delete failed' };
      const also = this.cascades[item.id] ?? [];
      const gone = new Set([item.id, ...also]);
      this.deletedIds.push(item.id);
      if (item.deleteMode === 'trash') this.trashed.push(...this.items.filter((x) => x.id === item.id));
      this.items = this.items.filter((x) => !gone.has(x.id));
      for (const id of gone) this.projects?.forget(id);
      return { id: item.id, ok: true, alsoRemoved: also.length ? also : undefined };
    });
  }
}
