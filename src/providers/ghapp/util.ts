// Small helpers shared by the GitHub Copilot app & CLI provider.
import fs from 'node:fs';
import path from 'node:path';
import { toIso } from '../../core/types.ts';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `id` can be used as a single path segment (no separators, no leading dot). */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(id);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Trimmed non-empty string, or undefined. Numbers are stringified. */
export function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : undefined;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

const TAG_RE = /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g;

/** Whitespace-collapsed single line capped at `max` characters (ellipsis when cut). */
export function oneLine(value: unknown, max: number, stripTags = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  let s = value.length > max * 8 + 4096 ? value.slice(0, max * 8 + 4096) : value;
  if (stripTags) s = s.replace(TAG_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  if (s.length > max) {
    let cut = s.slice(0, max - 1);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    s = `${cut.trimEnd()}…`;
  }
  return s;
}

/** First value that converts to an ISO date. */
export function firstIso(...values: unknown[]): string | undefined {
  for (const v of values) {
    const iso = toIso(v);
    if (iso) return iso;
  }
  return undefined;
}

/** Latest of the values that convert to ISO dates. */
export function latestIso(...values: unknown[]): string | undefined {
  let best: string | undefined;
  for (const v of values) {
    const iso = toIso(v);
    if (iso && (!best || iso > best)) best = iso;
  }
  return best;
}

/** Drops undefined, null, empty-string and empty-array values. */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `child` is `parent` or inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function forEachLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}

/** True when a process with this id is running (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid: number, cache?: Map<number, boolean>): boolean {
  const known = cache?.get(pid);
  if (known !== undefined) return known;
  let alive: boolean;
  if (pid === process.pid) alive = true;
  else {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  cache?.set(pid, alive);
  return alive;
}
