import { z } from "zod";

// ───────── Anthropic Messages API (incoming from Claude Code) ─────────

const AnthropicTextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
}).passthrough();

const AnthropicImageBlock = z.object({
  type: z.literal("image"),
  source: z.union([
    z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
    z.object({ type: z.literal("url"), url: z.string() }),
  ]),
}).passthrough();

const AnthropicToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
}).passthrough();

const AnthropicToolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.union([AnthropicTextBlock, AnthropicImageBlock]))]).optional(),
  is_error: z.boolean().optional(),
}).passthrough();

const AnthropicThinkingBlock = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
}).passthrough();

export const AnthropicContentBlock = z.discriminatedUnion("type", [
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
]);

export const AnthropicMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(AnthropicContentBlock)]),
});

export const AnthropicToolDef = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.unknown(),
}).passthrough();

export const AnthropicRequest = z.object({
  model: z.string(),
  messages: z.array(AnthropicMessage).min(1),
  system: z.union([z.string(), z.array(AnthropicTextBlock)]).optional(),
  max_tokens: z.number().int().positive(),
  tools: z.array(AnthropicToolDef).optional(),
  tool_choice: z.unknown().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
  thinking: z.unknown().optional(),
}).passthrough();
export type AnthropicRequest = z.infer<typeof AnthropicRequest>;

// ───────── Anthropic Messages API (outgoing to Claude Code, non-streaming) ─────────

export const AnthropicResponse = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
  ])),
  stop_reason: z.enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).nullable(),
  stop_sequence: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});
export type AnthropicResponse = z.infer<typeof AnthropicResponse>;

// ───────── AI Stack / OpenAI Chat Completions (outgoing to AI Stack) ─────────

const OpenAiTextPart = z.object({ type: z.literal("text"), text: z.string() });
const OpenAiImagePart = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string() }),
});
const OpenAiContentPart = z.discriminatedUnion("type", [OpenAiTextPart, OpenAiImagePart]);

const OpenAiSystemMessage = z.object({
  role: z.literal("system"),
  content: z.string(),
});
const OpenAiUserMessage = z.object({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(OpenAiContentPart)]),
});
const OpenAiToolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
const OpenAiAssistantMessage = z.object({
  role: z.literal("assistant"),
  content: z.string().nullable().optional(),
  tool_calls: z.array(OpenAiToolCall).optional(),
});
const OpenAiToolMessage = z.object({
  role: z.literal("tool"),
  tool_call_id: z.string(),
  content: z.string(),
});

export const OpenAiMessage = z.union([
  OpenAiSystemMessage,
  OpenAiUserMessage,
  OpenAiAssistantMessage,
  OpenAiToolMessage,
]);

export const OpenAiToolDef = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown(),
  }),
});

// Outgoing AI-Stack-style request. Model name is whatever the operator set via
// EXEC_MODEL — the proxy isn't tied to a specific provider. tools_enabled is
// pinned false to prevent server-side tool loops (relevant for backends that
// expose them; harmless for ones that don't).
export const AiStackRequest = z.object({
  model: z.string().min(1),
  messages: z.array(OpenAiMessage),
  stream: z.boolean(),
  tools_enabled: z.literal(false),
  max_tokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(OpenAiToolDef).optional(),
});
export type AiStackRequest = z.infer<typeof AiStackRequest>;

// ───────── AI Stack non-streaming response ─────────

export const AiStackResponse = z.object({
  id: z.string(),
  choices: z.array(z.object({
    index: z.number(),
    message: z.object({
      role: z.literal("assistant"),
      content: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(),
      tool_calls: z.array(OpenAiToolCall).nullable().optional(),
    }),
    finish_reason: z.enum(["stop", "length", "tool_calls", "content_filter"]).nullable(),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number().optional(),
  }).optional(),
}).passthrough();
export type AiStackResponse = z.infer<typeof AiStackResponse>;

// ───────── AI Stack streaming SSE frame (used in Phase 3) ─────────

export const OpenAiSseDelta = z.object({
  role: z.string().optional(),
  content: z.string().nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  tool_calls: z.array(z.object({
    index: z.number(),
    id: z.string().optional(),
    type: z.literal("function").optional(),
    function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
  })).optional(),
}).passthrough();

export const OpenAiSseChunk = z.object({
  object: z.literal("chat.completion.chunk").optional(),
  id: z.string().optional(),
  choices: z.array(z.object({
    index: z.number(),
    delta: OpenAiSseDelta,
    finish_reason: z.enum(["stop", "length", "tool_calls", "content_filter"]).nullable().optional(),
  })).optional(),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number().optional(),
  }).optional(),
}).passthrough();

// AI Stack portal extensions — drop in the translator, but validate shape.
export const AiStackPortalFrame = z.object({
  object: z.enum(["chat.queue", "chat.compaction", "chat.tool_call", "chat.tool_result", "chat.tool_error"]),
}).passthrough();

// ───────── Anthropic event stream (outgoing to Claude Code, used in Phase 3) ─────────

export const AnthropicEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_start"), message: z.unknown() }),
  z.object({ type: z.literal("content_block_start"), index: z.number(), content_block: z.unknown() }),
  z.object({ type: z.literal("content_block_delta"), index: z.number(), delta: z.unknown() }),
  z.object({ type: z.literal("content_block_stop"), index: z.number() }),
  z.object({ type: z.literal("message_delta"), delta: z.unknown(), usage: z.unknown().optional() }),
  z.object({ type: z.literal("message_stop") }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("error"), error: z.object({ type: z.string(), message: z.string() }) }),
]);
export type AnthropicEvent = z.infer<typeof AnthropicEvent>;
