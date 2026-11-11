// Shared Microsoft Edge instance driven by Playwright with a dedicated profile. Only one
// process can open a profile at a time, so every browser-backed provider (M365 Copilot,
// github.com) shares this session and asks for its own named page.
import { chromium, type BrowserContext, type Page, type Request } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import { sleep } from './async.ts';

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1';

export type BrowserMode = 'auto' | 'headless' | 'visible';

export const DEFAULT_PROFILE_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'),
  'copilot-chat-organizer',
  'browser-profile',
);

/** Thrown when an interactive sign-in is needed but the session cannot show a window. */
export class SignInRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInRequiredError';
  }
}

export interface BearerToken {
  /** Full authorization header value. Kept in memory only. */
  header: string;
  aud: string;
  /** Expiry, epoch seconds. */
  exp: number;
  origin: string;
  claims: Record<string, unknown>;
}

export function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Extracts a bearer JWT from request headers (lower-case names, as Playwright reports them). */
export function bearerFromHeaders(headers: Record<string, string>, url: string): BearerToken | null {
  const value = headers['authorization'];
  if (!value) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(value);
  if (!m) return null;
  const claims = decodeJwt(m[1]);
  if (!claims) return null;
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    // keep empty
  }
  return { header: value, aud: String(claims.aud ?? ''), exp: Number(claims.exp ?? 0), origin, claims };
}

const MS_LOGIN_HOST = /(^|\.)login\.(microsoftonline\.com|live\.com|windows\.net|microsoft\.com)$/i;

export function isMicrosoftLoginUrl(url: string): boolean {
  try {
    return MS_LOGIN_HOST.test(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * Handles the Microsoft account picker and "Stay signed in?" prompts when the choice is
 * unambiguous (the remembered account, or the only account tile). Returns what it did.
 */
export async function autoPickMicrosoftAccount(page: Page, upnHint?: string): Promise<'picked' | 'kmsi' | 'none'> {
  if (!isMicrosoftLoginUrl(page.url())) return 'none';
  try {
    if (await page.locator('input[name="DontShowAgain"]').count()) {
      await page.locator('#idSIButton9').click({ timeout: 3_000 });
      return 'kmsi';
    }
    if (upnHint) {
      const tile = page.locator(`[data-test-id="${upnHint.replace(/"/g, '')}"]`);
      if (await tile.count()) {
        await tile.first().click({ timeout: 3_000 });
        return 'picked';
      }
    }
    const tiles = page.locator('[data-test-id*="@"]');
    if ((await tiles.count()) === 1) {
      await tiles.first().click({ timeout: 3_000 });
      return 'picked';
    }
    if (upnHint) {
      const text = page.getByText(upnHint, { exact: true });
      if ((await text.count()) === 1) {
        await text.click({ timeout: 3_000 });
        return 'picked';
      }
    }
  } catch {
    // The page changed underneath us; the caller polls again.
  }
  return 'none';
}

export interface BrowserSessionOptions {
  profileDir?: string;
  mode?: BrowserMode;
  log?: (message: string) => void;
}

export class BrowserSession {
  readonly profileDir: string;
  mode: BrowserMode;
  private readonly log: (message: string) => void;
  private ctx: BrowserContext | undefined;
  private headless = false;
  private gen = 0;
  private readonly pages = new Map<string, Page>();
  private readonly listeners = new Set<(req: Request) => void>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: BrowserSessionOptions = {}) {
    this.profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
    this.mode = options.mode ?? 'auto';
    this.log = options.log ?? (() => {});
  }

  get isOpen(): boolean {
    return this.ctx !== undefined;
  }

  get isHeadless(): boolean {
    return this.ctx !== undefined && this.headless;
  }

  /** Increments every time the browser is (re)launched; pages from older generations are gone. */
  get generation(): number {
    return this.gen;
  }

  /** Receives every request made by any page of the session (also across relaunches). */
  onRequest(listener: (req: Request) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Returns the browser context, launching it when needed. `visible: true` relaunches a
   * headless browser as a visible window (used for interactive sign-in).
   */
  context(options: { visible?: boolean } = {}): Promise<BrowserContext> {
    return this.serialize(async () => {
      const wantVisible = options.visible === true || this.mode === 'visible';
      if (this.ctx && !(wantVisible && this.headless)) return this.ctx;
      if (this.ctx) {
        if (this.mode === 'headless') {
          throw new SignInRequiredError('Sign-in is required, but the organizer runs the browser in headless mode.');
        }
        this.log('reopening as a visible window for sign-in');
        await this.closeContext();
      }
      return this.launch(!wantVisible);
    });
  }

  private async launch(headless: boolean): Promise<BrowserContext> {
    this.log(`launching Edge (${headless ? 'headless' : 'visible'}) with profile ${this.profileDir}`);
    let ctx: BrowserContext;
    try {
      ctx = await chromium.launchPersistentContext(this.profileDir, {
        channel: 'msedge',
        headless,
        viewport: null,
        args: headless ? [] : ['--start-maximized'],
      });
    } catch (e) {
      const message = String((e as Error).message ?? e);
      if (/ProcessSingleton|profile.*in use|user data directory is already in use|lock/i.test(message)) {
        throw new Error(
          `The organizer's browser profile is already in use (${this.profileDir}). Close other organizer or discovery windows and try again.`,
        );
      }
      if (/msedge|executable doesn't exist|Chromium distribution/i.test(message)) {
        throw new Error('Microsoft Edge was not found. Install Edge (the organizer drives it with Playwright).');
      }
      throw e;
    }
    this.ctx = ctx;
    this.headless = headless;
    this.gen++;
    this.pages.clear();
    const gen = this.gen;
    ctx.on('request', (req) => {
      for (const l of this.listeners) {
        try {
          l(req);
        } catch (err) {
          this.log(`request listener failed: ${String(err)}`);
        }
      }
    });
    ctx.on('close', () => {
      if (this.gen === gen) {
        this.ctx = undefined;
        this.pages.clear();
        this.log('closed');
      }
    });
    return ctx;
  }

  /** Returns the named page, creating it (or reusing the initial blank tab) when needed. */
  async page(name: string): Promise<Page> {
    const existing = this.pages.get(name);
    if (existing && !existing.isClosed() && this.ctx) return existing;
    const ctx = await this.context();
    const again = this.pages.get(name);
    if (again && !again.isClosed()) return again;
    const used = new Set(this.pages.values());
    const blank = ctx.pages().find((p) => !used.has(p) && !p.isClosed() && (p.url() === 'about:blank' || p.url() === ''));
    const page = blank ?? (await ctx.newPage());
    this.pages.set(name, page);
    return page;
  }

  /** Brings the session's window forward (visible mode only). */
  async focus(name: string): Promise<void> {
    const page = this.pages.get(name);
    if (page && !page.isClosed() && !this.headless) await page.bringToFront().catch(() => {});
  }

  private async closeContext(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = undefined;
    this.pages.clear();
    if (ctx) await ctx.close().catch(() => {});
    // Give Edge a moment to release the profile lock before a relaunch.
    await sleep(500);
  }

  close(): Promise<void> {
    return this.serialize(() => this.closeContext());
  }
}
