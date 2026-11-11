// Endpoint discovery harness. Opens a visible Edge window with a dedicated profile,
// records API traffic (secrets redacted) to captures/, and exposes a localhost control
// API so the browser can be driven while endpoints are mapped.
//
//   node tools/discover.ts --name m365 --url https://m365.cloud.microsoft/chat
import { chromium, type BrowserContext, type Page, type Request } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const name = arg('name', 'capture');
const startUrl = arg('url', 'https://m365.cloud.microsoft/chat');
const port = Number(arg('port', '47100'));
const profileDir = arg(
  'profile',
  path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'copilot-chat-organizer', 'browser-profile'),
);
const capDir = path.resolve('captures');
fs.mkdirSync(capDir, { recursive: true });
const capFile = path.join(capDir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const controlToken = crypto.randomBytes(16).toString('hex');
fs.writeFileSync(path.join(capDir, '.control'), JSON.stringify({ port, token: controlToken }));

const SKIP_TYPES = new Set(['image', 'stylesheet', 'font', 'media', 'script', 'manifest']);
const AUTH_HOST = /login\.microsoftonline\.com|login\.live\.com|login\.windows\.net|\/oauth2\//i;
const MAX_BODY = 8_000_000;
// Token-bearing JSON fields in response bodies (e.g. github.com's /github-copilot/chat/token).
const SECRET_FIELD = /("(?:token|access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]+(")/gi;

// Credential fields in form posts on any host (e.g. github.com/session sign-in, 2FA).
const SECRET_FORM_FIELD = /((?:^|[&\s])(?:password|passwd|pass|app_otp|otp|sms_otp|authenticity_token|webauthn-response|timestamp_secret)=)[^&\s]*/gi;
const SIGN_IN_PATH = /^https:\/\/github\.com\/(session|sessions\/|login)/i;

function redactBody(body: string): string {
  return body.replace(SECRET_FIELD, (_m, a: string, b: string) => `${a}[redacted]${b}`);
}

function redactPost(url: string, post: string): string {
  if (SIGN_IN_PATH.test(url)) return `[redacted sign-in body, ${post.length} chars]`;
  return redactBody(post).replace(SECRET_FORM_FIELD, (_m, a: string) => `${a}[redacted]`);
}

// Last bearer token seen per audience, kept in memory only (never written to disk).
const tokens = new Map<string, { header: string; exp: number; host: string }>();

function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function redactHeaders(h: Record<string, string>, host: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (key === 'cookie' || key === 'set-cookie') {
      out[k] = `[redacted ${v.length} chars]`;
    } else if (key === 'authorization') {
      const m = /^(Bearer|MSAuth1\.0[^ ]*|[A-Za-z][\w.-]*)\s+(.*)$/i.exec(v);
      const raw = m ? m[2] : v;
      const claims = decodeJwt(raw.replace(/^.*?token="?([^",]+)"?.*$/i, '$1')) ?? decodeJwt(raw);
      if (claims) {
        const aud = String(claims.aud ?? '');
        const exp = Number(claims.exp ?? 0);
        const prev = tokens.get(aud);
        if (!prev || prev.exp <= exp) tokens.set(aud, { header: v, exp, host });
        out[k] =
          `[redacted jwt scheme=${m?.[1] ?? '?'} aud=${aud} appid=${claims.appid ?? claims.azp ?? ''} ` +
          `scp=${claims.scp ?? claims.roles ?? ''} exp=${exp}]`;
      } else {
        out[k] = `[redacted ${v.length} chars scheme=${m?.[1] ?? '?'}]`;
      }
    } else if (/token|secret|signature|x-ms-.*-auth/i.test(key)) {
      out[k] = `[redacted ${v.length} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

let seq = 0;
const reqIds = new WeakMap<Request, number>();
const stream = fs.createWriteStream(capFile, { flags: 'a' });
function log(entry: Record<string, unknown>): void {
  stream.write(JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

function attach(ctx: BrowserContext): void {
  ctx.on('request', (req) => {
    if (SKIP_TYPES.has(req.resourceType())) return;
    const id = ++seq;
    reqIds.set(req, id);
    const url = req.url();
    const host = new URL(url).host;
    const isAuth = AUTH_HOST.test(url);
    let post = req.postData() ?? undefined;
    if (isAuth) post = post ? `[redacted auth body; client_id=${/client_id=([^&]+)/.exec(post)?.[1] ?? '?'} scope=${decodeURIComponent(/scope=([^&]+)/.exec(post)?.[1] ?? '?')}]` : undefined;
    else if (post) {
      post = redactPost(url, post);
      if (post.length > 2_000_000) post = post.slice(0, 2_000_000) + '…[truncated]';
    }
    log({
      kind: 'request',
      id,
      method: req.method(),
      url: isAuth ? url.split('?')[0] : url,
      type: req.resourceType(),
      headers: redactHeaders(req.headers(), host),
      post,
    });
  });
  ctx.on('response', async (res) => {
    const req = res.request();
    const id = reqIds.get(req);
    if (!id) return;
    const url = req.url();
    const entry: Record<string, unknown> = {
      kind: 'response',
      id,
      status: res.status(),
      url: AUTH_HOST.test(url) ? url.split('?')[0] : url,
      ctype: res.headers()['content-type'] ?? '',
    };
    if (!AUTH_HOST.test(url) && /json|text|xml/.test(String(entry.ctype)) && req.resourceType() !== 'document') {
      try {
        const body = redactBody(await res.text());
        entry.body = body.length > MAX_BODY ? body.slice(0, MAX_BODY) + '…[truncated]' : body;
      } catch {
        // body unavailable (redirect / evicted)
      }
    }
    log(entry);
  });
}

function watchSockets(page: Page): void {
  page.on('websocket', (ws) => {
    const url = ws.url().split('?')[0];
    log({ kind: 'websocket', url });
    ws.on('framesent', (f) => log({ kind: 'ws-sent', url, payload: String(f.payload).slice(0, 4000) }));
    ws.on('framereceived', (f) => log({ kind: 'ws-recv', url, payload: String(f.payload).slice(0, 4000) }));
  });
}

const ctx = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
});
attach(ctx);
ctx.on('page', watchSockets);
let page = ctx.pages()[0] ?? (await ctx.newPage());
watchSockets(page);
await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log({ kind: 'error', msg: String(e) }));

function activePage(): Page {
  const pages = ctx.pages();
  page = pages[pages.length - 1] ?? page;
  return page;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  };
  if (req.headers['x-control-token'] !== controlToken) return send(403, { error: 'bad token' });
  try {
    const body = await readBody(req);
    const p = activePage();
    switch (req.url) {
      case '/status':
        return send(200, {
          pages: ctx.pages().map((x) => ({ url: x.url() })),
          capFile,
          tokens: [...tokens.entries()].map(([aud, t]) => ({ aud, host: t.host, exp: t.exp })),
        });
      case '/goto':
        await p.goto(String(body.url), { waitUntil: 'domcontentloaded' });
        return send(200, { url: p.url() });
      case '/eval': {
        const result = await p.evaluate(String(body.expr));
        return send(200, { result });
      }
      case '/aria': {
        const sel = String(body.selector ?? 'body');
        return send(200, { aria: await p.locator(sel).first().ariaSnapshot({ timeout: 10_000 }) });
      }
      case '/click': {
        const loc = body.role
          ? p.getByRole(body.role as Parameters<Page['getByRole']>[0], { name: String(body.name ?? ''), exact: Boolean(body.exact) })
          : body.text
            ? p.getByText(String(body.text), { exact: Boolean(body.exact) })
            : p.locator(String(body.selector));
        await loc.nth(Number(body.nth ?? 0)).click({ timeout: 10_000, button: body.button === 'right' ? 'right' : 'left' });
        return send(200, { ok: true });
      }
      case '/hover': {
        await p.locator(String(body.selector)).nth(Number(body.nth ?? 0)).hover({ timeout: 10_000 });
        return send(200, { ok: true });
      }
      case '/press':
        await p.keyboard.press(String(body.key));
        return send(200, { ok: true });
      case '/type':
        await p.keyboard.type(String(body.text), { delay: 20 });
        return send(200, { ok: true });
      case '/screenshot': {
        const file = path.join(capDir, `${name}-${Date.now()}.png`);
        await p.screenshot({ path: file, fullPage: false });
        return send(200, { file });
      }
      case '/mark':
        log({ kind: 'mark', label: body.label });
        return send(200, { ok: true });
      case '/replay': {
        // Call an endpoint from Node with the most recent captured bearer token for `aud`.
        const aud = String(body.aud ?? '');
        const t = tokens.get(aud) ?? [...tokens.values()].find((x) => String(body.url).includes(x.host));
        const headers: Record<string, string> = { ...(body.headers as Record<string, string> | undefined) };
        if (t) headers.authorization = t.header;
        const r = await fetch(String(body.url), {
          method: String(body.method ?? 'GET'),
          headers,
          body: body.body === undefined ? undefined : typeof body.body === 'string' ? body.body : JSON.stringify(body.body),
        });
        const text = await r.text();
        return send(200, { status: r.status, ctype: r.headers.get('content-type'), body: text.slice(0, MAX_BODY) });
      }
      case '/quit':
        send(200, { ok: true });
        setTimeout(async () => {
          stream.end();
          await ctx.close();
          server.close();
          process.exit(0);
        }, 100);
        return;
      default:
        return send(404, { error: 'unknown command' });
    }
  } catch (e) {
    return send(500, { error: String(e) });
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`discover: capturing to ${capFile}`);
  console.log(`discover: control on http://127.0.0.1:${port} (token in captures/.control)`);
});
ctx.on('close', () => {
  stream.end();
  process.exit(0);
});

