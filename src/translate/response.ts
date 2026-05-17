import type { AiStackResponse, AnthropicResponse } from "../schemas.ts";

/**
 * Translate a non-streaming AI Stack (OpenAI) chat completion response
 * into an Anthropic Messages API response.
 */
export function translateResponse(res: AiStackResponse, requestedModel: string): AnthropicResponse {
  const choice = res.choices[0];
  const msg = choice.message;

  const content: AnthropicResponse["content"] = [];
  if (msg.content && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  }
  if (msg.tool_calls != null && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let input: unknown = {};
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        // Malformed tool args — wrap as text rather than emit invalid tool_use.
        content.push({ type: "text", text: `[forky: dropped malformed tool call ${tc.function.name}: ${tc.function.arguments}]` });
        continue;
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: res.id,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

function mapFinishReason(fr: AiStackResponse["choices"][number]["finish_reason"]): AnthropicResponse["stop_reason"] {
  switch (fr) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    case "content_filter": return "end_turn";
    case null: return "end_turn";
  }
}
