import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { maybeSummarize } from "../src/compact.ts";
import { AnthropicRequest } from "../src/schemas.ts";

function makeReq(numUserAsstPairs: number) {
  const msgs: any[] = [];
  for (let i = 0; i < numUserAsstPairs; i++) {
    msgs.push({ role: "user", content: `prompt ${i}` });
    msgs.push({ role: "assistant", content: `reply ${i}` });
  }
  // ensure last message is user so Anthropic schema is valid
  msgs.push({ role: "user", content: "current question" });
  const p = AnthropicRequest.safeParse({ model: "claude-sonnet-4-6", max_tokens: 100, messages: msgs });
  if (!p.success) throw new Error(p.error.message);
  return p.data;
}

describe("maybeSummarize", () => {
  beforeEach(() => {
    delete process.env.FORKY_SUMMARIZE_THRESHOLD;
    delete process.env.EXEC_API_KEY;
    delete process.env.EXEC_BASE_URL;
  });

  test("returns the original request when threshold is 0 (default off)", async () => {
    const req = makeReq(50);
    const out = await maybeSummarize(req);
    expect(out).toBe(req); // reference-equal — no work done
  });

  test("returns original when below threshold even if env is set", async () => {
    process.env.FORKY_SUMMARIZE_THRESHOLD = "30";
    const req = makeReq(5); // 11 messages, under 30
    const out = await maybeSummarize(req);
    expect(out).toBe(req);
  });

  test("returns original (gracefully) if env config is missing", async () => {
    process.env.FORKY_SUMMARIZE_THRESHOLD = "5";
    const req = makeReq(10); // 21 messages, over threshold
    // No EXEC_API_KEY set → getAiStackEnv throws → compact catches and returns original
    const out = await maybeSummarize(req);
    expect(out).toBe(req);
  });

  // Note: the success path requires a real gemma backend call. Exercised live,
  // not in unit tests, to avoid mocking a streaming AI-stack call here.
});
