# forky

> A local proxy that splits Claude Code traffic between your **Claude Pro/Max OAuth subscription** (for planning) and **any OpenAI-compatible endpoint** (for execution). Built because Claude Code's `/model opusplan` only works within Anthropic's models — forky brings the same UX with any execution backend, plus an opt-in pipeline for models that need help formatting tool calls.

```
Claude Code (VSCode + CLI)
  │  ANTHROPIC_BASE_URL=http://127.0.0.1:3456
  ▼
┌─ forky ─────────────────────────────────────────────────────┐
│                                                             │
│   plan mode    ───► Anthropic OAuth (your Max plan)         │
│   default      ───► your OpenAI-compatible endpoint         │
│   Write/Edit ≥50 lines ──► optional Opus reviewer hook      │
│                                                             │
│   • prompt caching on the OAuth path (~80% input savings)   │
│   • per-provider concurrency limiter + 429 retry/backoff    │
│   • stream watchdog + SSE keep-alive (no socket drops)      │
│   • circuit breaker with persistent state across restarts   │
│   • transparent OAuth Sonnet fallback on exec failure       │
│   • optional rectifier: 2-model chain for XML-leaky models  │
└─────────────────────────────────────────────────────────────┘
```

## Why

- Anthropic disables Claude Code's `/model` picker the moment you set `ANTHROPIC_BASE_URL`, so the built-in `opusplan` alias can't be selected through a custom endpoint.
- `claude-code-router` and similar proxies are **API-key only** — they can't preserve your Claude Pro/Max OAuth subscription.
- Plan mode is **undetectable from the API** (the system prompt is byte-identical to non-plan mode), so the proxy alone can't infer it.

forky solves all three:
1. Reads your Claude Code OAuth token directly from the macOS Keychain (or `~/.claude/.credentials.json` on Linux) and forwards it as `Authorization: Bearer …` to `api.anthropic.com`. Your Max subscription is preserved.
2. Routes execution traffic (anything that isn't `claude-opus-*`) to any OpenAI-compatible `/chat/completions` endpoint you own.
3. Detects plan mode via a Claude Code `UserPromptSubmit` hook that toggles a local sentinel file — fully automatic.

## Requirements

- **macOS** (uses the Keychain) or **Linux** (reads `~/.claude/.credentials.json`)
- [Bun](https://bun.sh) ≥ 1.3
- An active Claude Pro or Max subscription, already logged into Claude Code
- Any **OpenAI-compatible** API endpoint of your own (Groq, Together, Fireworks, vLLM, self-hosted Ollama, your own service, etc.)

## Install

```bash
git clone https://github.com/vladharl/forky ~/dev/forky
cd ~/dev/forky
bun install
```

Set your execution-backend credentials in `~/.zshrc`:

```bash
export EXEC_BASE_URL="https://your-endpoint.example.com/v1"
export EXEC_API_KEY="your-api-key"
export EXEC_MODEL="qwen-35b"        # or whatever your backend exposes
export PORT=3456
```

Optional (recommended for XML-leaky models like qwen):

```bash
export EXEC_REFORMAT_MODEL="gemma-micro"   # see "two-model rectifier" below
export FORKY_FRESH_TURNS=on                # cap context per user prompt
export FORKY_MAX_MESSAGES=20               # hard cap within a turn
```

Start the proxy:

```bash
./bin/forky                                            # foreground
# or
nohup ./bin/forky > ~/.forky/server.log 2>&1 & disown
```

You should see `{"event":"server.start","port":3456}` in the log.

### Wire Claude Code

**VSCode extension** — add to your User `settings.json` (Cmd+Shift+P → "Preferences: Open User Settings (JSON)"):

```jsonc
"claudeCode.environmentVariables": [
  { "name": "ANTHROPIC_BASE_URL", "value": "http://127.0.0.1:3456" },
  { "name": "ANTHROPIC_AUTH_TOKEN", "value": "forky-dummy" },
  { "name": "ANTHROPIC_MODEL", "value": "claude-sonnet-4-6" }
]
```

(`ANTHROPIC_MODEL` makes Claude Code default to Sonnet, which routes to your execution backend. Opus is still reachable via plan mode or `forky-opus on`.)

**CLI** — add to `~/.zshrc`:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
export ANTHROPIC_AUTH_TOKEN="forky-dummy"
export ANTHROPIC_MODEL="claude-sonnet-4-6"
```

Or scope to the VSCode integrated terminal only via `terminal.integrated.env.osx`.

### Wire the plan-mode hook (optional, recommended)

Plan-mode auto-detection lives in `~/.claude/settings.json`. Add:

```jsonc
"hooks": {
  "UserPromptSubmit": [
    { "hooks": [{ "type": "command", "command": "/absolute/path/to/forky/bin/forky-hook" }] }
  ]
}
```

Reload the hook watcher: in Claude Code type `/hooks`, or restart. Plan mode (Shift+Tab) now auto-routes to OAuth Opus; default mode goes to your execution backend.

## Usage

| Claude Code mode | Routes to | Why |
|---|---|---|
| **Default / auto-accept** | `EXEC_MODEL` on `EXEC_BASE_URL` | Cheap, fast execution; Max quota untouched |
| **Plan** (Shift+Tab) | `claude-opus-4-7` via OAuth | Quality reasoning for design/planning |
| **`/model claude-opus-*`** | Same as plan | If you ever explicitly request Opus |
| **Manual override** | `forky-opus on/off` | Force Opus without entering plan mode (auto-expires after 4h) |

### Observability

```bash
./bin/forky-status                              # circuit + per-pool semaphores + counters
tail -F ~/.forky/log/$(date +%F).jsonl          # live request log (JSONL)
tail -F ~/.forky/reviews.jsonl                  # Opus reviewer audit log
./bin/forky-opus status                         # current routing mode
curl -s http://127.0.0.1:3456/health | jq .     # JSON health summary
```

## Configuration

### Required

| Env var | Purpose |
|---|---|
| `EXEC_API_KEY` | bearer for your OpenAI-compatible endpoint |
| `EXEC_BASE_URL` | e.g. `https://api.together.xyz/v1` |

### Common

| Env var | Default | Purpose |
|---|---|---|
| `EXEC_MODEL` | `qwen-35b` | model name sent to the execution backend |
| `EXEC_REFORMAT_MODEL` | unset | enables the 2-model rectifier (see below) |
| `PORT` | `3458` | listening port (set to `3456` for production) |
| `HOST` | `127.0.0.1` | bind address — keep loopback |
| `FORKY_FRESH_TURNS` | unset | when `on`, each request is trimmed to the latest user prompt + its tool chain |
| `FORKY_MAX_MESSAGES` | `0` (unlimited) | hard cap on messages per request (e.g. `20`) |
| `FORKY_REVIEW` | `on` | toggle for the optional `bin/forky-review-hook` PreToolUse hook |
| `FORKY_CREDENTIALS_FILE` | `~/.claude/.credentials.json` | Linux only — override the OAuth credentials path |

### Resilience tuning

| Env var | Default | Purpose |
|---|---|---|
| `FORKY_FIRST_BYTE_MS` | `30000` | stream watchdog: first-byte timeout |
| `FORKY_INTER_CHUNK_MS` | `15000` | stream watchdog: inter-chunk timeout |
| `FORKY_REFORMAT_PRIMARY_TIMEOUT_MS` | `60000` | rectifier path: max wait for the primary model |
| `FORKY_REFORMAT_RECTIFIER_TIMEOUT_MS` | `20000` | rectifier path: max wait for the reformatter |
| `FORKY_HEARTBEAT_MS` | `5000` | SSE keep-alive heartbeat interval |
| `FORKY_EXEC_PRIMARY_MAX_CONCURRENT` | `4` | concurrency cap for primary model calls |
| `FORKY_EXEC_RECTIFIER_MAX_CONCURRENT` | `8` | concurrency cap for reformatter calls |
| `FORKY_EXEC_429_ATTEMPTS` | `3` | retry attempts on HTTP 429 (honours `Retry-After`) |
| `FORKY_EXEC_429_BASE_DELAY_MS` | `250` | base for exponential backoff between retries |
| `FORKY_CIRCUIT_THRESHOLD` | `3` | failures before circuit opens |
| `FORKY_CIRCUIT_WINDOW_MS` | `60000` | sliding window for failures |
| `FORKY_CIRCUIT_OPEN_MS` | `60000` | how long the circuit stays open |

`AISTACK_*` env vars (`AISTACK_API_KEY`, `AISTACK_BASE_URL`, `AISTACK_MODEL`) are accepted as legacy aliases.

## Optional: 2-model rectifier (`EXEC_REFORMAT_MODEL`)

Many open-weight models (including qwen-2.5/3 variants) **mimic the XML tool-call examples** in Claude Code's system prompt (`<function_calls><invoke name="X">...</invoke></function_calls>`) instead of using the OpenAI `tool_calls` field. The XML lands in `message.content` as plain text. Claude Code displays it but never executes the tool.

With `EXEC_REFORMAT_MODEL` set, forky runs a chain:

1. Calls `EXEC_MODEL` non-streaming (qwen-35b in the example).
2. If the response content contains XML tool patterns, sends qwen's output to `EXEC_REFORMAT_MODEL` (gemma-micro) with the same tool definitions and a rectifier system prompt.
3. Streams the reformatter's structured `tool_calls` through `SseTranslator` so Claude Code sees `tool_use` events as they arrive.
4. The reformatter also fixes wrong parameter names (e.g. qwen writes `path` but the schema requires `file_path` — gemma maps it).

Observed behaviour:
- ✅ `gemma-micro` / Gemma-family — proper function calls even under aggressive XML priming
- ✅ `gpt-4o-mini`, `claude-haiku` via API — proper function calls
- ❌ `qwen-35b`, `qwen-27b` — emit XML; need the rectifier

If you only use models from the green list, leave `EXEC_REFORMAT_MODEL` unset.

See [`docs/qwen-gemma-rectifier.md`](docs/qwen-gemma-rectifier.md) for the design write-up + test fixtures.

## Optional: per-turn Opus review of Write/Edit changes

`bin/forky-review-hook` is a PreToolUse hook that runs Opus on every `Write`/`Edit` over 50 lines to catch bugs/typos before they land. Skips:

- tests/specs (`*/tests/*`, `*.test.*`, `*.spec.*`)
- docs (`*.md`, `*.mdx`, `*.rst`, `*.txt`)
- lock files (`*.lock`, `package-lock.json`, `bun.lock`, …)
- whitespace-only diffs (the change is a reformat — not worth Opus tokens)

If Opus suggests fixes, the corrected `tool_input` is handed back to Claude Code via `hookSpecificOutput.updatedInput` and the original change never runs.

Register in `~/.claude/settings.json`:

```jsonc
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [{ "type": "command", "command": "/absolute/path/to/forky/bin/forky-review-hook" }]
    }
  ]
}
```

Disable temporarily with `FORKY_REVIEW=off`. Audit log at `~/.forky/reviews.jsonl`.

## How it works

- **OAuth path**: forky reads your stored OAuth token (macOS Keychain item `Claude Code-credentials`, or `~/.claude/.credentials.json` on Linux), refreshes it via `console.anthropic.com/v1/oauth/token` when expired, and forwards requests to `api.anthropic.com` with the required `oauth-2025-04-20` beta header and `"You are Claude Code, Anthropic's official CLI for Claude."` system block. The last system block and last tool definition get `cache_control: {type: "ephemeral"}` so Anthropic caches the (large, stable) prefix across turns — cuts plan-mode input tokens ~80% on warm hits.
- **Execution path**: requests get translated from Anthropic Messages API → OpenAI Chat Completions (system blocks flattened, tools mapped, image blocks → `image_url`). `tools_enabled: false` is hard-pinned to prevent server-side tool loops on backends that expose them. Orchestration tools (`Agent`, `TodoWrite`, `AskUserQuestion`, etc.) are stripped — they're for the planner, not the executor.
- **Stream translation**: OpenAI delta chunks → Anthropic event stream (`message_start` → `content_block_*` → `message_delta` → `message_stop`), with partial-JSON accumulation for streaming tool calls. `delta.reasoning_content` and end-of-sequence tokens (`<eos>`, `<|eot_id|>`, …) are dropped.
- **Concurrency limiter + retry**: outbound execution-backend calls go through per-pool semaphores (primary cap 4, rectifier cap 8 by default — matching typical provider caps) so bursts from Claude Code can't trigger 429s. Any 429 that does slip through is retried with exponential backoff that honours `Retry-After`.
- **Never-stuck guarantee**: a stream watchdog fires `WatchdogTimeoutError` on first-byte / inter-chunk gap, SSE keep-alive heartbeats (`: forky-keepalive`) prevent socket drops during slow primary calls, the circuit breaker reroutes to OAuth Sonnet after N consecutive failures, and every code path emits a terminal `message_stop` event in a `finally` block so Claude Code never waits forever.
- **Persistent state**: counters and circuit state are written to `~/.forky/status.json` after every change. On startup, recent state is restored (counters always; circuit only if the OPEN window hasn't expired) so a forky restart mid-incident doesn't reset to "everything is fine."
- **Per-turn isolation** (`FORKY_FRESH_TURNS=on`): each user prompt becomes a self-contained agent invocation. Forky trims the conversation back to the latest user message + its tool chain. Sacrifices cross-prompt memory in exchange for never hitting context overflow on long sessions. `FORKY_MAX_MESSAGES` adds a hard cap on top, sliding the start forward to land on a fresh-user-prompt boundary so tool_use/tool_result pairing isn't broken.

## Tests

```bash
bun test     # 85 unit tests, sub-second
```

Covers request translation, response translation, SSE streaming with tool calls, schema contracts, circuit breaker (incl. restore-from-disk), stream watchdog, in-process semaphore, 429 retry/backoff, OAuth header injection + cache-control markers, fresh-turn / max-message trimming, XML-tool detector.

## Limitations / gotchas

- **Plan-mode auto-detection requires the hook**. Plan mode leaves no trace in the API request — without `forky-hook` wired into Claude Code settings, you'll need `forky-opus on/off` for manual switching.
- **Claude Code's `/model` picker stays disabled** because `ANTHROPIC_BASE_URL` is set. opusplan-style behaviour comes from the hook + sentinel mechanism, not Claude Code's built-in alias.
- **Tool-call fidelity depends on your execution model** — see the rectifier section above for which models work without one.
- **`context_management` body field** is stripped on the OAuth path — Anthropic's OAuth endpoint 400s on it. Claude Code's local context auto-edit still works; only the API-side context-management feature is disabled.

## Terms of service note

Anthropic's [Terms of Service](https://www.anthropic.com/legal) restrict OAuth tokens to "Claude Code and claude.ai." forky forwards the OAuth token only on behalf of Claude Code itself (a transparent local proxy), and execution traffic uses an unrelated API key — but Keychain extraction could plausibly be argued as circumvention. Use at your own risk. Keep the proxy bound to `127.0.0.1`, never share tokens, and don't use this in production or multi-user environments.

## License

MIT — see [LICENSE](LICENSE).
