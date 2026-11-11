// Detects whether a VS Code edition is running. VS Code keeps the chat index in memory and
// writes it back while running, so chats may only be moved while it is closed.
import { execFile } from 'node:child_process';

export type IsRunning = (edition: string) => Promise<boolean>;

const COMMAND_TIMEOUT_MS = 15_000;

/** Lower-cased executable names (Windows/Linux) or app bundle names (macOS) of an edition. */
export function executableNames(edition: string, platform: NodeJS.Platform = process.platform): string[] {
  const e = edition.toLowerCase();
  if (platform === 'win32') return [e === 'stable' ? 'code.exe' : `code - ${e}.exe`];
  if (platform === 'darwin') return [e === 'stable' ? 'visual studio code.app' : `visual studio code - ${e}.app`];
  return [e === 'stable' ? 'code' : `code-${e}`];
}

/** Image names from `tasklist /FO CSV /NH` output ("Code.exe","1234","Console","1","123,456 K"). */
export function parseTasklistCsv(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

/** Names of running processes (full executable paths on macOS). */
export async function listProcessNames(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform === 'win32') {
    try {
      const names = parseTasklistCsv(await run('tasklist', ['/FO', 'CSV', '/NH']));
      if (names.length) return names;
    } catch {
      // fall back to PowerShell
    }
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Process | ForEach-Object { $_.ProcessName + ".exe" }',
    ]);
    const names = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) throw new Error('no processes listed');
    return names;
  }
  const names = (await run('ps', ['-A', '-o', 'comm='])).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error('no processes listed');
  return names;
}

export function editionIsRunning(names: Set<string>, edition: string, platform: NodeJS.Platform = process.platform): boolean {
  const wanted = executableNames(edition, platform);
  if (platform === 'darwin') {
    for (const name of names) if (wanted.some((app) => name.includes(`/${app}/`))) return true;
    return false;
  }
  if (wanted.some((n) => names.has(n))) return true;
  // Linux ps truncates command names to 15 characters.
  return platform !== 'win32' && wanted.some((n) => n.length > 15 && names.has(n.slice(0, 15)));
}

export interface ProcessDetectorOptions {
  ttlMs?: number;
  platform?: NodeJS.Platform;
  listProcesses?: () => Promise<string[]>;
  log?: (message: string) => void;
}

/** Process snapshot shared by all editions, cached for a few seconds. */
export class ProcessDetector {
  private readonly ttlMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly listProcesses: () => Promise<string[]>;
  private readonly log: (message: string) => void;
  private cached: { at: number; names: Set<string> | undefined } | undefined;
  private inflight: Promise<Set<string> | undefined> | undefined;

  constructor(options: ProcessDetectorOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5000;
    this.platform = options.platform ?? process.platform;
    this.listProcesses = options.listProcesses ?? (() => listProcessNames(this.platform));
    this.log = options.log ?? (() => {});
  }

  /** Lower-cased process names; undefined when they could not be listed. */
  snapshot(fresh = false): Promise<Set<string> | undefined> {
    if (this.inflight) return this.inflight;
    if (!fresh && this.cached && Date.now() - this.cached.at < this.ttlMs) return Promise.resolve(this.cached.names);
    const promise = Promise.resolve()
      .then(() => this.listProcesses())
      .then(
        (names) => new Set(names.map((n) => n.toLowerCase())),
        (err: unknown) => {
          this.log(`could not list running processes (${err instanceof Error ? err.message : String(err)}); assuming VS Code is running`);
          return undefined;
        },
      )
      .then((names) => {
        this.cached = { at: Date.now(), names };
        this.inflight = undefined;
        return names;
      });
    this.inflight = promise;
    return promise;
  }

  /** True when the edition is running or when that cannot be determined. */
  async isRunning(edition: string, fresh = false): Promise<boolean> {
    const names = await this.snapshot(fresh);
    return names === undefined ? true : editionIsRunning(names, edition, this.platform);
  }
}
