// List server-function actions (and marks) in a capture, in order.
//   node tools/actions.ts <capture.jsonl> [--since markLabel] [--grep regex]
import fs from 'node:fs';
import { decodeBody } from '../src/lib/seroval.ts';

const args = process.argv.slice(2);
const file = args[0];
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i > 0 ? args[i + 1] : undefined;
};
const since = opt('--since');
const grep = opt('--grep') ? new RegExp(opt('--grep')!, 'i') : undefined;

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const responses = new Map<number, { status?: number; body?: string }>();
for (const e of lines) if (e.kind === 'response') responses.set(e.id, e);

let active = !since;
for (const e of lines) {
  if (e.kind === 'mark') {
    if (since && e.label === since) active = true;
    if (active) console.log(`--- mark: ${e.label}`);
    continue;
  }
  if (!active || e.kind !== 'request' || typeof e.url !== 'string' || !e.url.includes('/_serverFn/')) continue;
  let action = '(no body)';
  let detail = '';
  try {
    if (e.post) {
      const data = (decodeBody(e.post) as { data?: Record<string, unknown> })?.data ?? {};
      action = String(data.action ?? '(no action)');
      detail = Object.keys(data)
        .filter((k) => k !== 'action' && k !== 'state')
        .map((k) => `${k}=${JSON.stringify(data[k])?.slice(0, 80)}`)
        .join(' ');
    } else {
      const q = new URL(e.url).searchParams.get('payload');
      if (q) {
        const data = (decodeBody(q) as { data?: Record<string, unknown> })?.data ?? {};
        action = `GET ${JSON.stringify(data).slice(0, 100)}`;
      } else action = 'GET';
    }
  } catch (err) {
    action = `(undecodable: ${String(err).slice(0, 60)})`;
  }
  const r = responses.get(e.id);
  const line = `${e.id}\t${action}\t[${r?.status ?? '-'}] ${r?.body?.length ?? 0}b\t${e.url.split('/_serverFn/')[1].slice(0, 8)}\t${detail}`;
  if (!grep || grep.test(line)) console.log(line);
}
