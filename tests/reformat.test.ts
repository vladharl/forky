import { describe, expect, test } from "bun:test";
import { looksLikeXmlToolCall } from "../src/translate/reformat.ts";

describe("looksLikeXmlToolCall", () => {
  test("detects long-form <function_calls>", () => {
    expect(looksLikeXmlToolCall("hello\n<function_calls>\n<invoke name=\"X\">", ["X"])).toBe(true);
  });

  test("detects <invoke name= even without function_calls wrapper", () => {
    expect(looksLikeXmlToolCall("<invoke name=\"Read\">", ["Read"])).toBe(true);
  });

  test("detects short-form <ToolName ...> when name is in the declared tools", () => {
    expect(looksLikeXmlToolCall("Let me <Read path=\"/tmp/x\"> the file", ["Read", "Bash"])).toBe(true);
  });

  test("does not flag XML for tool names that aren't declared", () => {
    expect(looksLikeXmlToolCall("<Mystery something>", ["Read", "Bash"])).toBe(false);
  });

  test("does not flag plain text or <div>-style HTML", () => {
    expect(looksLikeXmlToolCall("here is some <div> content", ["Read"])).toBe(false);
    expect(looksLikeXmlToolCall("just plain text", ["Read"])).toBe(false);
    expect(looksLikeXmlToolCall("", ["Read"])).toBe(false);
  });

  test("handles tool names with regex-special characters safely", () => {
    expect(looksLikeXmlToolCall("<Edit.thing x>", ["Edit.thing"])).toBe(true);
    expect(looksLikeXmlToolCall("<Edit.thing x>", ["Edit"])).toBe(false);
  });
});
