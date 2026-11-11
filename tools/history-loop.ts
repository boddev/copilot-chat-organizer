// Page through the full M365 Copilot chat history via the running discovery harness (read-only).
//   node tools/history-loop.ts [--max 40] [--first nav|list]
import fs from 'node:fs';
import { decodeBody, encodeRequest } from '../src/lib/seroval.ts';

const opt = (name: string, d: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : d;
};
const max = Number(opt('--max', '40'));
const first = opt('--first', 'nav');
const elm = process.argv.includes('--elm');
const fullState = process.argv.includes('--full-state');
const hash = '73e9366cfbebe3976abc796ef16c0305213fd6f32aea4731837e2a1f18e54268';
const control = JSON.parse(fs.readFileSync(new URL('../captures/.control', import.meta.url), 'utf8'));

async function sfn(data: unknown): Promise<any> {
  const body = encodeRequest(data);
  const expr = `fetch('/_serverFn/${hash}', { method: 'POST', headers: { 'x-tsr-serverfn': 'true', 'content-type': 'application/json', accept: 'application/x-tss-framed, application/x-ndjson, application/json' }, body: ${JSON.stringify(body)} }).then(async (r) => ({ status: r.status, text: await r.text() }))`;
  const res = await fetch(`http://127.0.0.1:${control.port}/eval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-control-token': control.token },
    body: JSON.stringify({ expr }),
  });
  const { result, error } = (await res.json()) as { result?: { status: number; text: string }; error?: string };
  if (error || !result) throw new Error(error ?? 'no result');
  if (result.status !== 200) throw new Error(`status ${result.status}: ${result.text.slice(0, 300)}`);
  return decodeBody(result.text);
}

const decodeSync = (s: string) => {
  try {
    const o = JSON.parse(Buffer.from(s, 'base64').toString());
    return JSON.parse(Buffer.from(o.IC3SyncState, 'base64').toString());
  } catch {
    return null;
  }
};

const seen = new Map<string, any>();
let syncState = '';
if (first === 'nav') {
  const r = await sfn({
    action: 'RefreshNavPane',
    conversationHistoryFilter: null,
    skipNotebooks: true,
    skipAgentListCache: false,
    preservePinnedChats: false,
    enableLastMessage: false,
    state: {},
  });
  const l = r.result.store.conversationPageHistoryList;
  for (const c of l.chats) seen.set(c.conversationId, c);
  syncState = l.syncState;
  console.log('nav', l.chats.length, JSON.stringify(decodeSync(syncState)?.deliveredSegments?.[0]), JSON.stringify(l.metrics).slice(0, 120));
}
for (let page = 0; page < max; page++) {
  const t0 = Date.now();
  const r = await sfn({
    action: 'GetConversationPageHistoryList',
    syncState,
    enableLastMessage: elm,
    saveToStore: 'chatLandingPageHistoryList',
    state: { chatLandingPageHistoryList: { chats: fullState ? [...seen.values()] : [], syncState } },
  });
  const l = r.result.store.chatLandingPageHistoryList;
  let fresh = 0;
  for (const c of l.chats) if (!seen.has(c.conversationId)) (seen.set(c.conversationId, c), fresh++);
  const seg = decodeSync(l.syncState);
  console.log(
    `page ${page}: returned ${l.chats.length} new ${fresh} total ${seen.size} ${Date.now() - t0}ms seg ${JSON.stringify(seg?.deliveredSegments?.[0])} zero ${JSON.stringify(seg?.zeroLMSTDeliveredSegments)} chatCount ${l.metrics?.chatCount} hasSync ${l.metrics?.hasSyncState} trace ${String(l.metrics?.responseTraceId).slice(0, 8)} ttfb ${l.metrics?.timeToFirstByte}`,
  );
  if (l.syncState === syncState) {
    console.log('syncState unchanged -> stop');
    break;
  }
  syncState = l.syncState;
  if (fresh === 0 && page > 0) {
    console.log('no new chats -> stop');
    break;
  }
}
const all = [...seen.values()].sort((a, b) => b.updateTimeUtc - a.updateTimeUtc);
console.log('TOTAL', all.length, 'oldest', new Date(all.at(-1).updateTimeUtc).toISOString());
fs.writeFileSync(new URL('../captures/history-all.json', import.meta.url), JSON.stringify(all, null, 1));
