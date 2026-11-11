import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, decodeBody, encode, encodeRequest, escapeString, unescapeString, type SerovalNode } from '../src/lib/seroval.ts';
import { HttpError, createLimiter, mapLimit, parseRetryAfter, sleep, withRetry } from '../src/lib/async.ts';

test('seroval string escaping round-trips every escaped character', () => {
  const s = 'a"b\\c\nd\re\tf\bg\fh <script> \u2028\u2029 back\\nslash ✓';
  const escaped = escapeString(s);
  assert.doesNotMatch(escaped, /[<\n\r\t\u2028\u2029]/);
  assert.equal(unescapeString(escaped), s);
});

test('seroval encode and decode round-trip plain data', () => {
  const value = {
    text: 'quote " and <tag>',
    'key "q"\n': 1,
    n: 42.5,
    neg: -0,
    inf: Infinity,
    ninf: -Infinity,
    nan: NaN,
    flags: [true, false, null, undefined],
    big: 12345678901234567890n,
    when: new Date('2026-01-02T03:04:05.000Z'),
    nested: { list: [1, [2, 3], { deep: 'yes' }] },
    skipped: undefined,
  };
  const out = decode(encode(value)) as Record<string, any>;
  assert.equal(out.text, value.text);
  assert.equal(out['key "q"\n'], 1);
  assert.equal(out.n, 42.5);
  assert.ok(Object.is(out.neg, -0));
  assert.equal(out.inf, Infinity);
  assert.equal(out.ninf, -Infinity);
  assert.ok(Number.isNaN(out.nan));
  assert.deepEqual(out.flags, [true, false, null, undefined]);
  assert.equal(out.big, 12345678901234567890n);
  assert.ok(out.when instanceof Date);
  assert.equal(out.when.toISOString(), '2026-01-02T03:04:05.000Z');
  assert.deepEqual(out.nested, value.nested);
  assert.ok(!('skipped' in out));
  assert.throws(() => encode({ fn: () => 1 }), /unsupported value type function/);
});

test('seroval decode resolves references, maps, sets and special nodes', () => {
  const node = {
    t: 10,
    i: 0,
    p: {
      k: ['self', 'tags', 'lookup', 'proto', 'err', 'odd', 'arr', 'when', 're'],
      v: [
        { t: 4, i: 0 },
        { t: 7, i: 1, a: [{ t: 1, s: 'a' }, { t: 1, s: 'b' }] },
        { t: 8, i: 2, e: { k: [{ t: 1, s: 'x' }], v: [{ t: 0, s: 1 }] } },
        { t: 11, i: 3, p: { k: ['k'], v: [{ t: 2, s: 2 }] } },
        { t: 13, i: 4, c: 'TypeError', m: 'bad \\x3C' },
        { t: 99, i: 5 },
        { t: 9, i: 6, a: [null, { t: 0, s: 1 }, { t: 4, i: 1 }] },
        { t: 5, i: 7, s: '2026-03-04T05:06:07.000Z' },
        { t: 6, i: 8, c: '^a\\\\d+', m: 'gi' },
      ],
    },
  } as SerovalNode;
  const out = decode(node) as Record<string, any>;
  assert.equal(out.self, out);
  assert.deepEqual([...out.tags], ['a', 'b']);
  assert.equal(out.lookup.get('x'), 1);
  assert.equal(Object.getPrototypeOf(out.proto), null);
  assert.equal(out.proto.k, true);
  assert.deepEqual(out.err, { __error: true, name: 'TypeError', message: 'bad <' });
  assert.deepEqual(out.odd, { __seroval: 99 });
  assert.equal(out.arr.length, 3);
  assert.equal(out.arr[0], undefined);
  assert.equal(out.arr[2], out.tags);
  assert.equal(out.when.getTime(), Date.parse('2026-03-04T05:06:07.000Z'));
  assert.ok(out.re.test('A12'));
  assert.equal(decode(null), undefined);
});

test('server-function request and response bodies', () => {
  const body = encodeRequest({ action: 'GetNavProjectChats', projectId: 'P1', state: {} });
  const parsed = JSON.parse(body);
  assert.equal(parsed.f, 127);
  assert.deepEqual(parsed.m, []);
  assert.deepEqual(decode(parsed.t), { data: { action: 'GetNavProjectChats', projectId: 'P1', state: {} } });

  assert.deepEqual(decodeBody(JSON.stringify({ t: encode({ ok: 1 }), f: 63, m: [] })), { ok: 1 });
  assert.deepEqual(decodeBody(JSON.stringify(encode([1, 'two']))), [1, 'two']);
  assert.throws(() => decodeBody('not json'));
});

test('mapLimit preserves order and bounds concurrency', async () => {
  let active = 0;
  let max = 0;
  const out = await mapLimit([30, 5, 20, 1, 10, 2], 2, async (ms, i) => {
    active++;
    max = Math.max(max, active);
    await sleep(ms);
    active--;
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ['0:30', '1:5', '2:20', '3:1', '4:10', '5:2']);
  assert.equal(max, 2);
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
});

test('createLimiter runs at most N tasks at a time and propagates failures', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let max = 0;
  const run = (i: number) =>
    limit(async () => {
      active++;
      max = Math.max(max, active);
      await sleep(5);
      active--;
      if (i === 3) throw new Error('task 3 failed');
      return i;
    });
  const results = await Promise.allSettled([0, 1, 2, 3, 4].map(run));
  assert.equal(max, 2);
  assert.deepEqual(
    results.map((r) => (r.status === 'fulfilled' ? r.value : (r.reason as Error).message)),
    [0, 1, 2, 'task 3 failed', 4],
  );
});

test('withRetry retries throttling and transient errors only', async () => {
  let calls = 0;
  const value = await withRetry(
    async () => {
      calls++;
      if (calls === 1) throw new HttpError('throttled', 429, 1);
      if (calls === 2) throw new HttpError('unavailable', 503);
      return 'ok';
    },
    4,
    1,
  );
  assert.deepEqual([value, calls], ['ok', 3]);

  calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new HttpError('bad request', 400);
    }),
    /bad request/,
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new HttpError('still throttled', 429, 1);
      },
      3,
      1,
    ),
    /still throttled/,
  );
  assert.equal(calls, 3);
});

test('parseRetryAfter reads seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(''), undefined);
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
  const ahead = parseRetryAfter(new Date(Date.now() + 120_000).toUTCString())!;
  assert.ok(ahead > 100_000 && ahead <= 120_000, String(ahead));
});
