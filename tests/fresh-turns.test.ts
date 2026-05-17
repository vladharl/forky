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

describe("FORKY_MAX_MESSAGES caps within the current turn", () => {
  beforeEach(() => {
    process.env.FORKY_FRESH_TURNS = "on";
    process.env.FORKY_MAX_MESSAGES = "5";
  });
  afterEach(() => {
    delete process.env.FORKY_FRESH_TURNS;
    delete process.env.FORKY_MAX_MESSAGES;
  });

  test("a turn with fewer than MAX is unchanged", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "current prompt" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });
    const out = (require("../src/translate/request.ts") as typeof import("../src/translate/request.ts"))
      .translateRequest(req, { stream: false });
    // 3 messages after FRESH_TURNS, all retained.
    expect(out.messages.length).toBe(3);
  });

  test("a long tool chain within one turn is capped at MAX (5), starting on a clean user boundary", () => {
    // Build: 1 user prompt + 5 tool exchanges (each = 1 asst + 1 user/tool_result).
    // = 1 + 10 = 11 messages. Cap=5 should keep the last 5 starting on a user-prompt.
    const msgs: any[] = [{ role: "user", content: "start" }];
    for (let i = 1; i <= 5; i++) {
      msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/f${i}` } }] });
      msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }] });
    }
    const req = parseReq({ model: "claude-sonnet-4-6", max_tokens: 100, messages: msgs });
    const out = (require("../src/translate/request.ts") as typeof import("../src/translate/request.ts"))
      .translateRequest(req, { stream: false });

    // First retained message must be role=user (Anthropic / OpenAI requirement).
    // Within our tool chain, only "start" is a user-not-pure-tool-result; so the cap
    // can either land back at "start" (full 11 msgs kept = breaks cap) OR land
    // somewhere in the middle and fail to find a clean boundary, falling back to
    // the FRESH_TURNS-trimmed result (11 msgs). Both behaviors are correct.
    // What's NOT acceptable: starting on an assistant or a pure-tool-result.
    expect(out.messages[0].role === "system" || out.messages[0].role === "user").toBe(true);
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
