import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { decideRoute } from "../src/route.ts";
import { existsSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SENTINEL = join(homedir(), ".forky", "opus");
const STASH = `${SENTINEL}.classifier-test-stash`;

describe("classifier-shaped request routing", () => {
  beforeEach(() => {
    if (existsSync(SENTINEL)) renameSync(SENTINEL, STASH);
  });
  afterEach(() => {
    if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
    if (existsSync(STASH)) renameSync(STASH, SENTINEL);
  });

  test("claude-sonnet-4-6 with NO tools → OAuth (classifier)", () => {
    const d = decideRoute("claude-sonnet-4-6", { tools: [] });
    expect(d.provider).toBe("anthropic-oauth");
    expect(d.reason).toBe("classifier");
    expect(d.rewriteModel).toBe("claude-sonnet-4-6");
  });

  test("claude-sonnet-4-6 with tools missing entirely → OAuth (classifier)", () => {
    const d = decideRoute("claude-sonnet-4-6", {});
    expect(d.provider).toBe("anthropic-oauth");
    expect(d.reason).toBe("classifier");
  });

  test("claude-sonnet-4-6 with tools → aistack (main agent, unchanged)", () => {
    const d = decideRoute("claude-sonnet-4-6", { tools: [{ name: "Read" }, { name: "Bash" }] });
    expect(d.provider).toBe("aistack");
    expect(d.reason).toBe("execution");
    expect(d.rewriteModel).toBeUndefined();
  });

  test("non-Claude model with no tools still goes to aistack", () => {
    const d = decideRoute("qwen-35b", { tools: [] });
    expect(d.provider).toBe("aistack");
    expect(d.reason).toBe("execution");
  });

  test("claude-opus-* with no tools → OAuth via opus rule (not classifier)", () => {
    const d = decideRoute("claude-opus-4-7", { tools: [] });
    expect(d.provider).toBe("anthropic-oauth");
    expect(d.reason).toBe("opus");
  });
});
