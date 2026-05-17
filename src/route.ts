import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = "anthropic-oauth" | "aistack";

export type RoutingDecision = {
  provider: Provider;
  /** When set, rewrite the request's model field before dispatching. */
  rewriteModel?: string;
  reason: "sentinel" | "opus" | "execution";
};

const PLAN_MODE_MODEL = "claude-opus-4-7";

// Sentinel file: when present, all execution traffic is forced to OAuth Opus.
// Toggle with `forky-opus on/off`. The file is treated as stale after MAX_AGE_MS
// so a forgotten sentinel doesn't quietly burn the Max quota forever.
const SENTINEL = join(homedir(), ".forky", "opus");
const SENTINEL_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4h auto-expiry

function sentinelActive(): boolean {
  if (!existsSync(SENTINEL)) return false;
  try {
    const age = Date.now() - statSync(SENTINEL).mtimeMs;
    return age < SENTINEL_MAX_AGE_MS;
  } catch {
    return false;
  }
}

export function decideRoute(
  model: string,
  _body: { tools?: ReadonlyArray<{ name?: string }> } = {},
): RoutingDecision {
  if (sentinelActive()) {
    return { provider: "anthropic-oauth", rewriteModel: PLAN_MODE_MODEL, reason: "sentinel" };
  }
  if (/^claude-opus/i.test(model)) {
    return { provider: "anthropic-oauth", reason: "opus" };
  }
  return { provider: "aistack", reason: "execution" };
}

// Kept for backward compatibility.
export function pickProvider(model: string): Provider {
  return decideRoute(model).provider;
}
