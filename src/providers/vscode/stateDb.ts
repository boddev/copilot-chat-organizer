// Reads and edits VS Code's chat session index.
//
// VS Code keeps its key/value storage in SQLite files named state.vscdb with a single table
// `ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`; values are JSON text. The
// chat history list is driven by the key `chat.ChatSessionStore.index`:
//   { "version": 1, "entries": { "<sessionId>": { sessionId, title, lastMessageDate,
//     timing: { created, lastRequestEnded }, isEmpty, isExternal, initialLocation, ... } } }
// Workspace chats are indexed in workspaceStorage/<hash>/state.vscdb and empty-window chats
// in globalStorage/state.vscdb. VS Code deletes a chat by removing its entry and its file.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isObject, type JsonObject } from './session.ts';

export const CHAT_INDEX_KEY = 'chat.ChatSessionStore.index';
const BUSY_TIMEOUT_MS = 5000;

export interface ChatIndex {
  version?: unknown;
  entries: Record<string, JsonObject>;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function decode(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return undefined;
}

function toIndex(doc: unknown): ChatIndex | undefined {
  if (!isObject(doc)) return undefined;
  // No prototype, so ids like "constructor" never resolve to inherited members.
  const entries = Object.create(null) as Record<string, JsonObject>;
  if (isObject(doc.entries)) {
    for (const [id, entry] of Object.entries(doc.entries)) if (isObject(entry)) entries[id] = entry;
  }
  return { version: doc.version, entries };
}

function openReadOnly(dbFile: string): DatabaseSync {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/** The chat index of a state database; undefined when the file or the key is missing. */
export function readChatIndex(dbFile: string): ChatIndex | undefined {
  if (!fs.existsSync(dbFile)) return undefined;
  const db = openReadOnly(dbFile);
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(CHAT_INDEX_KEY);
    const text = decode(row?.value);
    if (text === undefined) return undefined;
    try {
      return toIndex(JSON.parse(text));
    } catch {
      return undefined;
    }
  } finally {
    db.close();
  }
}

/**
 * Runs `edit` on the parsed index inside a write transaction. `edit` returns true when it
 * changed the document, which is then written back with the original value type.
 */
function editChatIndex(dbFile: string, createIfMissing: JsonObject | undefined, edit: (entries: JsonObject) => boolean): void {
  // DatabaseSync would create a missing file; never create databases in VS Code's folders.
  if (!fs.existsSync(dbFile)) throw new Error(`VS Code state database not found: ${dbFile}`);
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(CHAT_INDEX_KEY);
      let doc: unknown;
      if (row) {
        const text = decode(row.value);
        if (text === undefined) throw new Error('the chat index has an unexpected value type');
        try {
          doc = JSON.parse(text);
        } catch {
          throw new Error('the chat index is not valid JSON; leaving it untouched');
        }
      } else {
        doc = createIfMissing;
      }
      if (!isObject(doc)) {
        db.exec('ROLLBACK');
        return;
      }
      if (!isObject(doc.entries)) doc.entries = {};
      if (edit(doc.entries as JsonObject)) {
        const json = JSON.stringify(doc);
        const value = row && row.value instanceof Uint8Array ? new TextEncoder().encode(json) : json;
        if (row) db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(value, CHAT_INDEX_KEY);
        else db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(CHAT_INDEX_KEY, value);
        db.exec('COMMIT');
      } else {
        db.exec('ROLLBACK');
      }
    } catch (err) {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch {
        // the original error matters more
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/** Removes a session's index entry; returns the removed entry (undefined when there was none). */
export function removeIndexEntry(dbFile: string, sessionId: string): unknown {
  if (UNSAFE_KEYS.has(sessionId)) return undefined;
  let removed: unknown;
  editChatIndex(dbFile, undefined, (entries) => {
    removed = Object.hasOwn(entries, sessionId) ? entries[sessionId] : undefined;
    if (removed === undefined) return false;
    delete entries[sessionId];
    return true;
  });
  return removed;
}

/**
 * Adds (or replaces) a session's index entry; creates the index key when it is missing.
 * Returns the entry it replaced, if any.
 */
export function putIndexEntry(dbFile: string, sessionId: string, entry: unknown, version: unknown = 1): unknown {
  if (UNSAFE_KEYS.has(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  if (entry === undefined) throw new Error('missing index entry');
  let previous: unknown;
  editChatIndex(dbFile, { version, entries: {} }, (entries) => {
    previous = Object.hasOwn(entries, sessionId) ? entries[sessionId] : undefined;
    entries[sessionId] = entry;
    return true;
  });
  return previous;
}
