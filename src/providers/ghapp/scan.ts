// Reads session-state/<id>/ folders: workspace.yaml metadata and in-use markers.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readTopLevelScalars } from './yaml.ts';
import { UUID_RE, forEachLimit, isSafeId, sleep } from './util.ts';

export interface SessionDir {
  id: string;
  dir: string;
  /** Top-level scalars of workspace.yaml; undefined when the file is missing. */
  yaml?: Record<string, string>;
  hasEvents: boolean;
  eventsSize?: number;
  eventsMtimeMs?: number;
  /** Process ids from inuse.<pid>.lock / inuse.<pid>.hold markers (live or stale). */
  lockPids: number[];
}

const LOCK_RE = /^inuse\.(\d+)\.(?:lock|hold)$/i;

export function lockPidsFrom(entries: string[]): number[] {
  const pids = new Set<number>();
  for (const e of entries) {
    const m = LOCK_RE.exec(e);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * Reads one session folder. UUID-named folders are sessions; other names count only
 * when they hold workspace.yaml or events.jsonl (skips optimistic-chat-*, probes, ...).
 */
export async function readSessionDir(root: string, name: string): Promise<SessionDir | undefined> {
  if (!isSafeId(name)) return undefined;
  const dir = path.join(root, name);
  const uuid = UUID_RE.test(name);
  const [entries, yamlText] = await Promise.all([
    fsp.readdir(dir).catch(() => undefined),
    uuid ? fsp.readFile(path.join(dir, 'workspace.yaml'), 'utf8').catch(() => undefined) : Promise.resolve(undefined),
  ]);
  if (!entries) return undefined;
  const hasYaml = entries.includes('workspace.yaml');
  const listsEvents = entries.includes('events.jsonl');
  if (!uuid && !hasYaml && !listsEvents) return undefined;
  const [source, events] = await Promise.all([
    yamlText === undefined && hasYaml ? fsp.readFile(path.join(dir, 'workspace.yaml'), 'utf8').catch(() => undefined) : Promise.resolve(yamlText),
    listsEvents ? fsp.stat(path.join(dir, 'events.jsonl')).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  const hasEvents = !!events?.isFile();
  return {
    id: name,
    dir,
    yaml: source === undefined ? undefined : readTopLevelScalars(source),
    hasEvents,
    eventsSize: hasEvents ? events?.size : undefined,
    eventsMtimeMs: hasEvents ? events?.mtimeMs : undefined,
    lockPids: lockPidsFrom(entries),
  };
}

/** Scans every session folder under `root` with bounded concurrency. */
export async function scanSessionState(
  root: string,
  onProgress?: (done: number, total: number) => void,
  concurrency = 32,
): Promise<SessionDir[]> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fsp.readdir(root, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const names = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  const found: Array<SessionDir | undefined> = new Array(names.length);
  let done = 0;
  await forEachLimit(names, concurrency, async (name, i) => {
    found[i] = await readSessionDir(root, name);
    done++;
    if (onProgress && (done % 500 === 0 || done === names.length)) onProgress(done, names.length);
  });
  return found.filter((d): d is SessionDir => d !== undefined);
}

function retryable(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY';
}

/**
 * Moves a folder. Retries briefly on Windows sharing violations and falls back to
 * copy + remove across volumes. Never overwrites an existing destination.
 */
export async function moveDir(from: string, to: string): Promise<void> {
  if (fs.existsSync(to)) throw new Error(`Destination already exists: ${to}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') break;
      if (retryable(e) && attempt < 5 && !fs.existsSync(to)) {
        await sleep(150 * attempt);
        continue;
      }
      throw e;
    }
  }
  try {
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } catch (e) {
    fs.rmSync(to, { recursive: true, force: true });
    throw e;
  }
  try {
    fs.rmSync(from, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    // Put back whatever was already removed so the original stays complete, then drop the copy.
    fs.cpSync(to, from, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
    fs.rmSync(to, { recursive: true, force: true, maxRetries: 3 });
    throw e;
  }
}
