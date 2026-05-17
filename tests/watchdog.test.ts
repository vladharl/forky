import { describe, expect, test } from "bun:test";
import { withWatchdog, WatchdogTimeoutError } from "../src/resilience/watchdog.ts";

function neverEndingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() { /* never enqueues, never closes */ },
  });
}

function streamFromChunks(chunks: Array<{ delayMs: number; bytes: Uint8Array }>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const { delayMs, bytes } of chunks) {
        await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
}

describe("withWatchdog", () => {
  test("fires first-byte timeout when no data arrives", async () => {
    const abort = new AbortController();
    const guarded = withWatchdog(neverEndingStream(), { firstByteMs: 50, interChunkMs: 1000, abort });
    const reader = guarded.getReader();
    let err: unknown;
    try { await reader.read(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WatchdogTimeoutError);
    expect((err as WatchdogTimeoutError).kind).toBe("first-byte");
    expect(abort.signal.aborted).toBe(true);
  });

  test("passes chunks through when arriving within budget", async () => {
    const abort = new AbortController();
    const src = streamFromChunks([
      { delayMs: 10, bytes: new Uint8Array([1, 2]) },
      { delayMs: 10, bytes: new Uint8Array([3]) },
    ]);
    const guarded = withWatchdog(src, { firstByteMs: 500, interChunkMs: 500, abort });
    const reader = guarded.getReader();
    const a = await reader.read();
    const b = await reader.read();
    const c = await reader.read();
    expect(a.value).toEqual(new Uint8Array([1, 2]));
    expect(b.value).toEqual(new Uint8Array([3]));
    expect(c.done).toBe(true);
    expect(abort.signal.aborted).toBe(false);
  });

  test("fires inter-chunk timeout when gap exceeds budget", async () => {
    const abort = new AbortController();
    const src = streamFromChunks([
      { delayMs: 5, bytes: new Uint8Array([1]) },
      { delayMs: 200, bytes: new Uint8Array([2]) }, // exceeds 50ms inter-chunk
    ]);
    const guarded = withWatchdog(src, { firstByteMs: 500, interChunkMs: 50, abort });
    const reader = guarded.getReader();
    const a = await reader.read();
    expect(a.value).toEqual(new Uint8Array([1]));
    let err: unknown;
    try { await reader.read(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WatchdogTimeoutError);
    expect((err as WatchdogTimeoutError).kind).toBe("inter-chunk");
    expect(abort.signal.aborted).toBe(true);
  });
});
