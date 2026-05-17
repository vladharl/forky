/**
 * A simple async counting semaphore. Acquires beyond `max` are queued in FIFO
 * order until a release frees a slot. The caller is responsible for invoking
 * the release function returned by acquire() exactly once — use withSemaphore()
 * to avoid leaking slots on exceptions.
 */
export class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(public readonly max: number) {
    if (max < 1) throw new Error(`Semaphore max must be ≥ 1, got ${max}`);
  }

  acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  snapshot(): { active: number; queued: number; max: number } {
    return { active: this.current, queued: this.queue.length, max: this.max };
  }
}

/**
 * Acquire the semaphore, run fn, always release — even if fn throws.
 */
export async function withSemaphore<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  const release = await sem.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
