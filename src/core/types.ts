// Shared model for every conversation source (M365 Copilot/Cowork, GitHub Copilot app/CLI,
// VS Code Copilot Chat, github.com Copilot Chat).

export type SourceId = 'm365' | 'ghapp' | 'vscode' | 'ghweb';

/**
 * How the organizer can delete an item.
 * - direct:  the provider deletes it through the owning service (M365, github.com).
 * - trash:   the provider moves local files into the organizer's trash (restorable).
 * - handoff: another app owns it; the organizer queues it and produces a request the
 *            owning app can act on (e.g. GitHub Copilot app sessions).
 * - none:    cannot be deleted from here.
 */
export type DeleteMode = 'direct' | 'trash' | 'handoff' | 'none';

export interface Conversation {
  source: SourceId;
  /** Unique within the source and stable across listings. */
  id: string;
  /** Provider-specific type, e.g. 'chat', 'cowork-task', 'app-chat', 'cli-session'. */
  kind: string;
  title: string;
  /** ISO 8601. */
  createdAt?: string;
  /** ISO 8601. */
  updatedAt?: string;
  /** Opens the item in its native app or web page. */
  url?: string;
  /** Repository, workspace folder or working directory, when meaningful. */
  location?: string;
  /** Native project membership (only for sources with native projects). */
  projectIds?: string[];
  messageCount?: number;
  preview?: string;
  /** Short state label, e.g. Cowork task state. */
  status?: string;
  deleteMode: DeleteMode;
  /** Explains a limitation or side effect, shown next to the item. */
  note?: string;
  /** ISO 8601; set on items listed from the organizer trash. */
  deletedAt?: string;
  /** Provider-private data needed for later operations (thread ids, file paths, ...). */
  extra?: Record<string, unknown>;
}

export interface Project {
  id: string;
  name: string;
  color?: string;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  itemCount?: number;
}

export type TranscriptRole = 'user' | 'assistant' | 'system' | 'tool' | 'status';

export interface TranscriptMessage {
  role: TranscriptRole;
  text: string;
  /** ISO 8601. */
  at?: string;
}

export interface Transcript {
  source: SourceId;
  id: string;
  title: string;
  messages: TranscriptMessage[];
  /** True when only part of the conversation could be read. */
  partial?: boolean;
  note?: string;
  /** Original payload, kept in pre-delete backups. */
  raw?: unknown;
}

export interface ItemResult {
  id: string;
  ok: boolean;
  error?: string;
  detail?: string;
  /** Other ids (same source) that the service removed as a side effect. */
  alsoRemoved?: string[];
}

export type Progress = (done: number, total: number | undefined, message: string) => void;

export interface ProviderStatus {
  available: boolean;
  /** For sources that need a sign-in; undefined when not applicable. */
  signedIn?: boolean;
  message?: string;
  warnings?: string[];
}

export interface ProviderContext {
  /** The organizer's private data directory (.data). */
  dataDir: string;
  /** Destination for 'trash' deletes: <dataDir>/trash/<source>. Create on demand. */
  trashDir: string;
  log: (message: string) => void;
}

export interface NativeProjects {
  /** Colors the service accepts, first is the default. */
  readonly colors: string[];
  list(): Promise<Project[]>;
  create(name: string): Promise<Project>;
  rename(projectId: string, name: string): Promise<void>;
  setColor(projectId: string, color: string | null): Promise<void>;
  setArchived(projectId: string, archived: boolean): Promise<void>;
  delete(projectId: string): Promise<void>;
  addItems(projectId: string, items: Conversation[], progress?: Progress): Promise<ItemResult[]>;
  removeItems(projectId: string, items: Conversation[], progress?: Progress): Promise<ItemResult[]>;
  /** Live number of items in the project, read from the service (not the cache). */
  memberCount?(projectId: string): Promise<number>;
}

export interface Provider {
  readonly id: SourceId;
  readonly label: string;
  status(): Promise<ProviderStatus>;
  list(progress?: Progress): Promise<Conversation[]>;
  /** `full` asks for the complete conversation when the default view is a summary. */
  getTranscript(item: Conversation, options?: { full?: boolean }): Promise<Transcript>;
  /**
   * Deletes items whose deleteMode is 'direct' or 'trash'. Per-item failures are
   * reported in the results; the method only throws when the whole source is unusable.
   */
  deleteItems(items: Conversation[], progress?: Progress): Promise<ItemResult[]>;
  /** Restores items previously moved to the organizer's trash. */
  restoreItems?(ids: string[]): Promise<ItemResult[]>;
  /** Lists items currently in the organizer's trash for this source. */
  listTrash?(): Promise<Conversation[]>;
  projects?: NativeProjects;
  close?(): Promise<void>;
}

export const itemKey = (source: SourceId, id: string): string => `${source}:${id}`;

export function parseItemKey(key: string): { source: SourceId; id: string } {
  const i = key.indexOf(':');
  if (i <= 0) throw new Error(`invalid item key: ${key}`);
  return { source: key.slice(0, i) as SourceId, id: key.slice(i + 1) };
}

/** Converts epoch milliseconds/seconds or a date string to ISO 8601; undefined when unknown. */
export function toIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '' || value === 0) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1990 ? undefined : d.toISOString();
  }
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (/^\d{9,}$/.test(value) && Number.isFinite(asNum)) return toIso(asNum);
    const d = new Date(value);
    return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1990 ? undefined : d.toISOString();
  }
  return undefined;
}
