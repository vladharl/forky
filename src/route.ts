import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = "anthropic-oauth" | "aistack";

export type RoutingDecision = {
  provider: Provider;
  /** When set, rewrite the request's model field before dispatching. */
  rewriteModel?: string;
  reason: "sentinel" | "opus" | "execution" | "classifier";
};

const PLAN_MODE_MODEL = "claude-opus-4-7";
const CLASSIFIER_FALLBACK_MODEL = process.env.FORKY_CLASSIFIER_MODEL ?? "claude-sonnet-4-6";

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

// Heuristic: Claude Code fires a tiny classifier request before every tool
// invocation in auto-mode to decide if the tool is safe to auto-run. The
// classifier expects a structured Claude response; if it goes to qwen, qwen
// returns plain text and Claude Code shows
// "<model> is temporarily unavailable, so auto mode cannot determine safety".
//
// Signature of the classifier (vs the main agent):
//   - tools: 0 (main agent has ~60+ tools)
//   - role: "user" content is small, system prompt is short
//
// We route any zero-tool Claude-* request to OAuth. Main-agent traffic has
// many tools and still goes to the execution backend.
function looksLikeClassifierRequest(
  model: string,
  body: { tools?: ReadonlyArray<unknown> },
): boolean {
  if (!/^claude-/i.test(model)) return false;
  return !body.tools || body.tools.length === 0;
}

export function decideRoute(
  model: string,
  body: { tools?: ReadonlyArray<{ name?: string }> } = {},
): RoutingDecision {
  if (sentinelActive()) {
    return { provider: "anthropic-oauth", rewriteModel: PLAN_MODE_MODEL, reason: "sentinel" };
  }
  if (/^claude-opus/i.test(model)) {
    return { provider: "anthropic-oauth", reason: "opus" };
  }
  if (looksLikeClassifierRequest(model, body)) {
    // Force a real Claude response. Use Sonnet (cheap on Max) unless the user
    // overrode via FORKY_CLASSIFIER_MODEL.
    return { provider: "anthropic-oauth", rewriteModel: CLASSIFIER_FALLBACK_MODEL, reason: "classifier" };
  }
  return { provider: "aistack", reason: "execution" };
}

// Kept for backward compatibility. The classifier heuristic relies on the
// body's tools field, which a model-name-only caller doesn't have; assume
// main-agent context (tools present) so this returns the original answer.
export function pickProvider(model: string): Provider {
  return decideRoute(model, { tools: [{ name: "_main_agent_stub" }] }).provider;
}
