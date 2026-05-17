import { describe, expect, test } from "bun:test";
import { Circuit } from "../src/resilience/circuit.ts";

function fakeClock() {
  let now = 1_000_000_000;
  return { now: () => now, advance(ms: number) { now += ms; } };
}

describe("Circuit", () => {
  test("starts closed and allows traffic", () => {
    const c = new Circuit();
    expect(c.shouldAllow()).toBe(true);
    expect(c.snapshot().state).toBe("closed");
  });

  test("opens after threshold failures in window", () => {
    const clk = fakeClock();
    const c = new Circuit({ threshold: 3, windowMs: 60_000, openMs: 60_000, now: clk.now });
    c.recordFailure();
    c.recordFailure();
    expect(c.snapshot().state).toBe("closed");
    expect(c.shouldAllow()).toBe(true);
    c.recordFailure();
    expect(c.snapshot().state).toBe("open");
    expect(c.shouldAllow()).toBe(false);
  });

  test("failures outside the window do not count", () => {
    const clk = fakeClock();
    const c = new Circuit({ threshold: 3, windowMs: 60_000, openMs: 60_000, now: clk.now });
    c.recordFailure();
    c.recordFailure();
    clk.advance(61_000);
    c.recordFailure();
    c.recordFailure();
    expect(c.snapshot().state).toBe("closed");
    expect(c.snapshot().failureCount).toBe(2);
  });

  test("transitions open → half-open after openMs and allows one probe", () => {
    const clk = fakeClock();
    const c = new Circuit({ threshold: 1, windowMs: 60_000, openMs: 30_000, now: clk.now });
    c.recordFailure();
    expect(c.snapshot().state).toBe("open");
    expect(c.shouldAllow()).toBe(false);
    clk.advance(30_001);
    expect(c.shouldAllow()).toBe(true); // first probe
    expect(c.snapshot().state).toBe("half-open");
    expect(c.shouldAllow()).toBe(false); // no second probe while half-open
  });

  test("probe success closes the circuit", () => {
    const clk = fakeClock();
    const c = new Circuit({ threshold: 1, windowMs: 60_000, openMs: 30_000, now: clk.now });
    c.recordFailure();
    clk.advance(30_001);
    c.shouldAllow();
    c.recordSuccess();
    expect(c.snapshot().state).toBe("closed");
    expect(c.shouldAllow()).toBe(true);
  });

  test("probe failure re-opens the circuit", () => {
    const clk = fakeClock();
    const c = new Circuit({ threshold: 1, windowMs: 60_000, openMs: 30_000, now: clk.now });
    c.recordFailure();
    clk.advance(30_001);
    c.shouldAllow();
    c.recordFailure();
    expect(c.snapshot().state).toBe("open");
    expect(c.snapshot().openedAt).toBe(clk.now());
  });
});
