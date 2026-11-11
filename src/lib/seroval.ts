// Minimal codec for the seroval JSON node format used by TanStack Start server functions
// (copilot.cloud.microsoft/_serverFn/*). Handles plain data (objects, arrays, primitives,
// dates, maps, sets, back-references); exotic node types decode to a tagged placeholder.

export type SerovalNode = {
  t: number;
  i?: number;
  s?: unknown;
  l?: number;
  a?: (SerovalNode | null)[];
  p?: { k: (string | number)[]; v: SerovalNode[]; s?: number };
  e?: { k: SerovalNode[]; v: SerovalNode[]; s?: number };
  o?: number;
  c?: string;
  m?: string;
  f?: SerovalNode;
};

const CONSTANTS: unknown[] = [null, undefined, true, false, -0, Infinity, -Infinity, NaN];

const UNESCAPES: Record<string, string> = {
  '\\\\': '\\',
  '\\"': '"',
  '\\n': '\n',
  '\\r': '\r',
  '\\b': '\b',
  '\\t': '\t',
  '\\f': '\f',
  '\\x3C': '<',
  '\\u2028': '\u2028',
  '\\u2029': '\u2029',
};

export function unescapeString(s: string): string {
  return s.replace(/\\\\|\\"|\\n|\\r|\\b|\\t|\\f|\\x3C|\\u2028|\\u2029/g, (m) => UNESCAPES[m] ?? m);
}

export function escapeString(s: string): string {
  return s.replace(/[\\"\n\r\b\t\f<\u2028\u2029]/g, (ch) => {
    switch (ch) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\b':
        return '\\b';
      case '\t':
        return '\\t';
      case '\f':
        return '\\f';
      case '<':
        return '\\x3C';
      case '\u2028':
        return '\\u2028';
      default:
        return '\\u2029';
    }
  });
}

export function decode(node: SerovalNode | null | undefined, refs: Map<number, unknown> = new Map()): unknown {
  if (node == null) return undefined;
  const keep = <T>(v: T): T => {
    if (node.i !== undefined) refs.set(node.i, v);
    return v;
  };
  switch (node.t) {
    case 0:
      return node.s as number;
    case 1:
      return unescapeString(String(node.s));
    case 2:
      return CONSTANTS[Number(node.s)];
    case 3:
      return BigInt(String(node.s));
    case 4:
      return refs.get(Number(node.i));
    case 5:
      return keep(new Date(String(node.s)));
    case 6:
      return keep(new RegExp(unescapeString(String(node.c)), node.m));
    case 7: {
      const set = keep(new Set<unknown>());
      for (const item of node.a ?? []) set.add(decode(item, refs));
      return set;
    }
    case 8: {
      const map = keep(new Map<unknown, unknown>());
      const keys = node.e?.k ?? [];
      keys.forEach((k, idx) => map.set(decode(k, refs), decode(node.e!.v[idx], refs)));
      return map;
    }
    case 9: {
      const arr = keep([] as unknown[]);
      for (const item of node.a ?? []) arr.push(item === null ? undefined : decode(item, refs));
      return arr;
    }
    case 10:
    case 11: {
      const obj = keep(node.t === 11 ? (Object.create(null) as Record<string, unknown>) : ({} as Record<string, unknown>));
      const keys = node.p?.k ?? [];
      keys.forEach((k, idx) => {
        obj[typeof k === 'string' ? unescapeString(k) : String(k)] = decode(node.p!.v[idx], refs);
      });
      return obj;
    }
    case 13:
      return keep({ __error: true, name: node.c, message: unescapeString(String(node.m ?? '')) });
    default:
      return keep({ __seroval: node.t });
  }
}

/** Decode a server-function response body (raw text). */
export function decodeBody(text: string): unknown {
  const parsed = JSON.parse(text);
  const root = parsed && typeof parsed === 'object' && 't' in parsed && typeof parsed.t === 'object' ? parsed.t : parsed;
  return decode(root as SerovalNode);
}

/** Encode a plain JSON-like value as a seroval node tree. */
export function encode(value: unknown): SerovalNode {
  let next = 0;
  const walk = (v: unknown): SerovalNode => {
    if (v === null) return { t: 2, s: 0 };
    if (v === undefined) return { t: 2, s: 1 };
    if (v === true) return { t: 2, s: 2 };
    if (v === false) return { t: 2, s: 3 };
    if (typeof v === 'number') {
      if (Object.is(v, -0)) return { t: 2, s: 4 };
      if (v === Infinity) return { t: 2, s: 5 };
      if (v === -Infinity) return { t: 2, s: 6 };
      if (Number.isNaN(v)) return { t: 2, s: 7 };
      return { t: 0, s: v };
    }
    if (typeof v === 'string') return { t: 1, s: escapeString(v) };
    if (typeof v === 'bigint') return { t: 3, s: v.toString() };
    if (v instanceof Date) return { t: 5, i: next++, s: v.toISOString() };
    if (Array.isArray(v)) {
      const i = next++;
      return { t: 9, i, a: v.map(walk), o: 0 };
    }
    if (typeof v === 'object') {
      const i = next++;
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
      return { t: 10, i, p: { k: entries.map(([k]) => escapeString(k)), v: entries.map(([, x]) => walk(x)) }, o: 0 };
    }
    throw new Error(`seroval.encode: unsupported value type ${typeof v}`);
  };
  return walk(value);
}

/** Build a server-function POST body: {"t": <node>, "f": 127, "m": []}. */
export function encodeRequest(data: unknown): string {
  return JSON.stringify({ t: encode({ data }), f: 127, m: [] });
}
