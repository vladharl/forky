import { describe, expect, test } from "bun:test";
import { Semaphore, withSemaphore } from "../src/resilience/semaphore.ts";

describe("Semaphore", () => {
  test("max=1 serializes two acquires", async () => {
    const s = new Semaphore(1);
    const order: string[] = [];
    const r1 = await s.acquire();
    const p2 = s.acquire().then((r) => { order.push("p2-got"); return r; });
    order.push("p1-got");
    expect(s.snapshot()).toEqual({ active: 1, queued: 1, max: 1 });
    r1();
    const r2 = await p2;
    expect(order).toEqual(["p1-got", "p2-got"]);
    r2();
    expect(s.snapshot()).toEqual({ active: 0, queued: 0, max: 1 });
  });

  test("max=2 lets two run concurrently, queues the third", async () => {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    let p3resolved = false;
    const p3 = s.acquire().then((r) => { p3resolved = true; return r; });
    await new Promise((r) => setTimeout(r, 5));
    expect(p3resolved).toBe(false);
    expect(s.snapshot()).toEqual({ active: 2, queued: 1, max: 2 });
    r1();
    const r3 = await p3;
    expect(p3resolved).toBe(true);
    r2(); r3();
    expect(s.snapshot().active).toBe(0);
  });

  test("withSemaphore releases on success", async () => {
    const s = new Semaphore(1);
    const result = await withSemaphore(s, async () => 42);
    expect(result).toBe(42);
    expect(s.snapshot().active).toBe(0);
  });

  test("withSemaphore releases on throw", async () => {
    const s = new Semaphore(1);
    let err: unknown;
    try {
      await withSemaphore(s, async () => { throw new Error("boom"); });
    } catch (e) { err = e; }
    expect((err as Error).message).toBe("boom");
    expect(s.snapshot().active).toBe(0);
  });

  test("FIFO order: queued acquires resolve in arrival order", async () => {
    const s = new Semaphore(1);
    const r0 = await s.acquire();
    const arrival: number[] = [];
    const p1 = s.acquire().then((r) => { arrival.push(1); return r; });
    const p2 = s.acquire().then((r) => { arrival.push(2); return r; });
    const p3 = s.acquire().then((r) => { arrival.push(3); return r; });
    r0();
    const r1 = await p1; r1();
    const r2 = await p2; r2();
    const r3 = await p3; r3();
    expect(arrival).toEqual([1, 2, 3]);
  });

  test("rejects max < 1", () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});
