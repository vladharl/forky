import { OpenAiSseChunk, AiStackPortalFrame } from "../schemas.ts";

// ───────── SSE wire-format helpers ─────────

export function sseEvent(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Parse an SSE byte stream into a sequence of frames. Each yielded value is
 * either a parsed JSON object, the literal string "[DONE]", or null for
 * frames that didn't parse (caller decides how strict to be).
 */
export async function* readSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<unknown | "[DONE]"> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const parsed = parseFrame(frame);
        if (parsed === undefined) continue;
        yield parsed;
        if (parsed === "[DONE]") return;
      }
    }
    // Flush trailing partial.
    if (buf.length > 0) {
      const parsed = parseFrame(buf);
      if (parsed !== undefined) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): unknown | "[DONE]" | undefined {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return "[DONE]";
  try { return JSON.parse(data); } catch { return undefined; }
}

// ───────── State machine: OpenAI delta stream → Anthropic event stream ─────────

type AnthropicStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";

type BlockState =
  | { kind: "none" }
  | { kind: "text"; anthIdx: number }
  | { kind: "tool"; anthIdx: number; openAiIdx: number; id: string; name: string };

export type FinishOpts = {
  /** Override the stop reason. Defaults to whatever finish_reason was last seen, or "end_turn". */
  reason?: AnthropicStopReason;
  /** Append a final text fragment before closing (used by the watchdog to explain a stall). */
  appendText?: string;
  /** If set, emit an Anthropic error event in place of normal termination. */
  errorMessage?: string;
};

export class SseTranslator {
  private started = false;
  private block: BlockState = { kind: "none" };
  private nextAnthIdx = 0;
  private finishedReason: AnthropicStopReason | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private finished = false;
  readonly messageId: string;

  constructor(private readonly model: string, messageId?: string) {
    this.messageId = messageId ?? `msg_mux_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Process one upstream OpenAI SSE frame. Returns Anthropic SSE bytes to write (may be ""). */
  push(rawFrame: unknown): string {
    if (this.finished) return "";

    // Drop AI Stack portal frames (chat.queue / chat.compaction / etc.).
    if (AiStackPortalFrame.safeParse(rawFrame).success) return "";

    const parsed = OpenAiSseChunk.safeParse(rawFrame);
    if (!parsed.success) return ""; // malformed: drop silently
    const chunk = parsed.data;

    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens;
      this.outputTokens = chunk.usage.completion_tokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return "";
    const delta = choice.delta;

    let out = "";
    if (!this.started) {
      out += this.emitMessageStart();
      this.started = true;
    }

    // Drop reasoning_content silently (qwen-35b's thinking tokens).

    if (typeof delta.content === "string" && delta.content.length > 0) {
      out += this.handleText(delta.content);
    }

    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        out += this.handleToolDelta(tc);
      }
    }

    if (choice.finish_reason) {
      this.finishedReason = mapFinishReason(choice.finish_reason);
    }

    return out;
  }

  /** Emit terminal events. Safe to call multiple times — only emits once. */
  finish(opts: FinishOpts = {}): string {
    if (this.finished) return "";
    this.finished = true;

    let out = "";
    if (!this.started) {
      out += this.emitMessageStart();
      this.started = true;
    }
    if (opts.appendText) {
      out += this.handleText(opts.appendText);
    }
    out += this.closeCurrentBlock();

    if (opts.errorMessage) {
      out += sseEvent("error", {
        type: "error",
        error: { type: "api_error", message: opts.errorMessage },
      });
      return out;
    }
    const stopReason = opts.reason ?? this.finishedReason ?? "end_turn";
    out += sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    out += sseEvent("message_stop", { type: "message_stop" });
    return out;
  }

  get hasFinished(): boolean { return this.finished; }
  get hasStarted(): boolean { return this.started; }

  // ───────── internals ─────────

  private emitMessageStart(): string {
    return sseEvent("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  private handleText(text: string): string {
    let out = "";
    if (this.block.kind === "tool") {
      out += this.closeCurrentBlock();
    }
    if (this.block.kind === "none") {
      const idx = this.nextAnthIdx++;
      this.block = { kind: "text", anthIdx: idx };
      out += sseEvent("content_block_start", {
        type: "content_block_start",
        index: idx,
        content_block: { type: "text", text: "" },
      });
    }
    out += sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: (this.block as Extract<BlockState, { kind: "text" }>).anthIdx,
      delta: { type: "text_delta", text },
    });
    return out;
  }

  private handleToolDelta(tc: {
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }): string {
    let out = "";
    const isSameOpenAiTool = this.block.kind === "tool" && this.block.openAiIdx === tc.index;

    if (isSameOpenAiTool) {
      const args = tc.function?.arguments;
      if (args && args.length > 0) {
        out += sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: (this.block as Extract<BlockState, { kind: "tool" }>).anthIdx,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
      return out;
    }

    // Different (or first) tool — close any current block.
    out += this.closeCurrentBlock();

    // We need id + name to legally open an Anthropic tool_use block.
    const id = tc.id ?? `toolu_mux_${this.nextAnthIdx}`;
    const name = tc.function?.name;
    if (!name) {
      // Orphan args fragment without ever having received id/name. Drop.
      return out;
    }
    const anthIdx = this.nextAnthIdx++;
    this.block = { kind: "tool", anthIdx, openAiIdx: tc.index, id, name };
    out += sseEvent("content_block_start", {
      type: "content_block_start",
      index: anthIdx,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    const args = tc.function?.arguments;
    if (args && args.length > 0) {
      out += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: anthIdx,
        delta: { type: "input_json_delta", partial_json: args },
      });
    }
    return out;
  }

  private closeCurrentBlock(): string {
    if (this.block.kind === "none") return "";
    const idx = this.block.anthIdx;
    this.block = { kind: "none" };
    return sseEvent("content_block_stop", { type: "content_block_stop", index: idx });
  }
}

function mapFinishReason(
  fr: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicStopReason {
  switch (fr) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    case "content_filter": return "end_turn";
    case null: return "end_turn";
  }
}
