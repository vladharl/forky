import { getAccessToken, forceRefresh } from "./oauth.ts";
import { log } from "./log.ts";

const ANTHROPIC_BASE = "https://api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";
const CC_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const FALLBACK_MODEL = "claude-sonnet-4-6";

export type AnthropicBody = Record<string, unknown> & {
  model?: string;
  system?: string | Array<{ type: string; text?: string }>;
  stream?: boolean;
};

// Beta strings the OAuth /v1/messages endpoint does NOT accept. Claude Code sends
// these because they're enabled for its first-party path, but they 400 the
// general OAuth path. Drop them from the merged anthropic-beta header.
const UNSUPPORTED_BETAS_ON_OAUTH = new Set([
  "context-management-2025-08-20",
]);

// Body fields gated by a beta we can't keep. Strip them so the request is accepted.
const STRIP_BODY_FIELDS = ["context_management"];

export async function forwardOAuth(
  body: AnthropicBody,
  signal?: AbortSignal,
  clientHeaders?: Record<string, string>,
): Promise<Response> {
  const prepared = stripUnsupportedFields(injectSystemBlock(body));
  let token = await getAccessToken();
  let res = await callAnthropic(token, prepared, signal, clientHeaders);
  if (res.status === 401) {
    log("warn", "anthropic.401_retry");
    token = await forceRefresh();
    res = await callAnthropic(token, prepared, signal, clientHeaders);
  }
  return res;
}

function stripUnsupportedFields(body: AnthropicBody): AnthropicBody {
  const out: AnthropicBody = { ...body };
  for (const f of STRIP_BODY_FIELDS) {
    if (f in out) delete (out as Record<string, unknown>)[f];
  }
  return out;
}

/**
 * Same as forwardOAuth but rewrites the model name to a Claude family model
 * (defaults to claude-sonnet-4-6). Used as the fallback path when AI Stack
 * is unavailable and the original request was for qwen-35b/non-Claude.
 */
export async function forwardOAuthAsFallback(
  body: AnthropicBody,
  signal?: AbortSignal,
  fallbackModel: string = FALLBACK_MODEL,
  clientHeaders?: Record<string, string>,
): Promise<Response> {
  const rewritten: AnthropicBody = { ...body };
  if (typeof body.model !== "string" || !/^claude-/i.test(body.model)) {
    rewritten.model = fallbackModel;
  }
  return forwardOAuth(rewritten, signal, clientHeaders);
}

function callAnthropic(
  token: string,
  body: AnthropicBody,
  signal?: AbortSignal,
  clientHeaders?: Record<string, string>,
): Promise<Response> {
  // Merge any anthropic-beta headers the client sent with our required OAuth beta.
  // Claude Code sends things like "context-management-2025-08-20,fine-grained-tool-streaming-2025-05-14"
  // that gate request-body fields. Stripping them causes 400 "Extra inputs are not permitted".
  const clientBeta = clientHeaders?.["anthropic-beta"];
  const betas = new Set<string>();
  if (clientBeta) {
    for (const b of clientBeta.split(",")) {
      const t = b.trim();
      if (t && !UNSUPPORTED_BETAS_ON_OAUTH.has(t)) betas.add(t);
    }
  }
  betas.add(OAUTH_BETA);
  log("info", "anthropic.betas", { sent: Array.from(betas) });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${token}`,
    "anthropic-version": clientHeaders?.["anthropic-version"] ?? (body["anthropic-version"] as string) ?? "2023-06-01",
    "anthropic-beta": Array.from(betas).join(","),
    "accept": body.stream ? "text/event-stream" : "application/json",
  };
  return fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

export function injectSystemBlock(body: AnthropicBody): AnthropicBody {
  const out: AnthropicBody = { ...body };
  const required = { type: "text" as const, text: CC_SYSTEM_PROMPT };
  if (out.system == null) {
    out.system = [required];
    return out;
  }
  if (typeof out.system === "string") {
    out.system = [required, { type: "text", text: out.system }];
    return out;
  }
  if (Array.isArray(out.system)) {
    const first = out.system[0];
    const alreadyPresent = first && first.type === "text"
      && typeof first.text === "string"
      && first.text.startsWith("You are Claude Code");
    if (!alreadyPresent) {
      out.system = [required, ...out.system];
    }
  }
  return out;
}
