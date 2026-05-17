import { describe, expect, test } from "bun:test";
import { Circuit } from "../src/resilience/circuit.ts";

describe("Circuit.restore", () => {
  test("restores OPEN state when snapshot is within openMs window", () => {
    const now = 1_000_000;
    const c = new Circuit({ threshold: 3, windowMs: 60_000, openMs: 60_000, now: () => now });
    const restored = c.restore({
      state: "open",
      failureCount: 5,
      openedAt: now - 10_000, // 10s ago, well within 60s window
      nextProbeAt: now + 50_000,
    });
    expect(restored).toBe(true);
    expect(c.snapshot().state).toBe("open");
    expect(c.shouldAllow()).toBe(false);
  });

  test("ignores stale snapshot beyond openMs window", () => {
    const now = 1_000_000;
    const c = new Circuit({ threshold: 3, windowMs: 60_000, openMs: 60_000, now: () => now });
    const restored = c.restore({
      state: "open",
      failureCount: 5,
      openedAt: now - 120_000, // 2 minutes ago, past 60s window
      nextProbeAt: now - 60_000,
    });
    expect(restored).toBe(false);
    expect(c.snapshot().state).toBe("closed");
  });

  test("ignores CLOSED snapshot (nothing to restore)", () => {
    const c = new Circuit();
    expect(c.restore({ state: "closed", failureCount: 0, openedAt: null, nextProbeAt: null })).toBe(false);
  });

  test("handles null / missing snapshot gracefully", () => {
    const c = new Circuit();
    expect(c.restore(null)).toBe(false);
    expect(c.restore(undefined)).toBe(false);
    expect(c.snapshot().state).toBe("closed");
  });
});
