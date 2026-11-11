// Call a copilot.cloud.microsoft server function through the running discovery harness page.
//   node tools/sfn.ts '{"action":"GetNavProjectChats","projectId":"19:...@thread.v2"}' [--hash <fnHash>] [--out file]
import fs from 'node:fs';
import { decodeBody, encodeRequest } from '../src/lib/seroval.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const data = JSON.parse(args[0]);
const hash = opt('--hash') ?? '73e9366cfbebe3976abc796ef16c0305213fd6f32aea4731837e2a1f18e54268';
const out = opt('--out');
const control = JSON.parse(fs.readFileSync(new URL('../captures/.control', import.meta.url), 'utf8'));

const body = encodeRequest(data);
const expr = `fetch('/_serverFn/${hash}', { method: 'POST', headers: { 'x-tsr-serverfn': 'true', 'content-type': 'application/json', accept: 'application/x-tss-framed, application/x-ndjson, application/json' }, body: ${JSON.stringify(body)} }).then(async (r) => ({ status: r.status, text: await r.text() }))`;
const res = await fetch(`http://127.0.0.1:${control.port}/eval`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-control-token': control.token },
  body: JSON.stringify({ expr }),
});
const { result, error } = (await res.json()) as { result?: { status: number; text: string }; error?: string };
if (error || !result) throw new Error(error ?? 'no result');
let decoded: unknown;
try {
  decoded = decodeBody(result.text);
} catch {
  decoded = result.text.slice(0, 2000);
}
const text = JSON.stringify({ status: result.status, response: decoded }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
if (out) {
  fs.writeFileSync(out, text);
  console.log(`status ${result.status}; wrote ${out} (${text.length} chars)`);
} else console.log(text);
