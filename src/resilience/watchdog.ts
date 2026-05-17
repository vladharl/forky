/**
 * Wrap a ReadableStream so that:
 *   - No data within firstByteMs after subscription → abort + "first-byte timeout"
 *   - Gap between chunks > interChunkMs → abort + "inter-chunk timeout"
 *
 * The returned stream emits the same chunks as the source, but errors out
 * the consumer with a tagged Error on timeout. The provided AbortController
 * is aborted so an in-flight upstream fetch is cancelled too.
 */
export type WatchdogOptions = {
  firstByteMs: number;
  interChunkMs: number;
  abort: AbortController;
};

export class WatchdogTimeoutError extends Error {
  constructor(public readonly kind: "first-byte" | "inter-chunk", ms: number) {
    super(`watchdog: ${kind} timeout after ${ms}ms`);
    this.name = "WatchdogTimeoutError";
  }
}

export function withWatchdog<T extends Uint8Array>(
  source: ReadableStream<T>,
  opts: WatchdogOptions,
): ReadableStream<T> {
  const reader = source.getReader();
  let firstByteSeen = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const fail = (controller: ReadableStreamDefaultController<T>, kind: "first-byte" | "inter-chunk", ms: number) => {
    const err = new WatchdogTimeoutError(kind, ms);
    try { opts.abort.abort(err); } catch {}
    controller.error(err);
    reader.cancel(err).catch(() => undefined);
  };

  return new ReadableStream<T>({
    start(controller) {
      timer = setTimeout(() => fail(controller, "first-byte", opts.firstByteMs), opts.firstByteMs);
      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) { clearTimer(); controller.close(); return; }
            if (!firstByteSeen) firstByteSeen = true;
            clearTimer();
            timer = setTimeout(() => fail(controller, "inter-chunk", opts.interChunkMs), opts.interChunkMs);
            controller.enqueue(value);
          }
        } catch (e) {
          clearTimer();
          controller.error(e);
        }
      })();
    },
    cancel(reason) {
      clearTimer();
      try { opts.abort.abort(reason); } catch {}
      return reader.cancel(reason);
    },
  });
}
