import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { translateRequest } from "../src/translate/request.ts";
import { AnthropicRequest } from "../src/schemas.ts";

function parseReq(raw: unknown) {
  const p = AnthropicRequest.safeParse(raw);
  if (!p.success) throw new Error(`fixture invalid: ${p.error.message}`);
  return p.data;
}

describe("tool_result truncation", () => {
  beforeEach(() => { delete process.env.FORKY_FRESH_TURNS; delete process.env.FORKY_TRUNCATE_TOOL_RESULTS; });
  afterEach(() => { delete process.env.FORKY_FRESH_TURNS; delete process.env.FORKY_TRUNCATE_TOOL_RESULTS; });

  test("older big tool_results get placeholder, last one kept full", () => {
    const big = "x".repeat(2000);
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
        ]},
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
        { role: "assistant", content: "ok now" },
        { role: "assistant", content: [
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ]},
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: big }] },
      ],
    });
    const out = translateRequest(req, { stream: false });
    // role:tool message bodies — first is truncated (older), second is full (latest).
    const toolMsgs = out.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].content).toMatch(/^\[Read\(file_path=\/a\.ts\) → 2000 chars, consumed/);
    expect(toolMsgs[1].content).toBe(big);
  });

  test("small tool_results are NOT truncated (under MIN_BYTES)", () => {
    const small = "ok"; // 2 chars
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "do" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: small }] },
        { role: "assistant", content: "next" },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/y" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: small }] },
      ],
    });
    const out = translateRequest(req, { stream: false });
    const toolMsgs = out.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
    expect(toolMsgs.every((m) => m.content === "ok")).toBe(true);
  });

  test("FORKY_TRUNCATE_TOOL_RESULTS=off disables truncation", () => {
    process.env.FORKY_TRUNCATE_TOOL_RESULTS = "off";
    const big = "x".repeat(2000);
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "do" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
        { role: "assistant", content: "next" },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/b" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: big }] },
      ],
    });
    const out = translateRequest(req, { stream: false });
    const toolMsgs = out.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
    expect(toolMsgs.every((m) => m.content === big)).toBe(true);
  });
});

describe("consumed-image truncation", () => {
  beforeEach(() => { delete process.env.FORKY_FRESH_TURNS; delete process.env.FORKY_TRUNCATE_IMAGES; });
  afterEach(() => { delete process.env.FORKY_FRESH_TURNS; delete process.env.FORKY_TRUNCATE_IMAGES; });

  const bigB64 = "A".repeat(4096);
  const imgBlock = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: bigB64 } };

  function twoImageReq() {
    return parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        { role: "user", content: [{ type: "text", text: "the game crashes" }, imgBlock] },
        { role: "assistant", content: "I see the crash in the screenshot." },
        { role: "user", content: [{ type: "text", text: "here is another" }, imgBlock] },
      ],
    });
  }

  test("older base64 image becomes a placeholder, latest kept intact", () => {
    const out = translateRequest(twoImageReq(), { stream: false });
    const userMsgs = out.messages.filter((m) => m.role === "user") as Array<{ content: any }>;
    // First user msg: image replaced by text placeholder.
    const first = userMsgs[0].content;
    const firstHasImage = Array.isArray(first) && first.some((p: any) => p.type === "image_url");
    expect(firstHasImage).toBe(false);
    expect(JSON.stringify(first)).toContain("omitted");
    // Latest user msg: image survives as image_url.
    const last = userMsgs[userMsgs.length - 1].content;
    const lastHasImage = Array.isArray(last) && last.some((p: any) => p.type === "image_url" && p.image_url.url.includes(bigB64));
    expect(lastHasImage).toBe(true);
  });

  test("single image is never truncated (it's the latest)", () => {
    const req = parseReq({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, imgBlock] }],
    });
    const out = translateRequest(req, { stream: false });
    const u = (out.messages.find((m) => m.role === "user") as { content: any }).content;
    expect(JSON.stringify(u)).toContain(bigB64);
  });

  test("FORKY_TRUNCATE_IMAGES=off keeps all images", () => {
    process.env.FORKY_TRUNCATE_IMAGES = "off";
    const out = translateRequest(twoImageReq(), { stream: false });
    const imageCount = JSON.stringify(out.messages).split(bigB64).length - 1;
    expect(imageCount).toBe(2);
  });
});
