import { describe, expect, test } from "bun:test";
import { pickProvider } from "../src/route.ts";

describe("pickProvider", () => {
  test("claude-opus-* → anthropic-oauth", () => {
    expect(pickProvider("claude-opus-4-7")).toBe("anthropic-oauth");
    expect(pickProvider("claude-opus-4-6")).toBe("anthropic-oauth");
    expect(pickProvider("claude-opus-4-7-20251015")).toBe("anthropic-oauth");
  });

  test("claude-sonnet-* and claude-haiku-* → aistack (execution)", () => {
    expect(pickProvider("claude-sonnet-4-6")).toBe("aistack");
    expect(pickProvider("claude-haiku-4-5-20251001")).toBe("aistack");
  });

  test("non-Claude models → aistack", () => {
    expect(pickProvider("qwen-35b")).toBe("aistack");
    expect(pickProvider("gpt-5")).toBe("aistack");
    expect(pickProvider("")).toBe("aistack");
  });
});
