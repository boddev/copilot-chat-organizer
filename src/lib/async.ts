// Small async helpers: concurrency limiting, sleeping and retry with backoff.

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs at most `limit` tasks at a time. */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= limit) return;
    const run = queue.shift();
    if (run) run();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

/** Maps items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retries throttling and transient server errors (429, 502, 503, 504) with backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseMs = 800): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof HttpError && [429, 502, 503, 504].includes(e.status);
      if (!retryable || attempt >= attempts) throw e;
      const wait = (e as HttpError).retryAfterMs ?? baseMs * 2 ** (attempt - 1);
      await sleep(Math.min(wait, 30_000));
    }
  }
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
