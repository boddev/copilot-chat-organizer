// HTTP API and static UI for the organizer. Binds to localhost only; every API call needs
// the per-launch token embedded in the served page, and Host/Origin are checked to block
// DNS-rebinding and cross-site requests.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type http from 'node:http';
import type { BackupMode, Organizer } from '../core/organizer.ts';
import { UserError } from '../core/errors.ts';
import type { SourceId } from '../core/types.ts';

export interface AppOptions {
  organizer: Organizer;
  publicDir: string;
  token: string;
  /** Port the server listens on, used to validate Host and Origin headers. */
  port: number;
  /** Extra non-secret settings shown in the UI. */
  info?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Json = Record<string, any>;
type Handler = (ctx: { body: Json; params: string[]; query: URLSearchParams }) => unknown | Promise<unknown>;

const MAX_BODY = 4 * 1024 * 1024;
const BACKUP_MODES: BackupMode[] = ['none', 'summary', 'full'];

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, `"${name}" is required`);
  return value;
}

function keys(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((k) => typeof k === 'string')) throw new ApiError(400, '"keys" must be an array of item keys');
  if (!value.length) throw new ApiError(400, 'Select at least one conversation');
  return value;
}

function backupMode(value: unknown): BackupMode | undefined {
  if (value === undefined) return undefined;
  if (!BACKUP_MODES.includes(value as BackupMode)) throw new ApiError(400, `"backup" must be one of ${BACKUP_MODES.join(', ')}`);
  return value as BackupMode;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'Malformed URL');
  }
}

export function createHandler(options: AppOptions): http.RequestListener {
  const { organizer, token } = options;
  const store = organizer.store;
  const publicDir = path.resolve(options.publicDir);
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`, `[::1]:${options.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const tokenBuf = Buffer.from(token);

  const source = (value: unknown): SourceId => {
    const id = str(value, 'source') as SourceId;
    if (!organizer.sourceIds().includes(id)) throw new ApiError(400, `Unknown source "${id}"`);
    return id;
  };

  const routes: Array<[string, RegExp, Handler]> = [];
  const route = (method: string, pattern: string, handler: Handler) => {
    const re = new RegExp(`^${pattern.replace(/:[a-z]+/g, '([^/]+)')}$`);
    routes.push([method, re, handler]);
  };

  route('GET', '/api/info', () => ({ ...options.info, sources: organizer.sourceIds() }));
  route('GET', '/api/sources', () => organizer.summaries());
  route('GET', '/api/items', ({ query }) => organizer.items(query.get('source') ? source(query.get('source')) : undefined));
  route('POST', '/api/refresh', ({ body }) => organizer.refresh(source(body.source)));
  route('GET', '/api/jobs', () => organizer.listJobs());
  route('GET', '/api/jobs/:id', ({ params }) => {
    const job = organizer.job(params[0]);
    if (!job) throw new ApiError(404, 'Unknown job');
    return job;
  });
  route('GET', '/api/transcript', ({ query }) => organizer.transcript(str(query.get('key'), 'key'), query.get('full') === '1'));

  route('POST', '/api/delete/plan', ({ body }) => organizer.planDelete(keys(body.keys)));
  route('POST', '/api/delete', ({ body }) =>
    organizer.delete(keys(body.keys), { backup: backupMode(body.backup), confirm: typeof body.confirm === 'string' ? body.confirm : '' }),
  );

  route('GET', '/api/projects', ({ query }) => organizer.projects(source(query.get('source')), { live: query.get('live') === '1' }));
  route('POST', '/api/projects', ({ body }) => organizer.createProject(source(body.source), str(body.name, 'name')));
  route('PATCH', '/api/projects/:source/:id', async ({ params, body }) => {
    const patch: { name?: string; color?: string | null; archived?: boolean } = {};
    if (body.name !== undefined) patch.name = str(body.name, 'name');
    if (body.color !== undefined) {
      if (body.color !== null && typeof body.color !== 'string') throw new ApiError(400, '"color" must be a string or null');
      patch.color = body.color;
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw new ApiError(400, '"archived" must be true or false');
      patch.archived = body.archived;
    }
    await organizer.updateProject(source(params[0]), params[1], patch);
    return { ok: true };
  });
  route('POST', '/api/projects/:source/:id/assign', ({ params, body }) => organizer.assign(source(params[0]), params[1], keys(body.keys)));
  route('POST', '/api/projects/:source/:id/delete', ({ params, body }) => {
    if (body.contents !== 'keep' && body.contents !== 'delete') throw new ApiError(400, '"contents" must be "keep" or "delete"');
    return organizer.deleteProject(source(params[0]), params[1], {
      contents: body.contents,
      backup: backupMode(body.backup),
      confirm: typeof body.confirm === 'string' ? body.confirm : '',
    });
  });
  route('POST', '/api/unassign', ({ body }) => organizer.unassign(source(body.source), keys(body.keys)));

  route('GET', '/api/collections', () => store.listCollections());
  route('POST', '/api/collections', ({ body }) => store.createCollection(str(body.name, 'name'), typeof body.color === 'string' ? body.color : undefined));
  route('PATCH', '/api/collections/:id', ({ params, body }) =>
    store.updateCollection(params[0], {
      name: body.name === undefined ? undefined : str(body.name, 'name'),
      color: body.color === null || typeof body.color === 'string' ? body.color : undefined,
    }),
  );
  route('DELETE', '/api/collections/:id', ({ params }) => {
    store.deleteCollection(params[0]);
    return { ok: true };
  });
  route('POST', '/api/collections/:id/add', ({ params, body }) => ({ added: store.addToCollection(params[0], keys(body.keys)) }));
  route('POST', '/api/collections/:id/remove', ({ params, body }) => ({ removed: store.removeFromCollection(params[0], keys(body.keys)) }));

  route('GET', '/api/handoff', () => organizer.handoff());
  route('POST', '/api/handoff/remove', ({ body }) => {
    store.removeHandoff(keys(body.keys));
    return organizer.handoff();
  });

  route('GET', '/api/trash', ({ query }) => organizer.trash(source(query.get('source'))));
  route('POST', '/api/trash/restore', ({ body }) => {
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.length || !ids.every((i) => typeof i === 'string')) throw new ApiError(400, '"ids" must be a non-empty array');
    return organizer.restore(source(body.source), ids);
  });
  route('GET', '/api/ops', ({ query }) => store.readOps(Math.min(Number(query.get('limit')) || 200, 2000)));

  const send = (res: http.ServerResponse, status: number, value: unknown) => {
    const body = JSON.stringify(value ?? null);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  };

  const readBody = (req: http.IncomingMessage): Promise<Json> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new ApiError(413, 'Request too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          resolve(parsed as Json);
        } catch {
          reject(new ApiError(400, 'Body must be a JSON object'));
        }
      });
      req.on('error', reject);
    });

  const serveStatic = (res: http.ServerResponse, pathname: string) => {
    const rel = pathname === '/' ? 'index.html' : decode(pathname.slice(1));
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    let data: Buffer | string = fs.readFileSync(file);
    if (ext === '.html') data = data.toString('utf8').replaceAll('%%ORGANIZER_TOKEN%%', token);
    res.writeHead(200, {
      'content-type': STATIC_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': CSP,
      'x-frame-options': 'DENY',
    });
    res.end(data);
  };

  return async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!allowedHosts.has(host)) throw new ApiError(403, 'Forbidden host');
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw new ApiError(403, 'Forbidden origin');
      const url = new URL(req.url ?? '/', `http://${host}`);
      const method = (req.method ?? 'GET').toUpperCase();

      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') throw new ApiError(405, 'Method not allowed');
        serveStatic(res, url.pathname);
        return;
      }

      const given = Buffer.from(String(req.headers['x-organizer-token'] ?? ''));
      if (given.length !== tokenBuf.length || !crypto.timingSafeEqual(given, tokenBuf)) {
        throw new ApiError(401, 'Missing or invalid organizer token. Reload the page.');
      }
      if (method !== 'GET' && method !== 'DELETE' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new ApiError(415, 'Use application/json');
      }

      let matchedPath = false;
      for (const [m, re, handler] of routes) {
        const match = re.exec(url.pathname);
        if (!match) continue;
        matchedPath = true;
        if (m !== method) continue;
        const params = match.slice(1).map(decode);
        const body = method === 'GET' ? {} : await readBody(req);
        send(res, 200, await handler({ body, params, query: url.searchParams }));
        return;
      }
      throw new ApiError(matchedPath ? 405 : 404, matchedPath ? 'Method not allowed' : 'Unknown API endpoint');
    } catch (e) {
      const status = e instanceof ApiError || e instanceof UserError ? e.status : 500;
      const message = String((e as Error)?.message ?? e);
      if (!res.headersSent) send(res, status, { error: message });
      else res.end();
    }
  };
}
