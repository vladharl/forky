export type CircuitState = "closed" | "open" | "half-open";

export type CircuitSnapshot = {
  state: CircuitState;
  failureCount: number;
  openedAt: number | null;
  nextProbeAt: number | null;
};

export type CircuitOptions = {
  /** failures within `windowMs` that open the circuit */
  threshold: number;
  /** sliding window for failure counting */
  windowMs: number;
  /** how long the circuit stays open before allowing a probe */
  openMs: number;
  /** clock source — for tests */
  now?: () => number;
};

const DEFAULTS: Required<Omit<CircuitOptions, "now">> = {
  threshold: 3,
  windowMs: 60_000,
  openMs: 60_000,
};

export class Circuit {
  private state: CircuitState = "closed";
  private failures: number[] = [];
  private openedAt: number | null = null;
  private readonly opts: Required<CircuitOptions>;

  constructor(opts: Partial<CircuitOptions> = {}) {
    this.opts = {
      threshold: opts.threshold ?? DEFAULTS.threshold,
      windowMs: opts.windowMs ?? DEFAULTS.windowMs,
      openMs: opts.openMs ?? DEFAULTS.openMs,
      now: opts.now ?? Date.now,
    };
  }

  /** Returns true if the request should attempt the primary path. */
  shouldAllow(): boolean {
    const now = this.opts.now();
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (now - (this.openedAt ?? 0) >= this.opts.openMs) {
        this.state = "half-open";
        return true;
      }
      return false;
    }
    // half-open: already letting one probe through; subsequent calls block until probe resolves
    return false;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.failures = [];
    this.openedAt = null;
  }

  recordFailure(): void {
    const now = this.opts.now();
    this.failures = this.failures.filter((t) => now - t < this.opts.windowMs);
    this.failures.push(now);
    if (this.state === "half-open" || this.failures.length >= this.opts.threshold) {
      this.state = "open";
      this.openedAt = now;
    }
  }

  snapshot(): CircuitSnapshot {
    const now = this.opts.now();
    return {
      state: this.state,
      failureCount: this.failures.filter((t) => now - t < this.opts.windowMs).length,
      openedAt: this.openedAt,
      nextProbeAt: this.openedAt != null ? this.openedAt + this.opts.openMs : null,
    };
  }
}
