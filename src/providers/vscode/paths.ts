// Locations of VS Code's chat storage and the organizer's item ids for VS Code chats.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface VsCodeRoot {
  /** 'stable', 'insiders', ... (no ':' characters). */
  edition: string;
  /** The VS Code "User" folder, e.g. %APPDATA%\Code\User. */
  userDir: string;
}

/** Pseudo workspace hash used in ids of chats opened without a folder or workspace. */
export const EMPTY_WINDOW = 'empty-window';
/** Pre-2025 storage folder for empty-window chats (workspaceStorage/no-workspace/chatSessions). */
export const LEGACY_EMPTY_WINDOW = 'no-workspace';

/** Session ids, workspace hashes and editions must be plain file-name segments. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function isSafeSegment(value: string): boolean {
  return SEGMENT.test(value);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function appDataBase(): string {
  if (process.env.VSCODE_APPDATA) return process.env.VSCODE_APPDATA;
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** Every VS Code Stable / Insiders user folder that exists on this machine. */
export function defaultRoots(): VsCodeRoot[] {
  const base = appDataBase();
  return [
    { edition: 'stable', userDir: path.join(base, 'Code', 'User') },
    { edition: 'insiders', userDir: path.join(base, 'Code - Insiders', 'User') },
  ].filter((r) => isDir(r.userDir));
}

export const workspaceStorageDir = (root: VsCodeRoot): string => path.join(root.userDir, 'workspaceStorage');
export const globalStateDb = (root: VsCodeRoot): string => path.join(root.userDir, 'globalStorage', 'state.vscdb');
export const emptyWindowSessionsDir = (root: VsCodeRoot): string =>
  path.join(root.userDir, 'globalStorage', 'emptyWindowChatSessions');

/** Folder holding the session files of a workspace hash (or of empty windows). */
export function sessionsDir(root: VsCodeRoot, workspaceHash: string): string {
  return workspaceHash === EMPTY_WINDOW
    ? emptyWindowSessionsDir(root)
    : path.join(workspaceStorageDir(root), workspaceHash, 'chatSessions');
}

export function isEmptyWindowHash(workspaceHash: string): boolean {
  return workspaceHash === EMPTY_WINDOW || workspaceHash === LEGACY_EMPTY_WINDOW;
}

export function makeItemId(edition: string, workspaceHash: string, sessionId: string): string {
  return `${edition}:${workspaceHash}:${sessionId}`;
}

export interface ParsedItemId {
  edition: string;
  workspaceHash: string;
  sessionId: string;
}

/** Parses `<edition>:<workspaceHash>:<sessionId>`; undefined unless every part is a safe segment. */
export function parseItemId(id: string): ParsedItemId | undefined {
  const parts = typeof id === 'string' ? id.split(':') : [];
  if (parts.length !== 3) return undefined;
  const [edition, workspaceHash, sessionId] = parts;
  if (!isSafeSegment(edition) || !isSafeSegment(workspaceHash) || !isSafeSegment(sessionId)) return undefined;
  return { edition, workspaceHash, sessionId };
}

/** Turns a workspace.json folder/workspace URI into a readable path. */
export function describeWorkspaceUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === 'file:') {
      const p = decodeURIComponent(u.pathname);
      if (u.host) return `\\\\${u.host}${p.replace(/\//g, '\\')}`;
      if (/^\/[A-Za-z]:/.test(p)) return `${p[1].toUpperCase()}${p.slice(2)}`.replace(/\//g, '\\');
      return p;
    }
    if (u.protocol === 'vscode-remote:') return `${decodeURIComponent(u.host)}:${decodeURIComponent(u.pathname)}`;
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

/** True when `target` is strictly inside one of `dirs`. */
export function isInside(target: string, dirs: string[]): boolean {
  const t = path.resolve(target);
  return dirs.some((d) => {
    const rel = path.relative(path.resolve(d), t);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}
