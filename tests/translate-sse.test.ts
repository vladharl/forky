import { describe, expect, test } from "bun:test";
import { SseTranslator, readSseStream, sseEvent } from "../src/translate/sse.ts";

function feed(translator: SseTranslator, chunks: unknown[]): string {
  return chunks.map((c) => translator.push(c)).join("");
}

function events(wire: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  for (const frame of wire.split("\n\n")) {
    if (!frame.trim()) continue;
    let evt = "", dataStr = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) evt = line.slice(7);
      else if (line.startsWith("data: ")) dataStr = line.slice(6);
    }
    out.push({ event: evt, data: JSON.parse(dataStr) });
  }
  return out;
}

describe("SseTranslator", () => {
  test("pure text stream emits start → block_start → deltas → block_stop → message_delta → message_stop", () => {
    const t = new SseTranslator("claude-sonnet-4-6", "msg_x");
    const wire = feed(t, [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) + t.finish();

    const evs = events(wire);
    const types = evs.map((e) => e.event);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect((evs[2].data as any).delta.text).toBe("Hello");
    expect((evs[3].data as any).delta.text).toBe(" world");
    expect((evs[5].data as any).delta.stop_reason).toBe("end_turn");
  });

  test("tool_call streaming accumulates partial JSON via input_json_delta", () => {
    const t = new SseTranslator("claude-sonnet-4-6");
    const wire = feed(t, [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: "" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"command\":" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"ls\"}" } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]) + t.finish();

    const evs = events(wire);
    expect(evs.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect((evs[1].data as any).content_block).toEqual({ type: "tool_use", id: "call_1", name: "Bash", input: {} });
    expect((evs[2].data as any).delta).toEqual({ type: "input_json_delta", partial_json: "{\"command\":" });
    expect((evs[3].data as any).delta).toEqual({ type: "input_json_delta", partial_json: "\"ls\"}" });
    expect((evs[5].data as any).delta.stop_reason).toBe("tool_use");
  });

  test("text followed by tool emits proper block transitions", () => {
    const t = new SseTranslator("claude-sonnet-4-6");
    const wire = feed(t, [
      { choices: [{ index: 0, delta: { content: "Running:" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]) + t.finish();

    const types = events(wire).map((e) => e.event);
    expect(types).toEqual([
      "message_start",
      "content_block_start",   // text block opens
      "content_block_delta",   // "Running:"
      "content_block_stop",    // text block closes
      "content_block_start",   // tool block opens
      "content_block_delta",   // arguments "{}"
      "content_block_stop",    // tool block closes
      "message_delta",
      "message_stop",
    ]);
  });

  test("reasoning_content is dropped", () => {
    const t = new SseTranslator("claude-sonnet-4-6");
    const wire = feed(t, [
      { choices: [{ index: 0, delta: { reasoning_content: "ponder..." } }] },
      { choices: [{ index: 0, delta: { reasoning_content: " more..." } }] },
      { choices: [{ index: 0, delta: { content: "answer" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) + t.finish();

    const evs = events(wire);
    expect(evs.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect((evs[2].data as any).delta.text).toBe("answer");
  });

  test("portal frames (chat.queue, chat.compaction) are dropped", () => {
    const t = new SseTranslator("claude-sonnet-4-6");
    const wire = feed(t, [
      { object: "chat.queue", position: 2 },
      { choices: [{ index: 0, delta: { content: "ok" } }] },
      { object: "chat.compaction", applied: true, summarized_message_count: 3 },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) + t.finish();

    const types = events(wire).map((e) => e.event);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("finish_reason=length maps to stop_reason=max_tokens", () => {
    const t = new SseTranslator("x");
    const wire = feed(t, [
      { choices: [{ index: 0, delta: { content: "x" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    ]) + t.finish();
    const evs = events(wire);
    const md = evs.find((e) => e.event === "message_delta")!;
    expect((md.data as any).delta.stop_reason).toBe("max_tokens");
  });

  test("finish() on empty stream still emits valid terminal sequence", () => {
    const t = new SseTranslator("x");
    const wire = t.finish();
    const types = events(wire).map((e) => e.event);
    expect(types).toEqual(["message_start", "message_delta", "message_stop"]);
  });

  test("finish() with appendText emits the synthetic text before terminating", () => {
    const t = new SseTranslator("x");
    const wire =
      feed(t, [{ choices: [{ index: 0, delta: { content: "partial" } }] }])
      + t.finish({ appendText: "\n[mux: stalled]" });
    const evs = events(wire);
    const deltas = evs.filter((e) => e.event === "content_block_delta");
    expect(deltas.map((e) => (e.data as any).delta.text)).toEqual(["partial", "\n[mux: stalled]"]);
  });

  test("finish() with errorMessage emits an Anthropic error event", () => {
    const t = new SseTranslator("x");
    const wire = t.finish({ errorMessage: "upstream timeout" });
    const evs = events(wire);
    expect(evs.find((e) => e.event === "error")).toBeDefined();
  });

  test("double finish() is idempotent", () => {
    const t = new SseTranslator("x");
    const a = t.finish();
    const b = t.finish();
    expect(a.length).toBeGreaterThan(0);
    expect(b).toBe("");
  });

  test("parallel tool calls (two indexes) emit two distinct tool_use blocks", () => {
    const t = new SseTranslator("x");
    const wire = feed(t, [
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "c1", type: "function", function: { name: "A", arguments: "{}" } },
        { index: 1, id: "c2", type: "function", function: { name: "B", arguments: "{}" } },
      ]}}] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]) + t.finish();

    const evs = events(wire);
    const starts = evs.filter((e) => e.event === "content_block_start");
    expect(starts).toHaveLength(2);
    expect((starts[0].data as any).content_block.id).toBe("c1");
    expect((starts[1].data as any).content_block.id).toBe("c2");
  });
});

describe("readSseStream", () => {
  test("parses multi-frame stream and stops on [DONE]", async () => {
    const bytes = new TextEncoder().encode(
      `data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\ndata: {"never":true}\n\n`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes); c.close(); },
    });
    const out: unknown[] = [];
    for await (const f of readSseStream(stream)) out.push(f);
    expect(out).toEqual([{ a: 1 }, { b: 2 }, "[DONE]"]);
  });

  test("handles chunk boundaries inside a frame", async () => {
    const enc = new TextEncoder();
    const parts = [`data: {"a":`, `1}\n\ndata: {"b":2}\n`, `\ndata: [DONE]\n\n`];
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); },
    });
    const out: unknown[] = [];
    for await (const f of readSseStream(stream)) out.push(f);
    expect(out).toEqual([{ a: 1 }, { b: 2 }, "[DONE]"]);
  });
});

describe("sseEvent wire format", () => {
  test("produces event:/data:/\\n\\n triple", () => {
    expect(sseEvent("foo", { x: 1 })).toBe(`event: foo\ndata: {"x":1}\n\n`);
  });
});
