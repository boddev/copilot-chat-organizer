// Transport for Copilot agent tasks on github.com (https://github.com/copilot). Every call
// runs inside a signed-in github.com page: the page trades its session cookie for a
// short-lived API token (POST /copilot/agent-sessions/cmc-api-token), keeps it in page
// memory and calls api.github.com/cmc_internal/api/agents/... with it, exactly like the
// github.com UI. The token never reaches Node. See docs/ghweb-endpoints.md.
import type { Page } from 'playwright-core';
import { SignInRequiredError, type BrowserSession } from '../../lib/browser-session.ts';
import { sleep } from '../../lib/async.ts';
import type { TransportPhase, TransportState } from '../m365/transport.ts';

export const GITHUB_ORIGIN = 'https://github.com';
export const API_BASE = 'https://api.github.com/cmc_internal/api/agents/';
export const START_URL = `${GITHUB_ORIGIN}/copilot`;
export const LOGIN_URL = `${GITHUB_ORIGIN}/login?return_to=${encodeURIComponent('/copilot')}`;
const TOKEN_PATH = '/copilot/agent-sessions/cmc-api-token';
const PAGE_NAME = 'ghweb';
const API_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'copilot-integration-id': 'copilot-web',
  'x-client-application': 'copilot-cloud-web',
};

export interface GhWebIdentity {
  login: string;
  /** Numeric GitHub user id. */
  id: string;
}

export interface GhWebResponse {
  status: number;
  text: string;
  /** The Link response header (pagination), when present. */
  link: string | null;
  retryAfter: string | null;
}

export interface EventsOptions {
  /** Copilot CLI/app-format event types to keep. */
  types: readonly string[];
  /** `data` fields to keep on the kept CLI/app-format events. */
  dataFields: readonly string[];
  /** Stop reading after this many bytes and keep the complete events read so far. */
  maxBytes?: number;
}

export interface GhWebRequestOptions {
  /**
   * For task event logs (`{events, total}`, up to tens of MB): filter the events inside
   * the page, so only a small payload reaches Node. The response text is then a
   * SlimEventsBody.
   */
  events?: EventsOptions;
  timeoutMs?: number;
}

/** A transcript-relevant event in the Copilot CLI/app format (also used by agent tasks). */
export interface CliSlimEvent {
  type: string;
  timestamp?: unknown;
  agentId?: unknown;
  data: Record<string, unknown>;
}

/** A transcript-relevant action of a github.com chat (`ns: "ahp"` events). */
export interface AhpSlimEvent {
  at?: string;
  ahp: { type: string; at?: string; text?: string; origin?: string; partId?: string };
}

export interface SlimEventsBody {
  /** Events in the task, when the whole log was read. */
  total?: number;
  /** Events read (before filtering). */
  count: number;
  bytes: number;
  /** Reading stopped at `maxBytes`: `events` covers the beginning of the log only. */
  truncated: boolean;
  /** How many events of each kind were read (`ahp:<action>` for chat events; at most 60 kinds). */
  kinds: Record<string, number>;
  events: Array<CliSlimEvent | AhpSlimEvent>;
}

export interface GhWebTransport {
  state(): TransportState;
  /** Opens github.com and signs in when needed. */
  connect(onStatus?: (message: string) => void): Promise<void>;
  identity(): GhWebIdentity | undefined;
  /** Calls the agents API (`path` is relative to API_BASE). Resolves for any HTTP status. */
  request(method: string, path: string, options?: GhWebRequestOptions): Promise<GhWebResponse>;
  close?(): Promise<void>;
}

/** Resolves an API path (or a pagination link) and checks it stays under API_BASE. */
export function apiUrl(path: string, base = API_BASE): string {
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    throw new Error(`Invalid github.com API path: ${path.slice(0, 120)}`);
  }
  if (!url.href.startsWith(API_BASE)) throw new Error(`Refusing to call a URL outside the Copilot agents API: ${url.origin}${url.pathname}`);
  return url.href;
}

/** The agents API's public path. Its pagination links point here rather than at API_BASE. */
const PUBLIC_API_BASE = 'https://api.github.com/agents/';

/**
 * Resolves a pagination link against the current page's URL. A link to the public path is
 * mapped onto API_BASE with its query unchanged; anything else must already be under API_BASE.
 */
export function pageUrl(link: string, current: string): string {
  let url: URL;
  try {
    url = new URL(link, current);
  } catch {
    throw new Error(`Invalid github.com API path: ${link.slice(0, 120)}`);
  }
  return apiUrl(url.href.startsWith(PUBLIC_API_BASE) ? API_BASE + url.href.slice(PUBLIC_API_BASE.length) : url.href);
}

export interface PageRequestArgs {
  method: string;
  url: string;
  tokenPath: string;
  headers: Record<string, string>;
  timeoutMs: number;
  events?: { types: string[]; dataFields: string[]; maxBytes?: number };
}

export interface PageResponse extends GhWebResponse {
  /** Set when the page could not get an API token: the HTTP status of the token request. */
  tokenStatus?: number;
}

/**
 * Runs inside the github.com page (Playwright serializes it), so it must not reference
 * anything outside its own body. `env` is the page's global object; tests pass a fake.
 */
export async function pageRequest(args: PageRequestArgs, env: any = globalThis): Promise<PageResponse> {
  const cacheKey = '__copilotChatOrganizerAgentsToken';
  const getToken = async (force: boolean): Promise<{ token?: string; status: number }> => {
    const cached = env[cacheKey];
    if (!force && cached && typeof cached.token === 'string' && cached.exp - Date.now() > 120_000) return { token: cached.token, status: 200 };
    const nonce = env.document?.querySelector('meta[name="fetch-nonce"]')?.getAttribute('content') ?? '';
    const r = await env.fetch(args.tokenPath, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'github-verified-fetch': 'true',
        'x-requested-with': 'XMLHttpRequest',
        'x-fetch-nonce': nonce,
      },
    });
    if (!r.ok) return { status: r.status };
    let body: any;
    try {
      body = await r.json();
    } catch {
      return { status: 502 };
    }
    if (!body || typeof body.token !== 'string' || !body.token) return { status: 502 };
    const e = body.expiration;
    let exp = typeof e === 'number' ? (e < 1e11 ? e * 1000 : e) : Date.parse(String(e));
    if (!Number.isFinite(exp)) exp = Date.now() + 10 * 60_000;
    env[cacheKey] = { token: body.token, exp };
    return { token: body.token, status: 200 };
  };
  for (let attempt = 0; ; attempt++) {
    const t = await getToken(attempt > 0);
    if (!t.token) return { status: t.status, text: '', link: null, retryAfter: null, tokenStatus: t.status };
    const r = await env.fetch(args.url, {
      method: args.method,
      headers: { ...args.headers, authorization: `GitHub-Bearer ${t.token}` },
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    if (r.status === 401 && attempt === 0) {
      env[cacheKey] = undefined;
      continue;
    }
    if (!args.events || !r.ok) {
      return { status: r.status, text: await r.text(), link: r.headers.get('link'), retryAfter: r.headers.get('retry-after') };
    }
    // Event logs can be tens of MB: read at most maxBytes, then keep the complete events.
    const chunks: string[] = [];
    let bytes = 0;
    let truncated = false;
    const reader = r.body?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        chunks.push(decoder.decode(value, { stream: true }));
        if (args.events.maxBytes && bytes > args.events.maxBytes) {
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
      }
      if (!truncated) chunks.push(decoder.decode());
    } else {
      chunks.push(await r.text());
      bytes = chunks[0].length;
    }
    const text = chunks.join('');
    let raw: any[] = [];
    let total: unknown;
    if (!truncated) {
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (!parsed || !(Array.isArray(parsed.events) || parsed.events === null)) {
        // Not an event log: hand back a bounded excerpt; the caller reports it.
        return { status: r.status, text: text.slice(0, 2000), link: r.headers.get('link'), retryAfter: r.headers.get('retry-after') };
      }
      // github.com sends "events": null for a task with no history.
      raw = parsed.events ?? [];
      total = parsed.total;
    } else {
      // Collect the complete objects at the start of the cut-off "events" array.
      const m = /"events"\s*:\s*\[/.exec(text);
      if (!m) {
        // Not an event log: hand back a bounded excerpt; the caller reports it.
        return { status: r.status, text: text.slice(0, 2000), link: r.headers.get('link'), retryAfter: r.headers.get('retry-after') };
      }
      let depth = 0;
      let inStr = false;
      let esc = false;
      let start = -1;
      for (let i = m.index + m[0].length; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (inStr) {
          if (esc) esc = false;
          else if (c === 92) esc = true;
          else if (c === 34) inStr = false;
        } else if (c === 34) {
          inStr = true;
        } else if (c === 123 || c === 91) {
          if (depth === 0) start = i;
          depth++;
        } else if (c === 125 || c === 93) {
          if (depth === 0) {
            // The array ended within what was read, so nothing was cut off.
            truncated = false;
            const t = /"total"\s*:\s*(\d+)/.exec(text.slice(i));
            if (t) total = Number(t[1]);
            break;
          }
          depth--;
          if (depth === 0 && start >= 0) {
            try {
              raw.push(JSON.parse(text.slice(start, i + 1)));
            } catch {
              // skip a malformed event
            }
            start = -1;
          }
        }
      }
    }
    const types = new Set(args.events.types);
    const textParts = new Set<string>();
    const events: unknown[] = [];
    // Event kinds seen (bounded), to diagnose logs whose format is not recognized.
    const kinds: Record<string, number> = {};
    const tally = (kind: string) => {
      const k = kind.slice(0, 80);
      if (kinds[k] !== undefined) kinds[k]++;
      else if (Object.keys(kinds).length < 60) kinds[k] = 1;
    };
    for (const ev of raw) {
      if (!ev || typeof ev !== 'object') {
        tally('(invalid)');
        continue;
      }
      if (typeof ev.type === 'string') {
        // Copilot CLI/app session format, also used by agent tasks.
        tally(ev.type);
        if (!types.has(ev.type)) continue;
        const data: Record<string, unknown> = {};
        if (ev.data && typeof ev.data === 'object') {
          for (const f of args.events.dataFields) if (ev.data[f] !== undefined) data[f] = ev.data[f];
        }
        events.push({ type: ev.type, timestamp: ev.timestamp, agentId: ev.agentId, data });
        continue;
      }
      // github.com chat format: {ns: "ahp", at, payload: {data: {action: {type, ...}}}}.
      const a = ev.payload?.data?.action;
      if (ev.ns !== 'ahp' || !a || typeof a.type !== 'string') {
        tally(typeof ev.ns === 'string' ? `${ev.ns}:?` : `?:${Object.keys(ev).slice(0, 4).join('+')}`);
        continue;
      }
      tally(`ahp:${a.type}`);
      if (a.type === 'chat/turnStarted') {
        events.push({ at: ev.at, ahp: { type: a.type, at: a.startedAt, text: a.message?.text, origin: a.message?.origin?.kind } });
      } else if (a.type === 'chat/responsePart') {
        const p = a.part;
        if (!p || (p.kind !== 'markdown' && p.kind !== 'text')) continue;
        if (typeof p.id === 'string') textParts.add(p.id);
        events.push({ at: ev.at, ahp: { type: a.type, partId: p.id, text: p.content } });
      } else if (a.type === 'chat/delta') {
        if (textParts.has(a.partId)) events.push({ at: ev.at, ahp: { type: a.type, partId: a.partId, text: a.content } });
      } else if (/^chat\/(turn(Cancel|Abort|Fail|Error)|error)/i.test(a.type)) {
        const err = a.error;
        const detail = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : typeof a.reason === 'string' ? a.reason : undefined;
        events.push({ at: ev.at, ahp: { type: a.type, text: detail } });
      }
    }
    return {
      status: r.status,
      text: JSON.stringify({ total: typeof total === 'number' ? total : undefined, count: raw.length, bytes, truncated, kinds, events }),
      link: r.headers.get('link'),
      retryAfter: r.headers.get('retry-after'),
    };
  }
}

/** Runs inside the page: who is signed in, and can the page call the token endpoint. */
function pageIdentity(): { login: string; id: string; nonce: boolean; hasLoginMeta: boolean } {
  const doc = (globalThis as any).document;
  const meta = (name: string): string => doc?.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? '';
  return {
    login: meta('user-login'),
    id: meta('octolytics-actor-id'),
    nonce: meta('fetch-nonce') !== '',
    // Signed-out github.com pages carry an empty user-login tag; error pages carry none.
    hasLoginMeta: !!doc?.querySelector('meta[name="user-login"]'),
  };
}

export function isGitHubUrl(url: string): boolean {
  return url === GITHUB_ORIGIN || url.startsWith(`${GITHUB_ORIGIN}/`);
}

/** github.com pages that are part of signing in (password, 2FA, device verification, SSO). */
export function isSignInPage(url: string): boolean {
  if (!isGitHubUrl(url)) return false;
  return /^\/(login|session|sessions|signup|join|password_reset|orgs\/[^/]+\/sso|enterprises\/[^/]+\/sso)(\/|\?|$)/.test(new URL(url).pathname);
}

export interface PageTransportOptions {
  session: BrowserSession;
  log?: (message: string) => void;
  /** How long to wait for the user to finish signing in in a visible window. */
  signInTimeoutMs?: number;
  /** How long a signed-out headless page is observed before switching to a visible window. */
  headlessGraceMs?: number;
}

export class GhWebPageTransport implements GhWebTransport {
  private readonly session: BrowserSession;
  private readonly log: (message: string) => void;
  private readonly signInTimeoutMs: number;
  private readonly headlessGraceMs: number;
  private ident: GhWebIdentity | undefined;
  private readyGen = -1;
  private needsReload = false;
  private connecting: Promise<void> | undefined;
  private current: TransportState = { phase: 'idle' };

  constructor(options: PageTransportOptions) {
    this.session = options.session;
    this.log = options.log ?? (() => {});
    this.signInTimeoutMs = options.signInTimeoutMs ?? 5 * 60_000;
    this.headlessGraceMs = options.headlessGraceMs ?? 3_000;
  }

  state(): TransportState {
    return this.current;
  }

  identity(): GhWebIdentity | undefined {
    return this.ident;
  }

  private setState(phase: TransportPhase, message?: string): void {
    this.current = { phase, message };
  }

  private isConnected(): boolean {
    return !this.needsReload && this.session.isOpen && this.readyGen === this.session.generation && !!this.ident;
  }

  connect(onStatus?: (message: string) => void): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    this.connecting ??= this.doConnect(onStatus).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async goto(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => this.log(`goto ${url}: ${String(e).slice(0, 160)}`));
  }

  private async doConnect(onStatus?: (message: string) => void): Promise<void> {
    const note = (message: string) => {
      this.log(message);
      onStatus?.(message);
    };
    this.setState('starting', 'Opening github.com');
    try {
      let page = await this.session.page(PAGE_NAME);
      const reload = this.needsReload || this.readyGen !== this.session.generation;
      this.needsReload = false;
      this.ident = undefined;
      if (!isGitHubUrl(page.url()) || isSignInPage(page.url())) await this.goto(page, START_URL);
      else if (reload) await page.reload({ waitUntil: 'domcontentloaded' }).catch((e) => this.log(`reload: ${String(e).slice(0, 160)}`));
      let deadline = Date.now() + (this.session.isHeadless ? 60_000 : this.signInTimeoutMs);
      let signedOutSince: number | undefined;
      let signedInSince: number | undefined;
      let sentToLogin = false;
      let sentToStart = false;
      for (;;) {
        if (page.isClosed()) {
          page = await this.session.page(PAGE_NAME);
          await this.goto(page, START_URL);
          continue;
        }
        const url = page.url();
        const info = isGitHubUrl(url) ? await page.evaluate(pageIdentity).catch(() => undefined) : undefined;
        if (info?.login && info.id && !isSignInPage(url)) {
          if (info.nonce) {
            this.ident = { login: info.login, id: info.id };
            break;
          }
          // Signed in, but this page cannot call the token endpoint: use the Copilot page.
          signedInSince ??= Date.now();
          if (!sentToStart) {
            sentToStart = true;
            await this.goto(page, START_URL);
            continue;
          }
          if (Date.now() - signedInSince > 30_000) {
            throw new Error('github.com loaded, but the organizer could not find what it needs on the page (the site may have changed).');
          }
        }
        // Signed out: a sign-in page, a loaded github.com page without a user, or an external SSO page.
        const signedOut =
          isSignInPage(url) ||
          (info !== undefined && info.hasLoginMeta && !info.login) ||
          (!isGitHubUrl(url) && url !== 'about:blank' && url !== '');
        if (signedOut) {
          signedOutSince ??= Date.now();
          if (this.session.isHeadless) {
            if (Date.now() - signedOutSince > this.headlessGraceMs) {
              if (this.session.mode === 'headless') {
                throw new SignInRequiredError(
                  'github.com needs an interactive sign-in. Set the browser mode to "auto" or "visible" and try again.',
                );
              }
              note('Sign-in needed: opening a visible Edge window for github.com');
              await this.session.context({ visible: true });
              page = await this.session.page(PAGE_NAME);
              await this.goto(page, LOGIN_URL);
              sentToLogin = true;
              deadline = Date.now() + this.signInTimeoutMs;
              signedOutSince = undefined;
              continue;
            }
          } else {
            if (!sentToLogin && isGitHubUrl(url) && !isSignInPage(url)) {
              sentToLogin = true;
              await this.goto(page, LOGIN_URL);
              continue;
            }
            if (this.current.phase !== 'signin') {
              this.setState('signin', 'Sign in to github.com in the Edge window opened by the organizer.');
              note('Waiting for you to sign in to github.com in the Edge window');
              await this.session.focus(PAGE_NAME);
            }
          }
        } else {
          signedOutSince = undefined;
        }
        if (Date.now() > deadline) {
          throw new Error(this.current.phase === 'signin' ? 'Timed out waiting for the github.com sign-in.' : 'Timed out opening github.com.');
        }
        await sleep(500);
      }
      this.readyGen = this.session.generation;
      this.setState('ready', `Signed in to github.com as ${this.ident.login}`);
      this.log(`signed in as ${this.ident.login}`);
    } catch (e) {
      this.setState(e instanceof SignInRequiredError ? 'signin' : 'error', String((e as Error).message ?? e));
      throw e;
    }
  }

  private async appPage(): Promise<Page> {
    await this.connect();
    let page = await this.session.page(PAGE_NAME);
    if (!isGitHubUrl(page.url()) || isSignInPage(page.url())) {
      this.needsReload = true;
      await this.connect();
      page = await this.session.page(PAGE_NAME);
    }
    return page;
  }

  async request(method: string, path: string, options: GhWebRequestOptions = {}): Promise<GhWebResponse> {
    const args: PageRequestArgs = {
      method,
      url: apiUrl(path),
      tokenPath: TOKEN_PATH,
      headers: API_HEADERS,
      timeoutMs: options.timeoutMs ?? 120_000,
      events: options.events
        ? { types: [...options.events.types], dataFields: [...options.events.dataFields], maxBytes: options.events.maxBytes }
        : undefined,
    };
    for (let attempt = 1; ; attempt++) {
      const page = await this.appPage();
      let res: PageResponse;
      try {
        res = await page.evaluate(pageRequest, args);
      } catch (e) {
        // The page navigated or closed mid-call; reconnect once.
        if (attempt >= 2) throw e;
        this.log(`page call failed (${String(e).slice(0, 160)}); reconnecting`);
        this.needsReload = true;
        continue;
      }
      if (res.tokenStatus !== undefined) {
        // Usually a signed-out session or a stale page: reload (and sign in) once.
        if (attempt === 1) {
          this.log(`token request returned HTTP ${res.tokenStatus}; reloading github.com`);
          this.needsReload = true;
          continue;
        }
        throw new Error(
          `github.com did not issue a Copilot API token (HTTP ${res.tokenStatus}). Sign in again, and check that Copilot is enabled for your account.`,
        );
      }
      return { status: res.status, text: res.text, link: res.link, retryAfter: res.retryAfter };
    }
  }

  async close(): Promise<void> {
    this.ident = undefined;
    this.readyGen = -1;
  }
}
