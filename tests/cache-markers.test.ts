import { describe, expect, test, mock } from "bun:test";

mock.module("../src/oauth.ts", () => ({
  getAccessToken: async () => "stub",
  forceRefresh: async () => "stub2",
}));

import { forwardOAuth } from "../src/anthropic.ts";

async function captureFetch(body: Parameters<typeof forwardOAuth>[0]) {
  const orig = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await forwardOAuth(body); return captured!; }
  finally { globalThis.fetch = orig; }
}

describe("prompt caching markers on OAuth path", () => {
  test("last system block gets cache_control: ephemeral", async () => {
    const cap = await captureFetch({
      model: "claude-opus-4-7",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      system: [
        { type: "text", text: "block A" },
        { type: "text", text: "block B" },
      ],
    });
    const sent = JSON.parse(String(cap.init.body));
    expect(sent.system[0]).toEqual({ type: "text", text: expect.any(String) });
    expect(sent.system[0].cache_control).toBeUndefined();
    // Forky's injected "You are Claude Code..." block is prepended, so original
    // [A, B] becomes [injected, A, B]; cache_control lands on B.
    expect(sent.system[sent.system.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  test("last tool gets cache_control: ephemeral", async () => {
    const cap = await captureFetch({
      model: "claude-opus-4-7",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "Read", input_schema: {} },
        { name: "Bash", input_schema: {} },
      ] as any,
    });
    const sent = JSON.parse(String(cap.init.body));
    expect(sent.tools[0].cache_control).toBeUndefined();
    expect(sent.tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  test("does not clobber existing cache_control", async () => {
    const cap = await captureFetch({
      model: "claude-opus-4-7",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      system: [
        { type: "text", text: "block A", cache_control: { type: "ephemeral", ttl: "1h" } } as any,
      ],
    });
    const sent = JSON.parse(String(cap.init.body));
    const last = sent.system[sent.system.length - 1];
    expect(last.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("system as plain string is converted to array (existing injection behavior preserved)", async () => {
    const cap = await captureFetch({
      model: "claude-opus-4-7",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      system: "just a string",
    });
    const sent = JSON.parse(String(cap.init.body));
    expect(Array.isArray(sent.system)).toBe(true);
    // Last block gets the cache marker.
    expect(sent.system[sent.system.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });
});
