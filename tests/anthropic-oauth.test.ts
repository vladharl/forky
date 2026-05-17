import { describe, expect, test, mock } from "bun:test";

mock.module("../src/oauth.ts", () => ({
  getAccessToken: async () => "stub-token",
  forceRefresh: async () => "stub-token-refreshed",
}));

import { injectSystemBlock } from "../src/anthropic.ts";

describe("injectSystemBlock", () => {
  test("inserts required block when system absent", () => {
    const out = injectSystemBlock({ messages: [] });
    expect(out.system).toEqual([{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }]);
  });

  test("converts string system into array with required block first", () => {
    const out = injectSystemBlock({ messages: [], system: "be terse" });
    expect(out.system).toEqual([
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "be terse" },
    ]);
  });

  test("preserves existing system array when first block already starts with 'You are Claude Code'", () => {
    const existing = [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "<task>...</task>" },
    ];
    const out = injectSystemBlock({ messages: [], system: existing });
    expect(out.system).toEqual(existing);
  });

  test("prepends required block when first text does not start with 'You are Claude Code'", () => {
    const out = injectSystemBlock({
      messages: [],
      system: [{ type: "text", text: "custom prompt" }],
    });
    const arr = out.system as Array<{ type: string; text?: string }>;
    expect(arr[0].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(arr[1].text).toBe("custom prompt");
  });

  test("does not mutate the input body", () => {
    const body = { messages: [], system: "x" };
    injectSystemBlock(body);
    expect(body.system).toBe("x");
  });
});

import { forwardOAuthAsFallback } from "../src/anthropic.ts";
import type {} from "bun:test";

describe("forwardOAuthAsFallback model rewrite", () => {
  async function captureFetchOf(body: Parameters<typeof forwardOAuthAsFallback>[0]) {
    const orig = globalThis.fetch;
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), init };
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try { await forwardOAuthAsFallback(body); return captured!; }
    finally { globalThis.fetch = orig; }
  }

  test("rewrites qwen-35b to claude-sonnet-4-6 before forwarding", async () => {
    const cap = await captureFetchOf({ model: "qwen-35b", messages: [{ role: "user", content: "x" }], max_tokens: 1 });
    const sentBody = JSON.parse(String(cap.init.body));
    expect(sentBody.model).toBe("claude-sonnet-4-6");
    const headers = cap.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer stub-token");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect("x-api-key" in headers).toBe(false);
  });

  test("preserves model when already starts with claude-", async () => {
    const cap = await captureFetchOf({ model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "x" }], max_tokens: 1 });
    expect(JSON.parse(String(cap.init.body)).model).toBe("claude-haiku-4-5-20251001");
  });

  test("system block 'You are Claude Code' is always first", async () => {
    const cap = await captureFetchOf({
      model: "qwen-35b",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 1,
      system: "be terse",
    });
    const sys = JSON.parse(String(cap.init.body)).system;
    expect(sys[0].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(sys[1].text).toBe("be terse");
  });
});
