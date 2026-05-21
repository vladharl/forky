import { log } from "../log.ts";

export type RetryOptions = {
  /** total attempts including the first; min 1 */
  maxAttempts: number;
  /** base for exponential backoff (delay = base * 4^attemptIdx) */
  baseDelayMs: number;
  /** max single backoff cap */
  maxDelayMs?: number;
  /** label included in logs */
  label?: string;
  /**
   * HTTP statuses that trigger a retry. Defaults to [429]. Pass transient 5xx
   * (500/502/503/504) for upstreams that fail in short capacity bursts so a
   * single blip doesn't fall straight through to a pricier fallback path.
   */
  retryStatuses?: number[];
};

/**
 * fetch() wrapper that retries on configured HTTP statuses (default: 429 only).
 * Honours Retry-After when present; otherwise applies exponential backoff
 * (baseDelayMs * 4^attempt). Statuses not in the retry set and network errors
 * are NOT retried — they bubble up to the caller's existing fallback logic.
 * Aborted requests are not retried.
 */
export async function fetchWithRetryOn429(
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  const max = Math.max(1, opts.maxAttempts);
  const maxDelay = opts.maxDelayMs ?? 10_000;
  const retryStatuses = opts.retryStatuses ?? [429];
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt < max; attempt++) {
    const res = await fetch(url, init);
    if (!retryStatuses.includes(res.status) || attempt === max - 1) return res;

    // Retryable status with attempts left — figure out wait and try again.
    const retryAfter = res.status === 429 ? res.headers.get("retry-after") : null;
    let delayMs: number;
    if (retryAfter) {
      const n = Number(retryAfter);
      delayMs = Number.isFinite(n) ? Math.min(n * 1000, maxDelay) : opts.baseDelayMs;
    } else {
      delayMs = Math.min(opts.baseDelayMs * Math.pow(4, attempt), maxDelay);
    }

    // Drain response body so the connection can be reused.
    await res.text().catch(() => "");
    log("info", "retry.status", { label: opts.label ?? "fetch", status: res.status, attempt: attempt + 1, of: max, delayMs });

    // Honour the caller's abort signal during the delay.
    if (init.signal?.aborted) return res;
    await sleep(delayMs, init.signal);
    if (init.signal?.aborted) return res;
    lastRes = res;
  }
  // Unreachable due to `attempt === max - 1` guard, but keep TS happy.
  return lastRes!;
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); });
  });
}
