import { Hono } from "hono";
import { forwardOAuth, forwardOAuthAsFallback, type AnthropicBody } from "./anthropic.ts";
import { dispatchAiStackNonStreaming, dispatchAiStackStreaming, getAiStackEnv, getExecSemaphoreSnapshots, type AiStackEnv } from "./aistack.ts";
import { maybeSummarize } from "./compact.ts";
import { AnthropicRequest } from "./schemas.ts";
import { decideRoute } from "./route.ts";
import { Circuit } from "./resilience/circuit.ts";
import { setPort, incRequests, incAiStackFailure, incFallback, updateCircuit, getPersistedSnapshot } from "./resilience/status.ts";
import { log } from "./log.ts";

// Dev port: 3456 = dario, 3457 = dario-bridge zombie. Cutover moves to 3456 later.
const PORT = Number(process.env.PORT ?? 3458);
const HOST = process.env.HOST ?? "127.0.0.1";

const WATCHDOG = {
  firstByteMs: Number(process.env.FORKY_FIRST_BYTE_MS ?? 30_000),
  interChunkMs: Number(process.env.FORKY_INTER_CHUNK_MS ?? 15_000),
};

let aiStackEnv: AiStackEnv | null = null;
try {
  aiStackEnv = getAiStackEnv();
} catch (e) {
  log("warn", "aistack.env_missing", { err: (e as Error).message });
}

const circuit = new Circuit({
  threshold: Number(process.env.FORKY_CIRCUIT_THRESHOLD ?? 3),
  windowMs: Number(process.env.FORKY_CIRCUIT_WINDOW_MS ?? 60_000),
  openMs: Number(process.env.FORKY_CIRCUIT_OPEN_MS ?? 60_000),
});
// Restore circuit from disk if the previous instance was OPEN within the
// current openMs window — otherwise a restart would silently reset to CLOSED
// and let a known-bad upstream get hammered immediately again.
{
  const persisted = getPersistedSnapshot();
  if (persisted?.circuit && circuit.restore(persisted.circuit)) {
    log("info", "circuit.restored_from_disk", { openedAt: persisted.circuit.openedAt });
  }
}
const syncCircuit = () => updateCircuit(circuit.snapshot());

const app = new Hono();

app.get("/health", (c) => c.json({
  ok: true,
  version: "0.1.0",
  providers: { anthropic_oauth: true, aistack: aiStackEnv != null },
  circuit: circuit.snapshot(),
  watchdog: WATCHDOG,
  execSemaphores: getExecSemaphoreSnapshots(),
}));

app.post("/v1/messages", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch (e) {
    return c.json(
      { type: "error", error: { type: "invalid_request_error", message: `bad json: ${(e as Error).message}` } },
      400,
    );
  }

  const parsed = AnthropicRequest.safeParse(rawBody);
  if (!parsed.success) {
    log("warn", "request.schema_fail", { errs: parsed.error.issues.slice(0, 5) });
    return c.json(
      { type: "error", error: { type: "invalid_request_error", message: `request shape invalid: ${parsed.error.message}` } },
      400,
    );
  }
  const body = parsed.data;
  const isStream = !!body.stream;
  const decision = decideRoute(body.model, body);
  const startedAt = Date.now();
  incRequests();

  // If the router rewrites the model (plan-mode → claude-opus-4-7), apply it to the body.
  let routedBody: typeof body = body;
  if (decision.rewriteModel && decision.rewriteModel !== body.model) {
    routedBody = { ...body, model: decision.rewriteModel };
  }
  const model = routedBody.model;

  // Capture client request headers we need to forward (anthropic-beta gates body fields
  // like context_management, so dropping it gets a 400 from api.anthropic.com).
  const clientHeaders: Record<string, string> = {};
  for (const h of ["anthropic-beta", "anthropic-version"]) {
    const v = c.req.header(h);
    if (v) clientHeaders[h] = v;
  }

  // Tool inventory log (truncated) — handy when diagnosing tool-routing surprises.
  const toolNames = body.tools?.map((t) => t.name).slice(0, 12) ?? [];

  // Circuit-aware actual provider selection.
  const useAiStack = decision.provider === "aistack" && aiStackEnv != null && circuit.shouldAllow();
  const actualProvider: "aistack" | "anthropic-oauth" = useAiStack ? "aistack" : "anthropic-oauth";
  const fellBack = decision.provider === "aistack" && actualProvider === "anthropic-oauth";
  if (fellBack) {
    incFallback();
    log("info", "fallback", { reason: aiStackEnv == null ? "no-key" : "circuit-open" });
  }
  log("info", "request", {
    requestedModel: body.model,
    routedModel: model,
    routedVia: decision.reason,
    requestedProvider: decision.provider,
    actualProvider,
    stream: isStream,
    toolCount: body.tools?.length ?? 0,
    tools: toolNames,
  });

  // ─── Anthropic OAuth path (planning, or fallback) ───
  if (actualProvider === "anthropic-oauth") {
    // For STREAMING requests, return an SSE stream that pumps keep-alive
    // comments while we await the fetch — Anthropic can take 30+ seconds to
    // send headers under load, and silent sockets get dropped by Claude
    // Code's fetch. For non-streaming requests, pass through directly (the
    // client expects a single JSON body, not SSE).
    if (isStream) {
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let active = true;
          const heartbeat = setInterval(() => {
            if (active) { try { controller.enqueue(enc.encode(": forky-keepalive\n\n")); } catch {} }
          }, 5000);
          try {
            const upstream = fellBack
              ? await forwardOAuthAsFallback(routedBody as AnthropicBody, undefined, undefined, clientHeaders)
              : await forwardOAuth(routedBody as AnthropicBody, undefined, clientHeaders);
            log("info", "response", { provider: actualProvider, status: upstream.status, ms: Date.now() - startedAt });
            if (!upstream.body) { active = false; clearInterval(heartbeat); controller.close(); return; }
            const reader = upstream.body.getReader();
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) { active = false; controller.enqueue(value); }
            }
          } catch (e) {
            log("error", "anthropic.fetch_failed", { err: (e as Error).message });
            try {
              controller.enqueue(enc.encode(
                "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_mux_err\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"" + model + "\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}\n\n"
                + "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"
                + "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"[forky: OAuth upstream failed: " + (e as Error).message.replace(/"/g, "'") + "]\"}}\n\n"
                + "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n"
                + "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":0}}\n\n"
                + "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
              ));
            } catch {}
          } finally {
            active = false;
            clearInterval(heartbeat);
            try { controller.close(); } catch {}
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" },
      });
    }

    // Non-streaming OAuth pass-through.
    let upstream: Response;
    try {
      upstream = fellBack
        ? await forwardOAuthAsFallback(routedBody as AnthropicBody, undefined, undefined, clientHeaders)
        : await forwardOAuth(routedBody as AnthropicBody, undefined, clientHeaders);
    } catch (e) {
      log("error", "anthropic.fetch_failed", { err: (e as Error).message });
      return c.json(
        { type: "error", error: { type: "api_error", message: `OAuth upstream failed: ${(e as Error).message}` } },
        502,
      );
    }
    log("info", "response", { provider: actualProvider, status: upstream.status, ms: Date.now() - startedAt });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  // ─── AI Stack path ───
  if (!aiStackEnv) {
    return c.json(
      { type: "error", error: { type: "api_error", message: "AISTACK_API_KEY not configured" } },
      500,
    );
  }

  // Optional async compaction: if FORKY_SUMMARIZE_THRESHOLD is set and the
  // conversation is long, fold older history into a single summary system
  // block via gemma-micro before the actual dispatch.
  const compactedBody = await maybeSummarize(routedBody);

  if (isStream) {
    const result = await dispatchAiStackStreaming(compactedBody, aiStackEnv, WATCHDOG);
    if (result.status !== 200) {
      circuit.recordFailure();
      incAiStackFailure();
      syncCircuit();
      // Pre-flight failure: fall back to OAuth before responding.
      log("warn", "aistack.preflight_fail_falling_back", { status: result.status });
      try {
        const upstream = await forwardOAuthAsFallback(body as AnthropicBody, undefined, undefined, clientHeaders);
        incFallback();
        log("info", "response", { provider: "anthropic-oauth-fallback", status: upstream.status, ms: Date.now() - startedAt });
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
        });
      } catch (e) {
        return c.json({ type: "error", error: { type: "api_error", message: `both providers failed: ${(e as Error).message}` } }, 502);
      }
    }
    // Wire circuit to outcome (resolves when stream ends).
    result.outcome.then((o) => {
      if (o === "ok") { circuit.recordSuccess(); }
      else { circuit.recordFailure(); incAiStackFailure(); }
      syncCircuit();
    });
    log("info", "response", { provider: actualProvider, status: 200, stream: true, startedMs: Date.now() - startedAt });
    return new Response(result.stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" },
    });
  }

  // Non-streaming AI Stack path.
  const { status, body: outBody } = await dispatchAiStackNonStreaming(compactedBody, aiStackEnv);
  if (status !== 200) {
    circuit.recordFailure();
    incAiStackFailure();
    syncCircuit();
    // Fall back.
    log("warn", "aistack.nonstream_fail_falling_back", { status });
    try {
      const upstream = await forwardOAuthAsFallback(body as AnthropicBody);
      incFallback();
      const text = await upstream.text();
      return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
    } catch (e) {
      return c.json({ type: "error", error: { type: "api_error", message: `both providers failed: ${(e as Error).message}` } }, 502);
    }
  }
  circuit.recordSuccess();
  syncCircuit();
  log("info", "response", { provider: actualProvider, status, ms: Date.now() - startedAt });
  return c.json(outBody, status as 200);
});

// Bun.serve's idleTimeout defaults to 10s, which kills long-running streaming
// responses (plan-mode turns regularly run 30s+; auto-mode tool chains longer).
// 255 is the maximum allowed value in Bun (~4min); enough for any single turn.
// Heartbeats keep the data flowing for the client; idleTimeout protects forky
// from genuinely abandoned connections.
const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
  idleTimeout: 255,
});
setPort(server.port);
syncCircuit();
log("info", "server.start", { host: server.hostname, port: server.port, watchdog: WATCHDOG });
