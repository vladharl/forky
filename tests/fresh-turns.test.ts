import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { translateRequest } from "../src/translate/request.ts";
import { AnthropicRequest } from "../src/schemas.ts";

function parseReq(raw: unknown) {
  const p = AnthropicRequest.safeParse(raw);
  if (!p.success) throw new Error(`fixture invalid: ${p.error.message}`);
  return p.data;
}

describe("FORKY_FRESH_TURNS=on trims to latest user prompt", () => {
  beforeEach(() => { process.env.FORKY_FRESH_TURNS = "on"; });
  afterEach(() => { delete process.env.FORKY_FRESH_TURNS; });

  test("multi-turn session keeps only the last user prompt and onward", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "old question 1" },
        { role: "assistant", content: "old answer 1" },
        { role: "user", content: "old question 2" },
        { role: "assistant", content: "old answer 2" },
        { role: "user", content: "NEW question" },
      ],
    });
    const out = translateRequest(req, { stream: false });
    // After system message (none in this fixture), only the new prompt should remain.
    expect(out.messages).toEqual([{ role: "user", content: "NEW question" }]);
  });

  test("preserves a tool_use/tool_result chain that belongs to the current prompt", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: "done" },
        { role: "user", content: "current prompt: read /tmp/x" },
        { role: "assistant", content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x" } },
        ]},
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "t1", content: "file contents" },
        ]},
      ],
    });
    const out = translateRequest(req, { stream: false });
    // Should keep: current prompt + assistant tool_use + tool result message
    const roles = out.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);
    expect((out.messages[0] as { content: string }).content).toBe("current prompt: read /tmp/x");
  });

  test("a session with just one user message is unchanged", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = translateRequest(req, { stream: false });
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("FORKY_FRESH_TURNS unset → preserves full history (default)", () => {
  beforeEach(() => { delete process.env.FORKY_FRESH_TURNS; });

  test("full multi-turn history is forwarded as-is", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
    });
    const out = translateRequest(req, { stream: false });
    expect(out.messages.length).toBe(3);
  });
});
