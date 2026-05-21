import type { AnthropicRequest, AiStackRequest } from "../schemas.ts";
import { AiStackRequest as AiStackRequestSchema } from "../schemas.ts";

// The execution-backend model name. Configurable via EXEC_MODEL so the
// proxy is not tied to one specific OpenAI-compatible provider.
const EXECUTION_MODEL = process.env.EXEC_MODEL ?? process.env.AISTACK_MODEL ?? "qwen-35b";

// Tools to strip when routing to the execution backend. These are orchestration
// tools meant for the planner (Opus) — when an execution model invokes them,
// it either spawns another execution-model sub-agent (defeating the split) or
// hallucinates arguments. Override with EXEC_STRIPPED_TOOLS=Foo,Bar.
const DEFAULT_STRIPPED_TOOLS = [
  "Agent",            // spawns sub-agents — only useful to a planner
  "TodoWrite",        // planning artifact
  "AskUserQuestion",  // routes back to the user via Claude Code main loop
  "ExitPlanMode",     // mode toggle — no effect from execution side
  "EnterPlanMode",
  "ScheduleWakeup",
  "TaskOutput",
  "TaskStop",
];
const STRIPPED_TOOLS = new Set(
  (process.env.EXEC_STRIPPED_TOOLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_STRIPPED_TOOLS),
);

type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }
  | { role: "assistant"; content?: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

type OpenAiTool = { type: "function"; function: { name: string; description?: string; parameters: unknown } };

export type TranslateOptions = {
  stream: boolean;
  validate?: boolean; // run Zod validation on the output (default true)
};

/**
 * Translate an Anthropic Messages API request body into an AI Stack
 * (OpenAI Chat Completions) request body, with qwen-35b pinned and
 * server-side tools disabled. Validated against AiStackRequest schema.
 */
// Counter-instruction appended to the system prompt. Claude Code's prompt
// contains <function_calls><invoke name="X">...</invoke></function_calls> XML
// examples (Anthropic's internal tool-call format). Models like qwen-35b mimic
// that pattern instead of using the OpenAI tool_calls field, so the proxy
// receives text like `<Read path="...">` that never invokes anything.
// This override forces structured function-calling and survives the noisy
// prompt by being last and explicit. Override via EXEC_TOOL_FORMAT_NUDGE="".
const DEFAULT_TOOL_NUDGE =
  "\n\n# CRITICAL: Tool-call format override\n" +
  "When you need to use a tool, you MUST emit it via the API's structured `tool_calls` field. " +
  "Do NOT output `<function_calls>`, `<invoke>`, `<parameter>`, or any other XML/HTML tags in your text content — " +
  "they will NOT be executed and will leak as visible text to the user. " +
  "The XML examples earlier in this system prompt are illustrative of Claude's internal format; this API uses OpenAI-style function calling only. " +
  "If you intend to call a tool, return a structured function call. Otherwise just write plain text.";

const TOOL_NUDGE = process.env.EXEC_TOOL_FORMAT_NUDGE ?? DEFAULT_TOOL_NUDGE;

// When FORKY_FRESH_TURNS=on, trim the conversation back to the most recent
// user prompt (preserving any tool_use / tool_result pairs that belong to it).
// FORKY_MAX_MESSAGES applies a hard cap on top of that: even within a single
// user turn, very long tool chains can balloon the context to 50K+ tokens,
// which pushes weaker primaries past their timeout. The cap trims the OLDEST
// messages within the current turn, but always lands on a fresh-user-prompt
// boundary so the Anthropic API's tool_use/tool_result pairing isn't broken.
const MAX_MESSAGES = Number(process.env.FORKY_MAX_MESSAGES ?? 0);

function isPureToolResultMessage(m: { role: string; content: unknown }): boolean {
  if (m.role !== "user") return false;
  const content = m.content;
  return Array.isArray(content) && content.length > 0
    && content.every((b) => typeof b === "object" && b !== null
      && (b as { type: string }).type === "tool_result");
}

function trimToCurrentTurn(messages: AnthropicRequest["messages"]): AnthropicRequest["messages"] {
  if (process.env.FORKY_FRESH_TURNS !== "on") return messages;

  // Step 1: trim to latest user prompt onward.
  let startIdx = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (!isPureToolResultMessage(m)) {
      startIdx = i;
      break;
    }
  }
  let trimmed = messages.slice(startIdx);

  // Step 2: hard cap on total message count, sliding from the end. Walk forward
  // from the cap point until we hit a user message that's a fresh prompt
  // (not a continuation tool_result) — that's a safe slice boundary.
  if (MAX_MESSAGES > 0 && trimmed.length > MAX_MESSAGES) {
    let capStart = trimmed.length - MAX_MESSAGES;
    while (capStart < trimmed.length) {
      const m = trimmed[capStart];
      if (m.role === "user" && !isPureToolResultMessage(m)) break;
      capStart++;
    }
    if (capStart < trimmed.length) {
      trimmed = trimmed.slice(capStart);
    }
    // If no clean slice point exists in the last MAX_MESSAGES, fall through
    // with the unsliced (step-1) trim — Anthropic API needs a valid shape.
  }

  return trimmed;
}

// Replace tool_result blocks the model has already consumed (i.e., there's a
// subsequent assistant message) with one-line placeholders. Big Read/Bash
// outputs often dominate context — past tool results aren't usually re-read,
// only their existence + identity matters for the model's planning. Keeps the
// most recent tool_result block(s) full (those haven't been "consumed" yet).
function truncateConsumedToolResults(messages: AnthropicRequest["messages"]): AnthropicRequest["messages"] {
  // Read env at call time so tests / live config changes take effect without restart.
  if (process.env.FORKY_TRUNCATE_TOOL_RESULTS === "off") return messages;
  const minBytes = Number(process.env.FORKY_TRUNCATE_MIN_BYTES ?? 500);

  // Build tool_use_id → { name, key arg preview } so placeholders carry context.
  const toolInfo = new Map<string, { name: string; argHint: string }>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_use") continue;
      const input = (b as { input?: unknown }).input ?? {};
      let argHint = "";
      if (input && typeof input === "object") {
        const keys = Object.keys(input as object);
        if (keys.length > 0) {
          const v = String((input as Record<string, unknown>)[keys[0]]).slice(0, 60);
          argHint = `${keys[0]}=${v}`;
        }
      }
      toolInfo.set((b as { id: string }).id, { name: (b as { name: string }).name, argHint });
    }
  }

  // Identify the LAST user message containing tool_result — that one is fresh,
  // don't truncate.
  let lastToolResultIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && Array.isArray(m.content)
      && m.content.some((b) => (b as { type?: string }).type === "tool_result")) {
      lastToolResultIdx = i;
      break;
    }
  }

  return messages.map((msg, i) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    if (i === lastToolResultIdx) return msg; // keep most recent tool_result intact
    const newContent = msg.content.map((block) => {
      if ((block as { type?: string }).type !== "tool_result") return block;
      const tr = block as { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };
      const origLen = typeof tr.content === "string"
        ? tr.content.length
        : Array.isArray(tr.content)
          ? tr.content.reduce((s, b) => s + ((b as { text?: string }).text?.length ?? 0), 0)
          : 0;
      if (origLen < minBytes) return block;
      const info = toolInfo.get(tr.tool_use_id);
      const label = info
        ? `${info.name}${info.argHint ? `(${info.argHint})` : ""}`
        : "tool";
      const placeholder = `[${label} → ${origLen} chars, consumed by a later turn]`;
      return { ...tr, content: placeholder };
    });
    return { ...msg, content: newContent };
  });
}

// Replace base64 image blocks in already-consumed user turns with a one-line
// placeholder. A screenshot attachment is ~100K tokens of base64; once the
// model has reasoned about it (i.e. a later user turn exists), re-sending the
// full payload every turn just bloats context — past qwen-35b's 128K window in
// long sessions — without adding information. The MOST RECENT image-bearing user
// message is kept intact (the model may still be looking at it). HTTP-URL images
// are left alone (cheap to reference). Disable via FORKY_TRUNCATE_IMAGES=off.
function truncateConsumedImages(messages: AnthropicRequest["messages"]): AnthropicRequest["messages"] {
  if (process.env.FORKY_TRUNCATE_IMAGES === "off") return messages;

  const hasBase64Image = (m: { role: string; content: unknown }): boolean =>
    m.role === "user" && Array.isArray(m.content)
    && m.content.some((b) => (b as { type?: string }).type === "image"
      && (b as { source?: { type?: string } }).source?.type === "base64");

  let lastImageIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasBase64Image(messages[i])) { lastImageIdx = i; break; }
  }
  if (lastImageIdx < 0) return messages;

  return messages.map((msg, i) => {
    if (i === lastImageIdx) return msg; // keep the freshest image intact
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    let touched = false;
    const newContent = msg.content.map((block) => {
      const b = block as { type?: string; source?: { type?: string; media_type?: string; data?: string } };
      if (b.type !== "image" || b.source?.type !== "base64") return block;
      touched = true;
      const kb = Math.round((b.source.data?.length ?? 0) / 1024);
      return { type: "text" as const, text: `[image attachment (${b.source.media_type ?? "image"}, ~${kb}KB) from an earlier turn — omitted; described in surrounding messages]` };
    });
    return touched ? { ...msg, content: newContent } : msg;
  });
}

export function translateRequest(req: AnthropicRequest, opts: TranslateOptions): AiStackRequest {
  const messages: OpenAiMessage[] = [];
  const turnMessages = truncateConsumedImages(truncateConsumedToolResults(trimToCurrentTurn(req.messages)));

  // System prompt: flatten string-or-array form into one OpenAI system message,
  // then append the tool-format override so it has maximum recency.
  if (req.system != null) {
    const sysText = typeof req.system === "string"
      ? req.system
      : req.system.map((b) => b.text).join("\n\n");
    const finalSys = (sysText + (req.tools && req.tools.length > 0 ? TOOL_NUDGE : "")).trim();
    if (finalSys.length > 0) messages.push({ role: "system", content: finalSys });
  } else if (req.tools && req.tools.length > 0) {
    messages.push({ role: "system", content: TOOL_NUDGE.trim() });
  }

  for (const msg of turnMessages) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === "user") {
      // user blocks: text, image, tool_result (becomes a separate "tool" message)
      const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
      const trailingToolMessages: OpenAiMessage[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          const url = block.source.type === "base64"
            ? `data:${block.source.media_type};base64,${block.source.data}`
            : block.source.url;
          parts.push({ type: "image_url", image_url: { url } });
        } else if (block.type === "tool_result") {
          const text = stringifyToolResult(block.content);
          trailingToolMessages.push({ role: "tool", tool_call_id: block.tool_use_id, content: text });
        }
        // tool_use / thinking blocks in user role shouldn't happen; ignore.
      }
      if (parts.length > 0) {
        // Collapse a single text part to plain string for cleanliness.
        const content = parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
        messages.push({ role: "user", content });
      }
      messages.push(...trailingToolMessages);
    } else {
      // assistant: collect text into content + tool_use into tool_calls
      let textBuf = "";
      const toolCalls: NonNullable<Extract<OpenAiMessage, { role: "assistant" }>["tool_calls"]> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textBuf += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
        // thinking blocks dropped — qwen has its own reasoning mechanism.
      }
      const out: Extract<OpenAiMessage, { role: "assistant" }> = { role: "assistant" };
      if (textBuf.length > 0) out.content = textBuf;
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      // Assistant messages must have either content or tool_calls; if neither, emit empty content.
      if (out.content == null && !out.tool_calls) out.content = "";
      messages.push(out);
    }
  }

  const tools: OpenAiTool[] | undefined = req.tools
    ?.filter((t) => !STRIPPED_TOOLS.has(t.name))
    .map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema ?? {} },
    }));

  const out: AiStackRequest = {
    model: EXECUTION_MODEL,
    messages,
    stream: opts.stream,
    tools_enabled: false,
    max_tokens: req.max_tokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
  };

  if (opts.validate !== false) {
    const parsed = AiStackRequestSchema.safeParse(out);
    if (!parsed.success) {
      throw new Error(`translated request fails schema: ${parsed.error.message}`);
    }
    return parsed.data;
  }
  return out;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => {
      if (b?.type === "text") return b.text;
      if (b?.type === "image") return "[image]";
      return JSON.stringify(b);
    }).join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}
