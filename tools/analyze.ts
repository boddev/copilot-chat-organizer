// Summarize a discovery capture.
//   node tools/analyze.ts <capture.jsonl> [--grep <regex>] [--show <id>] [--since <mark label>] [--bodies]
import fs from 'node:fs';

type Entry = Record<string, any>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/analyze.ts <capture.jsonl> [--grep re] [--show id] [--since label] [--bodies]');
  process.exit(1);
}
const grep = arg('grep') ? new RegExp(arg('grep')!, 'i') : null;
const show = arg('show');
const since = arg('since');
const bodies = process.argv.includes('--bodies');

let entries: Entry[] = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

if (since) {
  const idx = entries.findIndex((e) => e.kind === 'mark' && e.label === since);
  if (idx >= 0) entries = entries.slice(idx);
}

const responses = new Map<number, Entry>();
for (const e of entries) if (e.kind === 'response') responses.set(e.id, e);

if (show) {
  const id = Number(show);
  const req = entries.find((e) => e.kind === 'request' && e.id === id);
  console.log(JSON.stringify({ request: req, response: responses.get(id) }, null, 2));
  process.exit(0);
}

const NOISE = /browser\.events\.data|\/collect|telemetry|aria\.microsoft|\/OneCollector|events\.data\.microsoft|clarity\.ms|\/beacon|applicationinsights|\.svg|\/ping$/i;

function pattern(u: string): string {
  const url = new URL(u);
  const p = url.pathname
    .split('/')
    .map((s) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
      /^\d{4,}$/.test(s) ||
      (s.length > 24 && /[0-9]/.test(s) && /^[A-Za-z0-9_\-=+%.:@]+$/.test(s))
        ? '{id}'
        : s,
    )
    .join('/');
  return `${url.host}${p}`;
}

if (grep || bodies) {
  for (const e of entries) {
    if (e.kind !== 'request') continue;
    if (grep && !grep.test(e.url)) continue;
    const r = responses.get(e.id);
    console.log(`#${e.id} ${e.method} ${e.url} -> ${r?.status ?? '?'} ${r?.ctype ?? ''} ${r?.body ? r.body.length + 'b' : ''}`);
    if (e.post) console.log(`   post: ${String(e.post).slice(0, 600)}`);
    if (bodies && r?.body) console.log(`   body: ${String(r.body).slice(0, 1200)}`);
  }
  process.exit(0);
}

const groups = new Map<string, { count: number; statuses: Set<number>; ids: number[]; bytes: number }>();
for (const e of entries) {
  if (e.kind !== 'request' || NOISE.test(e.url)) continue;
  const key = `${e.method} ${pattern(e.url)}`;
  const g = groups.get(key) ?? { count: 0, statuses: new Set(), ids: [], bytes: 0 };
  g.count++;
  const r = responses.get(e.id);
  if (r) {
    g.statuses.add(r.status);
    g.bytes = Math.max(g.bytes, r.body?.length ?? 0);
  }
  if (g.ids.length < 4) g.ids.push(e.id);
  groups.set(key, g);
}
for (const [k, g] of [...groups.entries()].sort()) {
  console.log(`${String(g.count).padStart(3)}  ${k}  [${[...g.statuses].join(',')}] max=${g.bytes}b ids=${g.ids.join(',')}`);
}
const ws = entries.filter((e) => e.kind === 'websocket').map((e) => e.url);
if (ws.length) console.log('\nwebsockets:\n  ' + [...new Set(ws)].join('\n  '));
