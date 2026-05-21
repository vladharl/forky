import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { fetchWithRetryOn429 } from "../src/resilience/retry.ts";

function mockFetch(responses: Array<Partial<{ status: number; headers: Record<string, string>; body: string }>>) {
  let i = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof fetch;
  return {
    calls: () => i,
    restore: () => { globalThis.fetch = orig; },
  };
}

describe("fetchWithRetryOn429", () => {
  let teardown: () => void = () => {};
  afterEach(() => teardown());

  test("non-429 response returned immediately", async () => {
    const m = mockFetch([{ status: 200, body: "ok" }]);
    teardown = m.restore;
    const res = await fetchWithRetryOn429("http://x", {}, { maxAttempts: 3, baseDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(m.calls()).toBe(1);
  });

  test("429 → 200 retries once and returns 200", async () => {
    const m = mockFetch([{ status: 429, body: "{\"error\":\"busy\"}" }, { status: 200, body: "ok" }]);
    teardown = m.restore;
    const res = await fetchWithRetryOn429("http://x", {}, { maxAttempts: 3, baseDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(m.calls()).toBe(2);
  });

  test("max 429s exhausts retries and returns last 429", async () => {
    const m = mockFetch([{ status: 429 }, { status: 429 }, { status: 429 }]);
    teardown = m.restore;
    const res = await fetchWithRetryOn429("http://x", {}, { maxAttempts: 3, baseDelayMs: 1 });
    expect(res.status).toBe(429);
    expect(m.calls()).toBe(3);
  });

  test("honours Retry-After header (in seconds)", async () => {
    const m = mockFetch([{ status: 429, headers: { "retry-after": "0" } }, { status: 200, body: "ok" }]);
    teardown = m.restore;
    const start = Date.now();
    const res = await fetchWithRetryOn429("http://x", {}, { maxAttempts: 2, baseDelayMs: 5000 });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000); // retry-after=0 should be near-immediate (NOT the 5s default)
  });

  test("5xx is NOT retried by default (caller handles)", async () => {
    const m = mockFetch([{ status: 500, body: "bork" }]);
    teardown = m.restore;
    const res = await fetchWithRetryOn429("http://x", {}, { maxAttempts: 3, baseDelayMs: 1 });
    expect(res.status).toBe(500);
    expect(m.calls()).toBe(1);
  });

  test("transient 5xx IS retried when in retryStatuses, then recovers", async () => {
    const m = mockFetch([{ status: 500, body: "burst" }, { status: 502 }, { status: 200, body: "ok" }]);
    teardown = m.restore;
    const res = await fetchWithRetryOn429("http://x", {}, { maxAttempts: 3, baseDelayMs: 1, retryStatuses: [429, 500, 502, 503, 504] });
    expect(res.status).toBe(200);
    expect(m.calls()).toBe(3);
  });

  test("persistent 5xx exhausts retries and returns last 5xx for fallback", async () => {
    const m = mockFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    teardown = m.restore;
    const res = await fetchWithRetryOn429("http://x", {}, { maxAttempts: 3, baseDelayMs: 1, retryStatuses: [500] });
    expect(res.status).toBe(500);
    expect(m.calls()).toBe(3);
  });

  test("aborted before retry stops retrying", async () => {
    const m = mockFetch([{ status: 429 }, { status: 200, body: "should not reach" }]);
    teardown = m.restore;
    const ac = new AbortController();
    ac.abort();
    const res = await fetchWithRetryOn429("http://x", { signal: ac.signal }, { maxAttempts: 3, baseDelayMs: 50 });
    expect(res.status).toBe(429);
    expect(m.calls()).toBe(1);
  });
});
