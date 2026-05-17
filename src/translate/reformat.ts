import { type AiStackEnv, execFetch } from "../aistack.ts";
import { log } from "../log.ts";

type OpenAiTool = {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
};

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

const RECTIFIER_SYSTEM_PROMPT =
  "You are a tool-call rectifier. The previous model wrote tool invocations as XML tags " +
  "(either short form like <Read path=\"x\"> or long form like <function_calls><invoke name=\"Read\">" +
  "<parameter name=\"file_path\">x</parameter></invoke></function_calls>) INSTEAD of using the structured " +
  "tool_calls field. Re-emit ALL tool invocations from the input as proper tool_calls. Map parameter " +
  "names to the schemas of the declared tools (e.g. if the input used `path` but the schema requires " +
  "`file_path`, fix it). Preserve any narrative text from the input that was OUTSIDE the XML tags. " +
  "Output ONLY: optional narrative text + structured tool_calls. Do NOT re-emit the XML.";

// Lightweight detector — fast string checks before paying for a rectifier round-trip.
const XML_TOOL_HINTS = [
  "<function_calls>",
  "<invoke name=",
  "<parameter name=",
];

export function looksLikeXmlToolCall(content: string, toolNames: ReadonlyArray<string>): boolean {
  if (!content) return false;
  for (const h of XML_TOOL_HINTS) if (content.includes(h)) return true;
  // Short form: <ToolName ...> where ToolName is one of the declared tools.
  for (const name of toolNames) {
    if (new RegExp(`<${escapeRegex(name)}(\\s|>|/)`).test(content)) return true;
  }
  return false;
}

export type RectifierResult = {
  content: string;
  tool_calls: OpenAiToolCall[] | null;
};

/**
 * Streaming variant: returns gemma's raw response body (OpenAI SSE bytes) so
 * the caller can pipe each chunk through SseTranslator and emit Anthropic
 * events as they arrive. Saves ~1-2s of visible latency on rectifier turns
 * vs buffering. Returns null on any error — caller should fall back to the
 * non-streaming rectifyToolCalls() or emit a terminal error.
 */
export async function rectifyToolCallsStreaming(
  rawContent: string,
  tools: ReadonlyArray<OpenAiTool>,
  env: AiStackEnv,
  reformatModel: string,
  signal?: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array> } | null> {
  const body = {
    model: reformatModel,
    stream: true,
    max_tokens: 2000,
    tools_enabled: false,
    tools,
    messages: [
      { role: "system", content: RECTIFIER_SYSTEM_PROMPT },
      { role: "user", content: rawContent },
    ],
  };

  let res: Response;
  try {
    res = await execFetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.apiKey}`,
        "accept": "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    }, "aistack.rectifier.gemma");
  } catch (e) {
    log("error", "reformat.streaming_fetch_failed", { err: (e as Error).message });
    return null;
  }
  if (!res.ok || !res.body) {
    log("error", "reformat.streaming_upstream_error", { status: res.status });
    await res.text().catch(() => "");
    return null;
  }
  return { body: res.body };
}

export async function rectifyToolCalls(
  rawContent: string,
  tools: ReadonlyArray<OpenAiTool>,
  env: AiStackEnv,
  reformatModel: string,
  signal?: AbortSignal,
): Promise<RectifierResult> {
  const body = {
    model: reformatModel,
    stream: false,
    max_tokens: 2000,
    tools_enabled: false,
    tools,
    messages: [
      { role: "system", content: RECTIFIER_SYSTEM_PROMPT },
      { role: "user", content: rawContent },
    ],
  };

  let res: Response;
  try {
    res = await execFetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    }, "aistack.rectifier.gemma");
  } catch (e) {
    log("error", "reformat.fetch_failed", { err: (e as Error).message });
    return { content: rawContent, tool_calls: null };
  }

  if (!res.ok) {
    log("error", "reformat.upstream_error", { status: res.status });
    return { content: rawContent, tool_calls: null };
  }

  const data = await res.json().catch(() => null) as
    | { choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }> }
    | null;

  const msg = data?.choices?.[0]?.message;
  if (!msg) {
    log("warn", "reformat.empty_response");
    return { content: rawContent, tool_calls: null };
  }

  return { content: msg.content ?? "", tool_calls: msg.tool_calls ?? null };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
