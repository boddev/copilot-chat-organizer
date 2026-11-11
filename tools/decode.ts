// Decode seroval-encoded server-function traffic from a capture.
//   node tools/decode.ts <capture.jsonl> <id> [--out file.json] [--depth N]
import fs from 'node:fs';
import { decodeBody } from '../src/lib/seroval.ts';

const [file, idArg] = process.argv.slice(2);
const outIdx = process.argv.indexOf('--out');
const out = outIdx > 0 ? process.argv[outIdx + 1] : undefined;
const id = Number(idArg);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const req = lines.find((e) => e.kind === 'request' && e.id === id);
const res = lines.find((e) => e.kind === 'response' && e.id === id);
const safe = (s: string | undefined) => {
  if (!s) return undefined;
  try {
    return decodeBody(s);
  } catch (e) {
    return { undecodable: String(e), raw: s.slice(0, 500) };
  }
};
const result = { url: req?.url, request: safe(req?.post), status: res?.status, response: safe(res?.body) };
const text = JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
if (out) {
  fs.writeFileSync(out, text);
  console.log(`wrote ${out} (${text.length} chars)`);
} else {
  console.log(text);
}
