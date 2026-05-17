import { AnthropicRequest, AiStackResponse } from "./schemas.ts";
import { translateRequest } from "./translate/request.ts";
import { translateResponse } from "./translate/response.ts";
import { SseTranslator, readSseStream, sseEvent } from "./translate/sse.ts";
import { withWatchdog, WatchdogTimeoutError } from "./resilience/watchdog.ts";
import { Semaphore, withSemaphore } from "./resilience/semaphore.ts";
import { fetchWithRetryOn429 } from "./resilience/retry.ts";
import { looksLikeXmlToolCall, rectifyToolCalls, rectifyToolCallsStreaming } from "./translate/reformat.ts";
import { forwardOAuthAsFallback, type AnthropicBody } from "./anthropic.ts";
import { log } from "./log.ts";

// Bound on how long the rectifier path will wait for the primary model before
// giving up and falling back to OAuth Sonnet. Configurable via env so the user
// can dial it for their backend's typical latency.
const REFORMAT_PRIMARY_TIMEOUT_MS = Number(process.env.FORKY_REFORMAT_PRIMARY_TIMEOUT_MS ?? 60_000);
const REFORMAT_RECTIFIER_TIMEOUT_MS = Number(process.env.FORKY_REFORMAT_RECTIFIER_TIMEOUT_MS ?? 20_000);
// SSE comment heartbeat interval — keeps Claude Code's socket from being closed
// by intermediate proxies / OS timeouts while we're waiting on the primary.
const HEARTBEAT_MS = Number(process.env.FORKY_HEARTBEAT_MS ?? 5_000);

// Per-provider concurrency limits. AI Stack's qwen services cap at 4
// concurrent; gemma at 8. Sharing one semaphore would throttle gemma behind
// qwen, so we maintain a small lookup keyed by the call site's label.
const EXEC_PRIMARY_MAX_CONCURRENT = Number(process.env.FORKY_EXEC_PRIMARY_MAX_CONCURRENT ?? process.env.FORKY_EXEC_MAX_CONCURRENT ?? 4);
const EXEC_RECTIFIER_MAX_CONCURRENT = Number(process.env.FORKY_EXEC_RECTIFIER_MAX_CONCURRENT ?? 8);
const EXEC_429_ATTEMPTS = Number(process.env.FORKY_EXEC_429_ATTEMPTS ?? 3);
const EXEC_429_BASE_DELAY_MS = Number(process.env.FORKY_EXEC_429_BASE_DELAY_MS ?? 250);

const primarySemaphore = new Semaphore(EXEC_PRIMARY_MAX_CONCURRENT);
const rectifierSemaphore = new Semaphore(EXEC_RECTIFIER_MAX_CONCURRENT);

/**
 * Back-compat export for callers that want a single snapshot. New code should
 * read getExecSemaphoreSnapshots() for per-provider visibility.
 */
export const execSemaphore = primarySemaphore;

export function getExecSemaphoreSnapshots() {
  return {
    primary: primarySemaphore.snapshot(),
    rectifier: rectifierSemaphore.snapshot(),
  };
}

function pickSemaphore(label: string): Semaphore {
  return label.includes("rectifier.gemma") ? rectifierSemaphore : primarySemaphore;
}

/**
 * fetch() through the appropriate execution-backend semaphore, with 429
 * retry+backoff. Use this for every outbound call to the EXEC_BASE_URL.
 * Label suffix "rectifier.gemma" routes to the gemma pool; everything else
 * goes through the primary (qwen) pool.
 */
export async function execFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  return withSemaphore(pickSemaphore(label), () =>
    fetchWithRetryOn429(url, init, {
      maxAttempts: EXEC_429_ATTEMPTS,
      baseDelayMs: EXEC_429_BASE_DELAY_MS,
      label,
    }),
  );
}

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
    upstream = await execFetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.apiKey}`,
        "accept": "application/json",
      },
      body: JSON.stringify(translated),
      signal,
    }, "aistack.nonstream");
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
    upstream = await execFetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.apiKey}`,
        "accept": "text/event-stream",
      },
      body: JSON.stringify(translated),
      signal: abort.signal,
    }, "aistack.stream");
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
  // Quick size telemetry — helps spot context bloat that pushes the primary
  // past its timeout. ~4 chars per token is the rough rule of thumb.
  const bodyChars = JSON.stringify(translated).length;
  log("info", "rectifier.size", {
    bodyChars,
    estTokens: Math.round(bodyChars / 4),
    messageCount: translated.messages.length,
    toolCount: translated.tools?.length ?? 0,
  });

  // Always return 200 + a stream. All upstream work happens inside the stream's
  // start() so we can emit SSE keep-alive heartbeats while waiting on the
  // primary, and fall back to OAuth Sonnet in-band on failure.
  let resolveOutcome!: (v: "ok" | "stream_error") => void;
  const outcome = new Promise<"ok" | "stream_error">((res) => { resolveOutcome = res; });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const sendStr = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch {} };

      // Heartbeat pump: SSE comments (lines starting with ":") are ignored by
      // parsers but keep the socket warm so Claude Code's fetch doesn't time
      // out while we wait for the primary.
      let waiting = true;
      const heartbeat = setInterval(() => {
        if (waiting) sendStr(": forky-keepalive\n\n");
      }, HEARTBEAT_MS);

      try {
        const primaryTimeout = AbortSignal.timeout(REFORMAT_PRIMARY_TIMEOUT_MS);
        const primarySignal = externalSignal
          ? AbortSignal.any([externalSignal, primaryTimeout])
          : primaryTimeout;

        let primary: ReturnType<typeof AiStackResponse.parse> | null = null;
        let primaryErr: Error | null = null;
        try {
          const upstream = await execFetch(`${env.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "authorization": `Bearer ${env.apiKey}`,
              "accept": "application/json",
            },
            body: JSON.stringify(translated),
            signal: primarySignal,
          }, "aistack.rectifier.primary");
          if (!upstream.ok) {
            const text = await upstream.text().catch(() => "");
            log("error", "aistack.upstream_error", { status: upstream.status, path: "rectifier", body: text.slice(0, 300) });
            primaryErr = new Error(`primary returned ${upstream.status}`);
          } else {
            const raw = await upstream.json().catch(() => null);
            const parsed = AiStackResponse.safeParse(raw);
            if (!parsed.success) {
              log("error", "aistack.response_schema_mismatch", { errs: parsed.error.issues.slice(0, 3) });
              primaryErr = new Error("response schema mismatch");
            } else {
              primary = parsed.data;
            }
          }
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          log("error", "aistack.fetch_failed", { err: msg, path: "rectifier", timedOut: primarySignal.aborted });
          primaryErr = new Error(msg);
        }

        if (!primary) {
          // Fall back to OAuth Sonnet, piping its stream through (it already
          // speaks Anthropic SSE so no translation needed). KEEP heartbeats
          // running during the fallback wait — Anthropic can take several
          // seconds to send the first SSE byte and a silent socket gets
          // dropped by Claude Code's fetch. SSE comment lines (heartbeats)
          // interleaved with real events is valid and harmless to the parser.
          log("warn", "rectifier.fallback_to_oauth", { reason: primaryErr?.message ?? "unknown" });
          await pipeOauthFallback(req, sendStr);
          // waiting flips false in the outer `finally` once the stream closes.
          resolveOutcome("stream_error");
          return;
        }

        // Optionally rectify XML tool emissions.
        const msg = primary.choices[0].message;
        const primaryContent = msg.content ?? "";
        const toolNames = (translated.tools ?? []).map((t) => t.function.name);
        const needsRectify =
          looksLikeXmlToolCall(primaryContent, toolNames)
          && translated.tools && translated.tools.length > 0;

        if (needsRectify && translated.tools) {
          // STREAMING rectifier path: pipe gemma's response through SseTranslator
          // so Claude Code starts seeing tool_use events as they're generated,
          // instead of waiting for gemma to fully complete.
          log("info", "reformat.start", { contentChars: primaryContent.length, mode: "streaming" });
          const rectTimeout = AbortSignal.timeout(REFORMAT_RECTIFIER_TIMEOUT_MS);
          const gemmaStream = await rectifyToolCallsStreaming(primaryContent, translated.tools, env, reformatModel, rectTimeout);

          if (gemmaStream) {
            waiting = false;
            const translator = new SseTranslator(req.model);
            let emittedAny = false;
            try {
              for await (const chunk of readSseStream(gemmaStream.body)) {
                if (chunk === "[DONE]") break;
                const out = translator.push(chunk);
                if (out) { sendStr(out); emittedAny = true; }
              }
              sendStr(translator.finish());
              log("info", "reformat.applied", { mode: "streaming", emittedAny });
              resolveOutcome("ok");
              return;
            } catch (e) {
              log("error", "rectifier.stream_error", { err: (e as Error).message });
              // fall through to terminal sequence
              sendStr(translator.finish({ appendText: `\n\n[forky: rectifier stream error: ${(e as Error).message}]` }));
              resolveOutcome("stream_error");
              return;
            }
          }

          // Streaming gemma failed (preflight). Fall back to non-streaming gemma.
          log("warn", "rectifier.streaming_unavailable_falling_back_nonstreaming");
          const rect = await rectifyToolCalls(primaryContent, translated.tools, env, reformatModel, rectTimeout)
            .catch((e: Error) => { log("error", "rectifier.error", { err: e.message }); return { content: primaryContent, tool_calls: null }; });
          waiting = false;
          sendStr(buildAnthropicSseString({
            requestedModel: req.model,
            rawId: primary.id,
            content: rect.tool_calls && rect.tool_calls.length > 0 ? rect.content : primaryContent,
            toolCalls: rect.tool_calls && rect.tool_calls.length > 0 ? rect.tool_calls : (msg.tool_calls ?? null),
            inputTokens: primary.usage?.prompt_tokens ?? 0,
            outputTokens: primary.usage?.completion_tokens ?? 0,
            finishReason: primary.choices[0].finish_reason,
          }));
          resolveOutcome("ok");
          return;
        }

        // No XML detected → emit primary's response as synthesized Anthropic SSE.
        waiting = false;
        sendStr(buildAnthropicSseString({
          requestedModel: req.model,
          rawId: primary.id,
          content: primaryContent,
          toolCalls: msg.tool_calls ?? null,
          inputTokens: primary.usage?.prompt_tokens ?? 0,
          outputTokens: primary.usage?.completion_tokens ?? 0,
          finishReason: primary.choices[0].finish_reason,
        }));
        resolveOutcome("ok");
      } catch (e) {
        log("error", "rectifier.unexpected_error", { err: (e as Error).message });
        waiting = false;
        sendStr(buildErrorTerminalSse(req.model, (e as Error).message));
        resolveOutcome("stream_error");
      } finally {
        waiting = false;
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      }
    },
  });

  return { status: 200, stream, outcome };
}

async function pipeOauthFallback(
  req: AnthropicRequest,
  sendStr: (s: string) => void,
): Promise<void> {
  let upstream: Response;
  try {
    upstream = await forwardOAuthAsFallback({ ...req, stream: true } as AnthropicBody);
  } catch (e) {
    sendStr(buildErrorTerminalSse(req.model, `OAuth fallback also failed: ${(e as Error).message}`));
    return;
  }
  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text().catch(() => "");
    sendStr(buildErrorTerminalSse(req.model, `OAuth fallback returned ${upstream.status}: ${t.slice(0, 200)}`));
    return;
  }
  // Pipe upstream Anthropic SSE bytes through unchanged.
  const reader = upstream.body.getReader();
  const dec = new TextDecoder("utf-8");
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) sendStr(dec.decode(value, { stream: true }));
  }
}

function buildErrorTerminalSse(model: string, errMsg: string): string {
  // Minimal valid Anthropic event sequence so Claude Code closes the turn cleanly
  // with a visible note, rather than the user seeing a "socket closed" error.
  const id = `msg_mux_err_${Date.now()}`;
  const text = `\n\n[forky: ${errMsg}]`;
  return sseEvent("message_start", {
    type: "message_start",
    message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  })
    + sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
    + sseEvent("content_block_stop", { type: "content_block_stop", index: 0 })
    + sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })
    + sseEvent("message_stop", { type: "message_stop" });
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

function buildAnthropicSseString(input: SseBuildInput): string {
  const parts: string[] = [];
  const send = (event: string, data: unknown) => parts.push(sseEvent(event, data));

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
  const cleanContent = input.content.replace(/<\/?(eos|s|end_of_text)>|<\|(?:eot_id|end_of_text|im_end|endoftext)\|>/gi, "");
  if (cleanContent.length > 0) {
    send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
    for (let i = 0; i < cleanContent.length; i += 64) {
      send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: cleanContent.slice(i, i + 64) } });
    }
    send("content_block_stop", { type: "content_block_stop", index: idx });
    idx++;
  }

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

  return parts.join("");
}

// Kept for any external callers — unused internally now.
function buildAnthropicSse(input: SseBuildInput): ReadableStream<Uint8Array> {
  const text = buildAnthropicSseString(input);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}
