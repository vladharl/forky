import type { AnthropicRequest } from "./schemas.ts";
import { getAiStackEnv, execFetch } from "./aistack.ts";
import { log } from "./log.ts";

const SUMMARIZER_MODEL = process.env.FORKY_SUMMARIZER_MODEL ?? "gemma-micro";
const SUMMARIZE_THRESHOLD = Number(process.env.FORKY_SUMMARIZE_THRESHOLD ?? 0);
const SUMMARIZE_MAX_INPUT_CHARS = Number(process.env.FORKY_SUMMARIZE_MAX_INPUT_CHARS ?? 80_000);
const SUMMARIZER_TIMEOUT_MS = Number(process.env.FORKY_SUMMARIZER_TIMEOUT_MS ?? 15_000);

const SUMMARIZE_SYSTEM = (
  "You are a conversation summarizer. The input is a sequence of [role] turn lines from an earlier "
  + "agent session. Produce 5-15 concise bullets capturing the SUBSTANCE: decisions made, files "
  + "touched, key findings, and what state the work is in. Drop verbose tool outputs and chitchat. "
  + "Output ONLY the bullets — no preamble, no closing summary. Keep under 1500 tokens."
);

/**
 * If the conversation exceeds FORKY_SUMMARIZE_THRESHOLD messages, fold the
 * older half into a single summary system block (computed by a small model)
 * and keep only the recent half verbatim. Returns the original request on any
 * failure, opt-out, or under-threshold case so this is always safe to call.
 */
export async function maybeSummarize(req: AnthropicRequest): Promise<AnthropicRequest> {
  if (SUMMARIZE_THRESHOLD <= 0) return req;
  if (req.messages.length <= SUMMARIZE_THRESHOLD) return req;

  // Pick a split point at the midpoint, then advance to land on a user-message
  // boundary so the kept tail starts with a valid Anthropic shape.
  let split = Math.floor(req.messages.length / 2);
  while (split < req.messages.length && req.messages[split].role !== "user") split++;
  if (split >= req.messages.length || split === 0) return req;

  const oldHalf = req.messages.slice(0, split);
  const newHalf = req.messages.slice(split);

  // Render oldHalf as compact text for the summarizer's input.
  const renderBlock = (b: unknown): string => {
    const blk = b as { type: string; text?: string; name?: string; tool_use_id?: string; content?: unknown };
    if (blk.type === "text") return blk.text ?? "";
    if (blk.type === "tool_use") return `<call ${blk.name ?? "?"}>`;
    if (blk.type === "tool_result") {
      const c = typeof blk.content === "string" ? blk.content : JSON.stringify(blk.content);
      return `<result for ${blk.tool_use_id ?? "?"}: ${c.slice(0, 200)}…>`;
    }
    return "";
  };
  let oldText = oldHalf.map((m) => {
    const body = typeof m.content === "string"
      ? m.content
      : m.content.map(renderBlock).filter(Boolean).join(" ");
    return `[${m.role}] ${body}`;
  }).join("\n");
  if (oldText.length > SUMMARIZE_MAX_INPUT_CHARS) {
    oldText = oldText.slice(0, SUMMARIZE_MAX_INPUT_CHARS) + "\n…[truncated for summarizer]";
  }

  let env: ReturnType<typeof getAiStackEnv>;
  try { env = getAiStackEnv(); }
  catch (e) { log("warn", "compact.no_env", { err: (e as Error).message }); return req; }

  let res: Response;
  try {
    res = await execFetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify({
        model: SUMMARIZER_MODEL,
        stream: false,
        max_tokens: 1500,
        tools_enabled: false,
        messages: [
          { role: "system", content: SUMMARIZE_SYSTEM },
          { role: "user", content: oldText },
        ],
      }),
      signal: AbortSignal.timeout(SUMMARIZER_TIMEOUT_MS),
    }, "compact.summarize");
  } catch (e) {
    log("warn", "compact.fetch_failed", { err: (e as Error).message });
    return req;
  }

  if (!res.ok) {
    log("warn", "compact.upstream_error", { status: res.status });
    await res.text().catch(() => "");
    return req;
  }

  const data = await res.json().catch(() => null) as
    | { choices?: Array<{ message?: { content?: string | null } }> }
    | null;
  const summary = data?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!summary) {
    log("warn", "compact.empty_summary");
    return req;
  }

  log("info", "compact.applied", {
    droppedMessages: oldHalf.length,
    keptMessages: newHalf.length,
    summaryChars: summary.length,
  });

  const summaryBlock = {
    type: "text" as const,
    text: `[Earlier conversation summary (${oldHalf.length} messages compacted)]\n${summary}`,
  };
  const newSystem = req.system == null
    ? [summaryBlock]
    : typeof req.system === "string"
      ? [{ type: "text" as const, text: req.system }, summaryBlock]
      : [...req.system, summaryBlock];

  return { ...req, system: newSystem, messages: newHalf };
}
