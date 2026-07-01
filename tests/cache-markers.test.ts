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

  test("downgrades later 1h system marker after a 5m system marker", async () => {
    const cap = await captureFetch({
      model: "claude-opus-4-7",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      system: [
        { type: "text", text: "block A", cache_control: { type: "ephemeral" } } as any,
        { type: "text", text: "block B", cache_control: { type: "ephemeral", ttl: "1h" } } as any,
      ],
    });
    const sent = JSON.parse(String(cap.init.body));
    expect(sent.system.at(-2).cache_control).toEqual({ type: "ephemeral" });
    expect(sent.system.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  test("downgrades system 1h marker after an added 5m tool marker", async () => {
    const cap = await captureFetch({
      model: "claude-opus-4-7",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read", input_schema: {} }] as any,
      system: [
        { type: "text", text: "block A", cache_control: { type: "ephemeral", ttl: "1h" } } as any,
      ],
    });
    const sent = JSON.parse(String(cap.init.body));
    expect(sent.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(sent.system.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
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

describe("cache-busting cch nonce normalization", () => {
  const sysWith = (cch: string) => [
    { type: "text", text: `x-anthropic-billing-header: cc_version=2.1.143.7a0; cc_entrypoint=claude-vscode; cch=${cch};\n\nYou are Claude Code, the full prompt.` },
  ];

  test("rotating cch values produce a byte-identical system prefix", async () => {
    const a = await captureFetch({ model: "claude-opus-4-7", max_tokens: 10, messages: [{ role: "user", content: "hi" }], system: sysWith("32033") as any });
    const b = await captureFetch({ model: "claude-opus-4-7", max_tokens: 10, messages: [{ role: "user", content: "hi" }], system: sysWith("da3ac") as any });
    const sysA = JSON.parse(String(a.init.body)).system;
    const sysB = JSON.parse(String(b.init.body)).system;
    expect(JSON.stringify(sysA)).toEqual(JSON.stringify(sysB));
    // Nonce normalized to the constant, rest of the line intact.
    const billing = sysA.find((blk: any) => typeof blk.text === "string" && blk.text.includes("cch="));
    expect(billing.text).toContain("cch=forky;");
    expect(billing.text).toContain("cc_version=2.1.143.7a0");
    expect(billing.text).not.toMatch(/cch=[0-9a-f]{4,};/);
  });

  test("respects FORKY_NORMALIZE_CCH=off", async () => {
    process.env.FORKY_NORMALIZE_CCH = "off";
    try {
      const cap = await captureFetch({ model: "claude-opus-4-7", max_tokens: 10, messages: [{ role: "user", content: "hi" }], system: sysWith("abc12") as any });
      const sys = JSON.parse(String(cap.init.body)).system;
      const billing = sys.find((blk: any) => typeof blk.text === "string" && blk.text.includes("cch="));
      expect(billing.text).toContain("cch=abc12;");
    } finally {
      delete process.env.FORKY_NORMALIZE_CCH;
    }
  });
});
