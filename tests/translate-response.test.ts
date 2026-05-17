import { describe, expect, test } from "bun:test";
import { translateResponse } from "../src/translate/response.ts";
import { AiStackResponse, AnthropicResponse } from "../src/schemas.ts";

function ai(content: string | null, finish: "stop" | "length" | "tool_calls" | "content_filter" | null = "stop", toolCalls?: unknown) {
  const raw = {
    id: "chatcmpl-x",
    choices: [{
      index: 0,
      message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: finish,
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const p = AiStackResponse.safeParse(raw);
  if (!p.success) throw new Error(`fixture invalid: ${p.error.message}`);
  return p.data;
}

describe("translateResponse", () => {
  test("plain text → single text block, end_turn", () => {
    const out = translateResponse(ai("hello"), "claude-sonnet-4-6");
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(out.content).toEqual([{ type: "text", text: "hello" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  test("finish_reason=length → stop_reason=max_tokens", () => {
    const out = translateResponse(ai("partial", "length"), "x");
    expect(out.stop_reason).toBe("max_tokens");
  });

  test("finish_reason=tool_calls + tool_calls → tool_use block, stop_reason=tool_use", () => {
    const out = translateResponse(ai(null, "tool_calls", [
      { id: "c1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
    ]), "x");
    expect(out.content).toEqual([{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }]);
    expect(out.stop_reason).toBe("tool_use");
  });

  test("text + tool_calls produces both blocks", () => {
    const out = translateResponse(ai("running:", "tool_calls", [
      { id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } },
    ]), "x");
    expect(out.content).toEqual([
      { type: "text", text: "running:" },
      { type: "tool_use", id: "c1", name: "Bash", input: {} },
    ]);
  });

  test("malformed tool args do not produce invalid tool_use; fall back to text note", () => {
    const out = translateResponse(ai(null, "tool_calls", [
      { id: "c1", type: "function", function: { name: "Bash", arguments: "{not valid json" } },
    ]), "x");
    expect(out.content[0].type).toBe("text");
    expect((out.content[0] as any).text).toContain("dropped malformed tool call");
  });

  test("empty response gets empty text block (never zero content blocks)", () => {
    const out = translateResponse(ai("", "stop"), "x");
    expect(out.content).toEqual([{ type: "text", text: "" }]);
  });

  test("output validates against AnthropicResponse schema", () => {
    const fixtures = [
      ai("hi"),
      ai("partial", "length"),
      ai(null, "tool_calls", [{ id: "c", type: "function", function: { name: "N", arguments: "{}" } }]),
      ai(""),
    ];
    for (const f of fixtures) {
      const out = translateResponse(f, "claude-sonnet-4-6");
      expect(AnthropicResponse.safeParse(out).success).toBe(true);
    }
  });
});
