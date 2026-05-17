import { describe, expect, test } from "bun:test";
import { translateRequest } from "../src/translate/request.ts";
import { AnthropicRequest, AiStackRequest } from "../src/schemas.ts";

function parseReq(raw: unknown) {
  const p = AnthropicRequest.safeParse(raw);
  if (!p.success) throw new Error(`fixture invalid: ${p.error.message}`);
  return p.data;
}

describe("translateRequest", () => {
  test("text-only single turn pins qwen-35b and tools_enabled:false", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = translateRequest(req, { stream: false });
    expect(out.model).toBe("qwen-35b");
    expect(out.tools_enabled).toBe(false);
    expect(out.stream).toBe(false);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("system string flattens to one system message", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = translateRequest(req, { stream: true });
    expect(out.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(out.stream).toBe(true);
  });

  test("system array joins with double newline", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: [
        { type: "text", text: "alpha" },
        { type: "text", text: "beta" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const out = translateRequest(req, { stream: false });
    expect(out.messages[0]).toEqual({ role: "system", content: "alpha\n\nbeta" });
  });

  test("tool_use + tool_result roundtrip preserves ids", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "ls" },
        { role: "assistant", content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
        ]},
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "a.txt\nb.txt" },
        ]},
      ],
      tools: [{ name: "Bash", description: "shell", input_schema: { type: "object" } }],
    });
    const out = translateRequest(req, { stream: false });
    // First message is the auto-injected tool-format nudge (because tools are present).
    expect(out.messages[0].role).toBe("system");
    expect((out.messages[0] as { content: string }).content).toContain("Tool-call format override");
    expect(out.messages.slice(1)).toEqual([
      { role: "user", content: "ls" },
      { role: "assistant", content: "running", tool_calls: [
        { id: "tu_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
      ]},
      { role: "tool", tool_call_id: "tu_1", content: "a.txt\nb.txt" },
    ]);
    expect(out.tools).toEqual([
      { type: "function", function: { name: "Bash", description: "shell", parameters: { type: "object" } } },
    ]);
  });

  test("tool-format nudge is NOT injected when no tools are declared", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = translateRequest(req, { stream: false });
    expect(out.messages.find((m) => m.role === "system")).toBeUndefined();
  });

  test("tool-format nudge is appended to existing system prompt when tools are declared", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 50,
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read", input_schema: {} }],
    });
    const out = translateRequest(req, { stream: false });
    const sys = out.messages[0] as { role: "system"; content: string };
    expect(sys.role).toBe("system");
    expect(sys.content.startsWith("be terse")).toBe(true);
    expect(sys.content).toContain("Tool-call format override");
  });

  test("image block becomes data URL image_url part", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: [
        { type: "text", text: "what's this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ]}],
    });
    const out = translateRequest(req, { stream: false });
    expect(out.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what's this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  test("thinking blocks are stripped", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        { role: "assistant", content: [
          { type: "thinking", thinking: "ponder...", signature: "sig" },
          { type: "text", text: "answer" },
        ]},
        { role: "user", content: "ok" },
      ],
    });
    const out = translateRequest(req, { stream: false });
    expect(out.messages[0]).toEqual({ role: "assistant", content: "answer" });
  });

  test("temperature passed through; cache_control fields stripped from messages", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      temperature: 0.3,
      messages: [{ role: "user", content: [
        { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
      ]}],
    });
    const out = translateRequest(req, { stream: false });
    expect(out.temperature).toBe(0.3);
    expect(out.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  test("every translation output passes AiStackRequest schema", () => {
    const fixtures = [
      { model: "x", max_tokens: 1, messages: [{ role: "user", content: "x" }] },
      { model: "x", max_tokens: 1, system: "s", messages: [{ role: "user", content: "x" }] },
      { model: "x", max_tokens: 1, messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "X", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ]},
    ];
    for (const f of fixtures) {
      const req = parseReq(f);
      const out = translateRequest(req, { stream: false });
      expect(AiStackRequest.safeParse(out).success).toBe(true);
    }
  });

  test("strips orchestration tools (Agent, TodoWrite, ExitPlanMode, etc.)", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "x" }],
      tools: [
        { name: "Read", input_schema: {} },
        { name: "Agent", input_schema: {} },
        { name: "TodoWrite", input_schema: {} },
        { name: "Bash", input_schema: {} },
        { name: "ExitPlanMode", input_schema: {} },
      ],
    });
    const out = translateRequest(req, { stream: false });
    const names = (out.tools ?? []).map((t) => t.function.name).sort();
    expect(names).toEqual(["Bash", "Read"]);
  });

  test("validate:false skips schema check (fast path)", () => {
    const req = parseReq({
      model: "x", max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    });
    expect(() => translateRequest(req, { stream: false, validate: false })).not.toThrow();
  });
});
