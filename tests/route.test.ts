import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { pickProvider } from "../src/route.ts";
import { existsSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SENTINEL = join(homedir(), ".forky", "opus");
const STASH = `${SENTINEL}.test-stash`;

describe("pickProvider", () => {
  // pickProvider consults the sentinel file. Move any real one aside so we
  // test the default routing in isolation, then restore on teardown.
  beforeEach(() => {
    if (existsSync(SENTINEL)) renameSync(SENTINEL, STASH);
  });
  afterEach(() => {
    if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
    if (existsSync(STASH)) renameSync(STASH, SENTINEL);
  });

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
