import { AnthropicRequest, AiStackResponse } from "./schemas.ts";
import { translateRequest } from "./translate/request.ts";
import { translateResponse } from "./translate/response.ts";
import { SseTranslator, readSseStream, sseEvent } from "./translate/sse.ts";
import { withWatchdog, WatchdogTimeoutError } from "./resilience/watchdog.ts";
import { looksLikeXmlToolCall, rectifyToolCalls } from "./translate/reformat.ts";
import { log } from "./log.ts";

function getReformatModel(): string | null {
  return process.env.EXEC_REFORMAT_MODEL ?? process.env.AISTACK_REFORMAT_MODEL ?? null;
}

export type AiStackEnv = {
  baseUrl: string;
  apiKey: string;
};

/**
 * Read execution-backend config from env. Prefers EXEC_* names but accepts
 * the legacy AISTACK_* names so existing setups don't break.
 */
export function getAiStackEnv(): AiStackEnv {
  const apiKey = process.env.EXEC_API_KEY ?? process.env.AISTACK_API_KEY;
  const baseUrl = process.env.EXEC_BASE_URL ?? process.env.AISTACK_BASE_URL;
  if (!apiKey) throw new Error("EXEC_API_KEY (or AISTACK_API_KEY) env var not set");
  if (!baseUrl) throw new Error("EXEC_BASE_URL (or AISTACK_BASE_URL) env var not set — point this at your OpenAI-compatible /v1 endpoint");
  return { baseUrl, apiKey };
}

/**
 * Dispatch a request to AI Stack in non-streaming mode and return an
 * Anthropic Messages API response. Phase 3 will add a streaming variant.
 */
export async function dispatchAiStackNonStreaming(
  req: AnthropicRequest,
  env: AiStackEnv,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const translated = translateRequest(req, { stream: false });

  let upstream: Response;
  try {
    upstream = await fetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.apiKey}`,
        "accept": "application/json",
      },
      body: JSON.stringify(translated),
      signal,
    });
  } catch (e) {
    log("error", "aistack.fetch_failed", { err: (e as Error).message });
    return {
      status: 502,
      body: {
        type: "error",
        error: { type: "api_error", message: `AI Stack fetch failed: ${(e as Error).message}` },
      },
    };
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    log("error", "aistack.upstream_error", { status: upstream.status, body: text.slice(0, 500) });
    return {
      status: upstream.status,
      body: {
        type: "error",
        error: {
          type: upstream.status === 429 ? "rate_limit_error" : "api_error",
          message: `AI Stack returned ${upstream.status}: ${text.slice(0, 200)}`,
        },
      },
    };
  }

  const raw = await upstream.json();
  const parsed = AiStackResponse.safeParse(raw);
  if (!parsed.success) {
    log("error", "aistack.response_schema_mismatch", { errs: parsed.error.issues.slice(0, 3) });
    return {
      status: 502,
      body: {
        type: "error",
        error: { type: "api_error", message: `AI Stack response failed schema: ${parsed.error.message}` },
      },
    };
  }

  return { status: 200, body: translateResponse(parsed.data, req.model) };
}

export type StreamingResult =
  | { status: 200; stream: ReadableStream<Uint8Array>; outcome: Promise<"ok" | "stream_error"> }
  | { status: number; errorBody: unknown };

export type WatchdogConfig = {
  firstByteMs: number;
  interChunkMs: number;
};

/**
 * Dispatch to AI Stack in streaming mode and return a ReadableStream of
 * Anthropic-formatted SSE bytes. Guarantees a terminal message_stop event
 * on every exit path (upstream error, network abort, malformed stream,
 * watchdog timeout). The `outcome` promise resolves to "ok" on clean
 * completion or "stream_error" if anything went wrong mid-stream — the
 * caller uses this to update the circuit breaker.
 */
export async function dispatchAiStackStreaming(
  req: AnthropicRequest,
  env: AiStackEnv,
  watchdog: WatchdogConfig,
  externalSignal?: AbortSignal,
): Promise<StreamingResult> {
  // When a reformatter is configured, prefer the buffered-then-rectify path so
  // tool-call XML emitted by the primary model can be converted to proper
  // tool_calls before reaching Claude Code. This sacrifices token-level streaming
  // (qwen finishes, then forky emits) for end-to-end tool execution.
  const reformatModel = getReformatModel();
  if (reformatModel) {
    return dispatchWithRectifier(req, env, reformatModel, externalSignal);
  }

  const translated = translateRequest(req, { stream: true });
  const abort = new AbortController();
  if (externalSignal) externalSignal.addEventListener("abort", () => abort.abort(externalSignal.reason));

  const firstByteTimer = setTimeout(() => abort.abort(new WatchdogTimeoutError("first-byte", watchdog.firstByteMs)), watchdog.firstByteMs);

  let upstream: Response;
  try {
    upstream = await fetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.apiKey}`,
        "accept": "text/event-stream",
      },
      body: JSON.stringify(translated),
      signal: abort.signal,
    });
  } catch (e) {
    clearTimeout(firstByteTimer);
    log("error", "aistack.fetch_failed", { err: (e as Error).message });
    return {
      status: 502,
      errorBody: { type: "error", error: { type: "api_error", message: `AI Stack fetch failed: ${(e as Error).message}` } },
    };
  }

  if (!upstream.ok) {
    clearTimeout(firstByteTimer);
    const text = await upstream.text().catch(() => "");
    log("error", "aistack.upstream_error", { status: upstream.status, body: text.slice(0, 500) });
    return {
      status: upstream.status,
      errorBody: {
        type: "error",
        error: {
          type: upstream.status === 429 ? "rate_limit_error" : "api_error",
          message: `AI Stack returned ${upstream.status}: ${text.slice(0, 200)}`,
        },
      },
    };
  }

  if (!upstream.body) {
    clearTimeout(firstByteTimer);
    return {
      status: 502,
      errorBody: { type: "error", error: { type: "api_error", message: "AI Stack returned no body" } },
    };
  }

  // Headers received; restart the watchdog on the body itself (inter-chunk + first-data-byte).
  clearTimeout(firstByteTimer);
  const guardedBody = withWatchdog(upstream.body, {
    firstByteMs: watchdog.firstByteMs,
    interChunkMs: watchdog.interChunkMs,
    abort,
  });

  const translator = new SseTranslator(req.model);

  let resolveOutcome!: (v: "ok" | "stream_error") => void;
  const outcome = new Promise<"ok" | "stream_error">((res) => { resolveOutcome = res; });

  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (s: string) => { if (s.length > 0) controller.enqueue(enc.encode(s)); };
      let errored = false;
      try {
        for await (const frame of readSseStream(guardedBody)) {
          if (frame === "[DONE]") break;
          send(translator.push(frame));
        }
        send(translator.finish());
      } catch (e) {
        errored = true;
        const isTimeout = e instanceof WatchdogTimeoutError;
        const kind = isTimeout ? (e as WatchdogTimeoutError).kind : "stream";
        log("error", "aistack.stream_error", { err: (e as Error).message, kind });
        const note = isTimeout
          ? `\n\n[forky: ${kind} timeout — ending turn]`
          : `\n\n[forky: upstream stream error]`;
        // Don't emit an Anthropic `error` event — that surfaces as a hard failure in Claude Code.
        // Instead append a text note and end cleanly so Claude Code can continue.
        send(translator.finish({ appendText: note }));
      } finally {
        if (!translator.hasFinished) send(translator.finish());
        controller.close();
        resolveOutcome(errored ? "stream_error" : "ok");
      }
    },
    cancel(reason) {
      try { abort.abort(reason); } catch {}
    },
  });

  return { status: 200, stream: out, outcome };
}

// ─── Rectifier path: primary model (qwen) → optional reformatter (gemma) → Anthropic SSE ───

async function dispatchWithRectifier(
  req: AnthropicRequest,
  env: AiStackEnv,
  reformatModel: string,
  externalSignal?: AbortSignal,
): Promise<StreamingResult> {
  const translated = translateRequest(req, { stream: false });
  const abort = new AbortController();
  if (externalSignal) externalSignal.addEventListener("abort", () => abort.abort(externalSignal.reason));

  let upstream: Response;
  try {
    upstream = await fetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.apiKey}`,
        "accept": "application/json",
      },
      body: JSON.stringify(translated),
      signal: abort.signal,
    });
  } catch (e) {
    log("error", "aistack.fetch_failed", { err: (e as Error).message, path: "rectifier" });
    return { status: 502, errorBody: { type: "error", error: { type: "api_error", message: `AI Stack fetch failed: ${(e as Error).message}` } } };
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    log("error", "aistack.upstream_error", { status: upstream.status, path: "rectifier", body: text.slice(0, 300) });
    return {
      status: upstream.status,
      errorBody: { type: "error", error: { type: upstream.status === 429 ? "rate_limit_error" : "api_error", message: `AI Stack returned ${upstream.status}: ${text.slice(0, 200)}` } },
    };
  }

  const raw = await upstream.json().catch(() => null);
  const parsed = AiStackResponse.safeParse(raw);
  if (!parsed.success) {
    log("error", "aistack.response_schema_mismatch", { errs: parsed.error.issues.slice(0, 3) });
    return { status: 502, errorBody: { type: "error", error: { type: "api_error", message: "AI Stack response failed schema validation" } } };
  }
  const primary = parsed.data;
  const msg = primary.choices[0].message;
  let content = msg.content ?? "";
  let toolCalls = msg.tool_calls ?? null;

  const toolNames = (translated.tools ?? []).map((t) => t.function.name);
  if (looksLikeXmlToolCall(content, toolNames) && translated.tools && translated.tools.length > 0) {
    log("info", "reformat.start", { contentChars: content.length });
    const rect = await rectifyToolCalls(content, translated.tools, env, reformatModel, abort.signal);
    if (rect.tool_calls && rect.tool_calls.length > 0) {
      content = rect.content;
      toolCalls = rect.tool_calls;
      log("info", "reformat.applied", { toolCallCount: rect.tool_calls.length });
    } else {
      log("warn", "reformat.no_tool_calls_returned");
    }
  }

  const stream = buildAnthropicSse({
    requestedModel: req.model,
    rawId: primary.id,
    content,
    toolCalls,
    inputTokens: primary.usage?.prompt_tokens ?? 0,
    outputTokens: primary.usage?.completion_tokens ?? 0,
    finishReason: primary.choices[0].finish_reason,
  });

  return { status: 200, stream, outcome: Promise.resolve("ok") };
}

type SseBuildInput = {
  requestedModel: string;
  rawId: string;
  content: string;
  toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> | null;
  inputTokens: number;
  outputTokens: number;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
};

function buildAnthropicSse(input: SseBuildInput): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(sseEvent(event, data)));

      const messageId = input.rawId ? `msg_mux_${input.rawId}` : `msg_mux_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      send("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: input.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: input.inputTokens, output_tokens: 0 },
        },
      });

      let idx = 0;
      // Text block (if any). Chunked so Claude Code's renderer paints progressively.
      const cleanContent = input.content.replace(/<\/?(eos|s|end_of_text)>|<\|(?:eot_id|end_of_text|im_end|endoftext)\|>/gi, "");
      if (cleanContent.length > 0) {
        send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
        for (let i = 0; i < cleanContent.length; i += 64) {
          send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: cleanContent.slice(i, i + 64) } });
        }
        send("content_block_stop", { type: "content_block_stop", index: idx });
        idx++;
      }

      // Tool-use blocks.
      if (input.toolCalls && input.toolCalls.length > 0) {
        for (const tc of input.toolCalls) {
          send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} } });
          send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
          send("content_block_stop", { type: "content_block_stop", index: idx });
          idx++;
        }
      }

      const stopReason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" =
        (input.toolCalls && input.toolCalls.length > 0) ? "tool_use" :
        input.finishReason === "length" ? "max_tokens" :
        "end_turn";

      send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: input.outputTokens } });
      send("message_stop", { type: "message_stop" });
      controller.close();
    },
  });
}
