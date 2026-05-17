import { AnthropicRequest, AiStackResponse } from "./schemas.ts";
import { translateRequest } from "./translate/request.ts";
import { translateResponse } from "./translate/response.ts";
import { SseTranslator, readSseStream } from "./translate/sse.ts";
import { withWatchdog, WatchdogTimeoutError } from "./resilience/watchdog.ts";
import { log } from "./log.ts";

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
