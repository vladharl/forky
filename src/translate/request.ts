import type { AnthropicRequest, AiStackRequest } from "../schemas.ts";
import { AiStackRequest as AiStackRequestSchema } from "../schemas.ts";

// The execution-backend model name. Configurable via EXEC_MODEL so the
// proxy is not tied to one specific OpenAI-compatible provider.
const EXECUTION_MODEL = process.env.EXEC_MODEL ?? process.env.AISTACK_MODEL ?? "qwen-35b";

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
export function translateRequest(req: AnthropicRequest, opts: TranslateOptions): AiStackRequest {
  const messages: OpenAiMessage[] = [];

  // System prompt: flatten string-or-array form into one OpenAI system message.
  if (req.system != null) {
    const sysText = typeof req.system === "string"
      ? req.system
      : req.system.map((b) => b.text).join("\n\n");
    if (sysText.length > 0) messages.push({ role: "system", content: sysText });
  }

  for (const msg of req.messages) {
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

  const tools: OpenAiTool[] | undefined = req.tools?.map((t) => ({
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
