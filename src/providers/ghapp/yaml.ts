// Minimal reader for the flat `key: value` documents the Copilot CLI writes
// (session-state/<id>/workspace.yaml). Returns top-level scalars only. The first
// occurrence of a key wins: some files end with a torn tail that repeats keys.

const KEY_RE = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const BLOCK_HEADER_RE = /^([|>])([1-9]?)([+-]?)([1-9]?)(?:[ \t]+#.*)?$/;

const ESCAPES: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\x85',
  _: '\xa0',
  L: '\u2028',
  P: '\u2029',
};

export function readTopLevelScalars(source: string): Record<string, string> {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const found = new Map<string, string>();
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const m = KEY_RE.exec(lines[i]);
    i++;
    if (!m) continue;
    const start = i;
    while (i < lines.length && (lines[i].trim() === '' || /^[ \t]/.test(lines[i]))) i++;
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const value = parseValue(m[2] ?? '', lines.slice(start, i));
    if (value !== undefined) found.set(key, value);
  }
  return Object.fromEntries(found);
}

function parseValue(head: string, cont: string[]): string | undefined {
  const h = head.trim();
  if (h === '') {
    // The value starts on the next line; nested mappings and sequences are not scalars.
    const at = cont.findIndex((l) => l.trim() !== '');
    if (at < 0) return '';
    const first = cont[at].trim();
    if (/^-(?:[ \t]|$)/.test(first) || /^[^\s'"#][^:]*:(?:[ \t]|$)/.test(first)) return undefined;
    return parseValue(first, cont.slice(at + 1));
  }
  if (h[0] === '|' || h[0] === '>') {
    const b = BLOCK_HEADER_RE.exec(h);
    if (b) return blockScalar(b[1] === '>', b[3], Number(b[2] || b[4]) || 0, cont);
  }
  if (h[0] === '"') return doubleQuoted([h, ...cont].join('\n'));
  if (h[0] === "'") return singleQuoted([h, ...cont].join('\n'));
  const v = fold([h, ...cont].map((l) => stripComment(l).trim()));
  return /^(?:~|null|Null|NULL)$/.test(v) ? '' : v;
}

function stripComment(line: string): string {
  const m = /[ \t]#/.exec(line);
  return m ? line.slice(0, m.index) : line;
}

/** Flow-scalar folding: a single line break becomes a space, each blank line a newline. */
function fold(parts: string[]): string {
  let out = '';
  let breaks = 0;
  let started = false;
  for (const p of parts) {
    if (p === '') {
      if (started) breaks++;
      continue;
    }
    if (started) out += breaks ? '\n'.repeat(breaks) : ' ';
    out += p;
    started = true;
    breaks = 0;
  }
  return out;
}

/** Handles a line break inside a quoted scalar; returns the new index and the folded text. */
function foldBreak(src: string, i: number): { i: number; text: string } {
  let breaks = 0;
  for (;;) {
    let k = i;
    while (src[k] === ' ' || src[k] === '\t') k++;
    if (src[k] === '\n') {
      breaks++;
      i = k + 1;
      continue;
    }
    return { i: k, text: breaks ? '\n'.repeat(breaks) : ' ' };
  }
}

function doubleQuoted(src: string): string {
  let i = src.indexOf('"') + 1;
  let out = '';
  let ws = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return out + ws;
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) break;
      out += ws;
      ws = '';
      if (n === '\n') {
        // Escaped line break: join without a space and drop the next line's indentation.
        i += 2;
        while (src[i] === ' ' || src[i] === '\t') i++;
        continue;
      }
      const esc = ESCAPES[n];
      if (esc !== undefined) {
        out += esc;
        i += 2;
        continue;
      }
      const len = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0;
      const hex = len ? src.slice(i + 2, i + 2 + len) : '';
      if (len && hex.length === len && /^[0-9a-fA-F]+$/.test(hex)) {
        const cp = parseInt(hex, 16);
        out += cp <= 0x10ffff ? String.fromCodePoint(cp) : '\uFFFD';
        i += 2 + len;
        continue;
      }
      out += n;
      i += 2;
      continue;
    }
    if (c === '\n') {
      ws = '';
      const f = foldBreak(src, i + 1);
      out += f.text;
      i = f.i;
      continue;
    }
    if (c === ' ' || c === '\t') {
      ws += c;
      i++;
      continue;
    }
    out += ws + c;
    ws = '';
    i++;
  }
  return out + ws;
}

function singleQuoted(src: string): string {
  let i = src.indexOf("'") + 1;
  let out = '';
  let ws = '';
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      if (src[i + 1] === "'") {
        out += `${ws}'`;
        ws = '';
        i += 2;
        continue;
      }
      return out + ws;
    }
    if (c === '\n') {
      ws = '';
      const f = foldBreak(src, i + 1);
      out += f.text;
      i = f.i;
      continue;
    }
    if (c === ' ' || c === '\t') {
      ws += c;
      i++;
      continue;
    }
    out += ws + c;
    ws = '';
    i++;
  }
  return out + ws;
}

function blockScalar(folded: boolean, chomp: string, explicitIndent: number, cont: string[]): string {
  let indent = explicitIndent;
  if (!indent) {
    const first = cont.find((l) => l.trim() !== '');
    if (first === undefined) return '';
    indent = first.length - first.trimStart().length;
  }
  const lines = cont.map((l) => {
    if (l.trim() === '') return '';
    const lead = l.length - l.trimStart().length;
    return l.slice(Math.min(indent, lead));
  });
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end--;
  const body = lines.slice(0, end);
  const trailing = lines.length - end;
  const value = folded ? foldBlock(body) : body.join('\n');
  if (!body.length) return '';
  if (chomp === '-') return value;
  if (chomp === '+') return value + '\n'.repeat(trailing + 1);
  return `${value}\n`;
}

function foldBlock(lines: string[]): string {
  let out = '';
  let breaks = 0;
  let prevMore = false;
  let started = false;
  for (const l of lines) {
    if (l === '') {
      breaks++;
      continue;
    }
    const more = l[0] === ' ' || l[0] === '\t';
    if (!started) out += '\n'.repeat(breaks);
    else if (more || prevMore) out += '\n'.repeat(breaks + 1);
    else out += breaks ? '\n'.repeat(breaks) : ' ';
    out += l;
    breaks = 0;
    prevMore = more;
    started = true;
  }
  return out;
}
