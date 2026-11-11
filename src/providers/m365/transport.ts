// Transport for the Microsoft 365 Copilot web app. Server functions and chat content are
// fetched inside a signed-in page (cookie auth); the Cowork/Projects REST API ("Aether")
// is called from Node with the bearer token the page itself uses. See docs/m365-endpoints.md.
import type { Page, Request } from 'playwright-core';
import crypto from 'node:crypto';
import {
  autoPickMicrosoftAccount,
  bearerFromHeaders,
  isMicrosoftLoginUrl,
  SignInRequiredError,
  type BearerToken,
  type BrowserSession,
} from '../../lib/browser-session.ts';
import { decode, decodeBody, encodeRequest } from '../../lib/seroval.ts';
import { HttpError, parseRetryAfter, sleep } from '../../lib/async.ts';
import { readJson, writeJsonAtomic } from '../../core/store.ts';

export const APP_ORIGIN = 'https://copilot.cloud.microsoft';
export const AETHER_AUDIENCE = '6ab48b67-cd74-4ad4-81af-5932984589be';

export interface Identity {
  oid: string;
  tid: string;
  upn?: string;
}

export interface AetherResult<T = any> {
  status: number;
  data: T;
}

export type TransportPhase = 'idle' | 'starting' | 'signin' | 'ready' | 'error';

export interface TransportState {
  phase: TransportPhase;
  message?: string;
}

export interface M365Transport {
  state(): TransportState;
  /** Opens the app and signs in when needed. Calls connect implicitly. */
  connect(onStatus?: (message: string) => void): Promise<void>;
  /** Calls the web app's server-function dispatcher; returns the decoded response. */
  serverFn(data: Record<string, unknown>): Promise<any>;
  /** GET on the web app origin from inside the page. */
  pageGet(path: string, headers?: Record<string, string>): Promise<{ status: number; text: string }>;
  /** Calls the Cowork/Projects REST API. Throws HttpError for non-2xx responses. */
  aether<T = any>(method: string, path: string, body?: unknown): Promise<AetherResult<T>>;
  identity(): Identity | undefined;
  close?(): Promise<void>;
}

interface RuntimeHints {
  serverFnHash?: string;
  aetherBase?: string;
  upn?: string;
  updatedAt?: string;
}

const SFN_HEADERS = {
  'x-tsr-serverfn': 'true',
  'content-type': 'application/json',
  accept: 'application/x-tss-framed, application/x-ndjson, application/json',
};

function isDispatcherBody(post: string): boolean {
  try {
    const decoded = decode(JSON.parse(post).t) as { data?: { action?: unknown } } | undefined;
    return typeof decoded?.data?.action === 'string';
  } catch {
    return false;
  }
}

/** Returns the REST base origin for an Aether API call, or undefined for other calls. */
export function aetherBaseFrom(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!/^\/v\d+\//.test(u.pathname) || /routing/i.test(u.pathname)) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

export interface PageTransportOptions {
  session: BrowserSession;
  /** JSON file for non-secret runtime hints (dispatcher hash, API base, account). */
  hintsFile: string;
  log?: (message: string) => void;
  startUrl?: string;
  /** How long to wait for the user to finish signing in in a visible window. */
  signInTimeoutMs?: number;
  /** How long a headless attempt may try before switching to a visible window. */
  headlessLoginGraceMs?: number;
}

export class PageTransport implements M365Transport {
  private readonly session: BrowserSession;
  private readonly hintsFile: string;
  private readonly log: (message: string) => void;
  private readonly startUrl: string;
  private readonly signInTimeoutMs: number;
  private readonly headlessLoginGraceMs: number;
  private hints: RuntimeHints;
  private hash: string | undefined;
  private observedBase: string | undefined;
  private token: BearerToken | undefined;
  private ident: Identity | undefined;
  private readyGen = -1;
  private needsReload = false;
  private connecting: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private current: TransportState = { phase: 'idle' };
  private readonly unsubscribe: () => void;

  constructor(options: PageTransportOptions) {
    this.session = options.session;
    this.hintsFile = options.hintsFile;
    this.log = options.log ?? (() => {});
    this.startUrl = options.startUrl ?? `${APP_ORIGIN}/home`;
    this.signInTimeoutMs = options.signInTimeoutMs ?? 5 * 60_000;
    this.headlessLoginGraceMs = options.headlessLoginGraceMs ?? 8_000;
    this.hints = readJson<RuntimeHints>(this.hintsFile, {});
    this.unsubscribe = this.session.onRequest(this.onRequest);
  }

  state(): TransportState {
    return this.current;
  }

  identity(): Identity | undefined {
    return this.ident;
  }

  private setState(phase: TransportPhase, message?: string): void {
    this.current = { phase, message };
  }

  private get aetherBase(): string | undefined {
    return this.observedBase ?? this.hints.aetherBase;
  }

  private readonly onRequest = (req: Request): void => {
    const url = req.url();
    if (req.method() === 'POST' && url.startsWith(`${APP_ORIGIN}/_serverFn/`)) {
      const hash = url.slice(`${APP_ORIGIN}/_serverFn/`.length).split(/[?#/]/)[0];
      const post = req.postData();
      if (hash && post && hash !== this.hash && isDispatcherBody(post)) {
        this.hash = hash;
        this.log(`server-function dispatcher ${hash.slice(0, 12)}…`);
      }
    }
    const token = bearerFromHeaders(req.headers(), url);
    if (!token || token.aud !== AETHER_AUDIENCE) return;
    if (!this.token || token.exp >= this.token.exp) this.token = token;
    const base = aetherBaseFrom(url);
    if (base && (!this.observedBase || (/mcsaetherruntime/i.test(base) && !/mcsaetherruntime/i.test(this.observedBase)))) {
      this.observedBase = base;
    }
    const c = token.claims;
    if (typeof c.oid === 'string' && typeof c.tid === 'string') {
      const upn = [c.upn, c.preferred_username, c.unique_name].find((v) => typeof v === 'string') as string | undefined;
      this.ident = { oid: c.oid, tid: c.tid, upn };
    }
  };

  private tokenValidFor(ms: number): boolean {
    return !!this.token && this.token.exp * 1000 - Date.now() > ms;
  }

  private isConnected(): boolean {
    return (
      !this.needsReload &&
      this.session.isOpen &&
      this.readyGen === this.session.generation &&
      !!(this.hash ?? this.hints.serverFnHash) &&
      !!this.aetherBase &&
      !!this.ident &&
      this.tokenValidFor(15_000)
    );
  }

  connect(onStatus?: (message: string) => void): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    this.connecting ??= this.doConnect(onStatus).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async doConnect(onStatus?: (message: string) => void): Promise<void> {
    const note = (message: string) => {
      this.log(message);
      onStatus?.(message);
    };
    this.setState('starting', 'Opening Microsoft 365 Copilot');
    try {
      let page = await this.session.page('m365');
      const reload = this.needsReload || this.readyGen !== this.session.generation;
      this.needsReload = false;
      if (!page.url().startsWith(APP_ORIGIN)) {
        await page.goto(this.startUrl, { waitUntil: 'domcontentloaded' }).catch((e) => this.log(`goto: ${e}`));
      } else if (reload) {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch((e) => this.log(`reload: ${e}`));
      }
      let deadline = Date.now() + (this.session.isHeadless ? 60_000 : this.signInTimeoutMs);
      let onLoginSince: number | undefined;
      let onAppSince: number | undefined;
      for (;;) {
        const url = page.isClosed() ? '' : page.url();
        if (page.isClosed()) {
          page = await this.session.page('m365');
          await page.goto(this.startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
          continue;
        }
        if (isMicrosoftLoginUrl(url)) {
          onAppSince = undefined;
          const did = await autoPickMicrosoftAccount(page, this.hints.upn);
          if (did !== 'none') {
            onLoginSince = undefined;
            note(did === 'picked' ? 'Signing in with the remembered account' : 'Confirming "Stay signed in"');
          } else {
            onLoginSince ??= Date.now();
            if (this.session.isHeadless && Date.now() - onLoginSince > this.headlessLoginGraceMs) {
              if (this.session.mode === 'headless') {
                throw new SignInRequiredError(
                  'Microsoft 365 needs an interactive sign-in. Set the browser mode to "auto" or "visible" and try again.',
                );
              }
              note('Sign-in needed: opening a visible Edge window');
              await this.session.context({ visible: true });
              page = await this.session.page('m365');
              await page.goto(this.startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
              deadline = Date.now() + this.signInTimeoutMs;
              onLoginSince = undefined;
              continue;
            }
            if (!this.session.isHeadless && this.current.phase !== 'signin') {
              this.setState('signin', 'Sign in to Microsoft 365 in the Edge window opened by the organizer.');
              note('Waiting for you to sign in in the Edge window');
              await this.session.focus('m365');
            }
          }
        } else if (url.startsWith(APP_ORIGIN)) {
          onLoginSince = undefined;
          onAppSince ??= Date.now();
          if (this.current.phase === 'signin') this.setState('starting', 'Signed in; loading Copilot');
          const hash = this.hash ?? (Date.now() - onAppSince > 20_000 ? this.hints.serverFnHash : undefined);
          if (hash && this.token && this.aetherBase && this.ident) break;
          if (Date.now() - onAppSince > 45_000) {
            throw new Error(
              'Copilot loaded, but the organizer could not detect its API calls (the web app may have changed). See docs/m365-endpoints.md.',
            );
          }
        }
        if (Date.now() > deadline) {
          throw new Error(
            this.current.phase === 'signin' ? 'Timed out waiting for the Microsoft 365 sign-in.' : 'Timed out opening Microsoft 365 Copilot.',
          );
        }
        await sleep(400);
      }
      this.readyGen = this.session.generation;
      this.hints = {
        serverFnHash: this.hash ?? this.hints.serverFnHash,
        aetherBase: this.aetherBase,
        upn: this.ident?.upn ?? this.hints.upn,
        updatedAt: new Date().toISOString(),
      };
      writeJsonAtomic(this.hintsFile, this.hints);
      this.setState('ready', this.ident?.upn ? `Signed in as ${this.ident.upn}` : 'Signed in');
    } catch (e) {
      this.setState(e instanceof SignInRequiredError ? 'signin' : 'error', String((e as Error).message ?? e));
      throw e;
    }
  }

  /** Reloads the app in a helper tab so the page acquires a fresh Aether token. */
  private refreshToken(): Promise<void> {
    this.refreshing ??= (async () => {
      const before = this.token?.exp ?? 0;
      this.log('refreshing the Cowork API token');
      const page = await this.session.page('m365-token');
      try {
        await page.goto(this.startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          if ((this.token?.exp ?? 0) > before && this.tokenValidFor(120_000)) return;
          if (isMicrosoftLoginUrl(page.url())) await autoPickMicrosoftAccount(page, this.hints.upn);
          await sleep(400);
        }
        if (!this.tokenValidFor(15_000)) {
          this.needsReload = true;
          throw new Error('Could not refresh the Microsoft 365 access token. Sign in again from the organizer.');
        }
      } finally {
        await page.goto('about:blank').catch(() => {});
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async appPage(): Promise<Page> {
    await this.connect();
    let page = await this.session.page('m365');
    if (!page.url().startsWith(APP_ORIGIN)) {
      this.needsReload = true;
      await this.connect();
      page = await this.session.page('m365');
    }
    return page;
  }

  private async inPage(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; text: string; retryAfter: string | null }> {
    for (let attempt = 1; ; attempt++) {
      const page = await this.appPage();
      try {
        return await page.evaluate(
          async ({ path, init }) => {
            const r = await fetch(path, { ...init, credentials: 'include' });
            return { status: r.status, text: await r.text(), retryAfter: r.headers.get('retry-after') };
          },
          { path, init },
        );
      } catch (e) {
        // The page navigated or closed mid-call; reconnect once.
        if (attempt >= 2) throw e;
        this.log(`page call failed (${String(e).slice(0, 120)}); reconnecting`);
        this.needsReload = true;
      }
    }
  }

  async serverFn(data: Record<string, unknown>): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      await this.connect();
      const hash = this.hash ?? this.hints.serverFnHash;
      const res = await this.inPage(`/_serverFn/${hash}`, { method: 'POST', headers: SFN_HEADERS, body: encodeRequest(data) });
      if (res.status === 200) return decodeBody(res.text);
      // 401/403: session expired. 404/400: the dispatcher hash changed with a deployment.
      if (attempt === 1 && [400, 401, 403, 404].includes(res.status)) {
        this.log(`${String(data.action)} returned ${res.status}; reloading the app`);
        if (res.status === 404 || res.status === 400) this.hash = undefined;
        this.needsReload = true;
        continue;
      }
      throw new HttpError(
        `${String(data.action)} failed: HTTP ${res.status} ${res.text.slice(0, 200)}`,
        res.status,
        parseRetryAfter(res.retryAfter),
      );
    }
  }

  async pageGet(path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
    const res = await this.inPage(path, { method: 'GET', headers });
    return { status: res.status, text: res.text };
  }

  async aether<T = any>(method: string, path: string, body?: unknown): Promise<AetherResult<T>> {
    await this.connect();
    if (!this.tokenValidFor(4 * 60_000)) {
      await this.refreshToken().catch((e) => {
        if (!this.tokenValidFor(15_000)) throw e;
      });
    }
    let res = await this.aetherFetch(method, path, body);
    if (res.status === 401) {
      await this.refreshToken();
      res = await this.aetherFetch(method, path, body);
    }
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      throw new HttpError(
        `${method} ${path.split('?')[0]} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
        res.status,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    return { status: res.status, data: data as T };
  }

  private aetherFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const token = this.token;
    const ident = this.ident;
    if (!token || !ident || !this.aetherBase) throw new Error('Not connected to Microsoft 365.');
    const headers: Record<string, string> = {
      authorization: token.header,
      'x-user-id': ident.oid,
      'x-tenant-id': ident.tid,
      'x-request-id': crypto.randomUUID(),
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(this.aetherBase + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  }

  async close(): Promise<void> {
    this.unsubscribe();
  }
}
