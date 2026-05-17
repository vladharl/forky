# forky

> A tiny local proxy that splits Claude Code traffic between your **Claude Max OAuth subscription** (for planning) and **any OpenAI-compatible endpoint** (for execution). Built because Claude Code's `/model opusplan` only works within Anthropic's models — forky brings the same UX with any execution backend.

```
Claude Code (VSCode + CLI)
  │  ANTHROPIC_BASE_URL=http://127.0.0.1:3456
  ▼
┌─ forky ─────────────────────────────────────────────┐
│                                                     │
│   plan mode  ───► Anthropic OAuth (your Max plan)   │
│   default    ───► your OpenAI-compatible endpoint   │
│                                                     │
│   • stream watchdog (no hangs)                      │
│   • circuit breaker (auto-fallback on failure)      │
│   • Zod-validated request/response contracts        │
└─────────────────────────────────────────────────────┘
```

## Why

- Anthropic disables Claude Code's `/model` picker the moment you set `ANTHROPIC_BASE_URL`, so the built-in `opusplan` alias can't be selected through a custom endpoint.
- `claude-code-router` and similar proxies are **API-key only** — they can't preserve your Claude Pro/Max OAuth subscription.
- Plan mode is **undetectable from the API** (the system prompt is byte-identical to non-plan mode), so the proxy alone can't infer it.

forky solves all three:
1. Reads your Claude Code OAuth token directly from the macOS Keychain and forwards it as `Authorization: Bearer …` to `api.anthropic.com`. Your Max subscription is preserved.
2. Routes execution traffic (anything that isn't `claude-opus-*`) to any OpenAI-compatible `/chat/completions` endpoint you own.
3. Detects plan-mode via a Claude Code `UserPromptSubmit` hook that toggles a local sentinel file — fully automatic.

## Requirements

- macOS (uses the macOS Keychain for OAuth tokens)
- [Bun](https://bun.sh) ≥ 1.3
- An active Claude Pro or Max subscription, already logged into Claude Code
- Any **OpenAI-compatible** API endpoint of your own (Groq, Together, Fireworks, vLLM, self-hosted Ollama, your own service, etc.)

## Install

```bash
git clone https://github.com/vladharl/forky ~/dev/forky
cd ~/dev/forky
bun install
```

Set your execution-backend credentials in `~/.zshrc` (or wherever your shell rc lives):

```bash
export EXEC_BASE_URL="https://your-endpoint.example.com/v1"
export EXEC_API_KEY="your-api-key"
export EXEC_MODEL="qwen-35b"   # optional; defaults to "qwen-35b"
```

Start the proxy:

```bash
./bin/forky                                            # foreground
# or
PORT=3456 nohup ./bin/forky > ~/.forky/server.log 2>&1 & disown
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

(`ANTHROPIC_MODEL` makes Claude Code default to Sonnet, which routes to your execution backend. Opus is still reachable via plan mode or the manual override.)

**CLI** — add to `~/.zshrc`:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
export ANTHROPIC_AUTH_TOKEN="forky-dummy"
export ANTHROPIC_MODEL="claude-sonnet-4-6"
```

Or scope to the VSCode integrated terminal only via `terminal.integrated.env.osx`.

### Wire the plan-mode hook (optional but recommended)

Plan-mode auto-detection lives in `~/.claude/settings.json`. Add:

```jsonc
"hooks": {
  "UserPromptSubmit": [
    { "hooks": [ { "type": "command", "command": "/absolute/path/to/forky/bin/forky-hook" } ] }
  ]
}
```

Reload the hook watcher: in Claude Code type `/hooks`, or restart.

Now plan mode (Shift+Tab) auto-routes to OAuth Opus; default mode goes to your execution backend; the moment you exit plan mode you're back on the execution backend.

## Usage

| Claude Code mode | Routes to | Why |
|---|---|---|
| **Default / auto-accept** | `EXEC_MODEL` on `EXEC_BASE_URL` | Cheap, fast execution; Max quota untouched |
| **Plan** (Shift+Tab) | `claude-opus-4-7` via OAuth | Quality reasoning for design/planning |
| **`/model claude-opus-*`** | Same as plan | If you ever explicitly request Opus |
| **Manual override** | `forky-opus on/off` | Force Opus without entering plan mode (auto-expires after 4h) |

### Status + observability

```bash
./bin/forky-status                              # circuit state + counters
tail -F ~/.forky/log/$(date +%F).jsonl          # live request log
./bin/forky-opus status                         # current routing mode
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `EXEC_API_KEY` | — | **required** — bearer for your OpenAI-compatible endpoint |
| `EXEC_BASE_URL` | — | **required** — e.g. `https://api.together.xyz/v1` |
| `EXEC_MODEL` | `qwen-35b` | model name sent to the execution backend |
| `PORT` | `3458` | listening port (set to `3456` for production) |
| `HOST` | `127.0.0.1` | bind address — keep loopback |
| `FORKY_FIRST_BYTE_MS` | `30000` | stream watchdog: first-byte timeout |
| `FORKY_INTER_CHUNK_MS` | `15000` | stream watchdog: inter-chunk timeout |
| `FORKY_CIRCUIT_THRESHOLD` | `3` | failures before circuit opens |
| `FORKY_CIRCUIT_WINDOW_MS` | `60000` | sliding window for failures |
| `FORKY_CIRCUIT_OPEN_MS` | `60000` | how long the circuit stays open |

`AISTACK_*` env vars (`AISTACK_API_KEY`, `AISTACK_BASE_URL`, `AISTACK_MODEL`) are accepted as legacy aliases.

## How it works

- **OAuth path**: forky shells out to `security find-generic-password -s "Claude Code-credentials"` to read your stored access token, refreshes it via `console.anthropic.com/v1/oauth/token` when expired, and forwards requests to `api.anthropic.com` with the required `oauth-2025-04-20` beta header and `"You are Claude Code, Anthropic's official CLI for Claude."` system block. Claude Code itself never knows; it thinks it's talking to a normal API endpoint with a dummy key.
- **Execution path**: every request gets translated from Anthropic Messages API → OpenAI Chat Completions (system blocks flattened, tools mapped, image blocks → `image_url`). `tools_enabled: false` is hard-pinned to prevent server-side tool loops on backends that expose them (e.g. native web search).
- **Stream translation**: OpenAI delta chunks → Anthropic event stream (`message_start` → `content_block_*` → `message_delta` → `message_stop`), with partial-JSON accumulation for streaming tool calls. `delta.reasoning_content` is dropped (most Claude Code UIs don't render it).
- **Never-stuck guarantee**: a stream watchdog fires `WatchdogTimeoutError` on first-byte / inter-chunk gap, the circuit breaker reroutes to OAuth Sonnet after N consecutive failures, and every code path emits a terminal `message_stop` event in a `finally` block so Claude Code can never wait forever.

## Tests

```bash
bun test     # 50 unit tests, sub-second
```

Covers request translation, response translation, SSE streaming with tool calls, schema contracts, circuit breaker, watchdog, fallback, OAuth header injection.

## Limitations / gotchas

- **macOS only** for now. The Keychain shell-out is the non-portable piece; a Linux variant reading `~/.claude/.credentials.json` is straightforward but unwritten.
- **Plan-mode auto-detection requires the hook**. Plan mode leaves no trace in the API request — without `forky-hook` wired into Claude Code settings, you'll need `forky-opus on/off` for manual switching.
- **Claude Code's `/model` picker stays disabled** because `ANTHROPIC_BASE_URL` is set. opusplan-style behavior comes from the hook + sentinel mechanism, not Claude Code's built-in alias.
- **Tool-call fidelity depends on your execution model**. Models that mis-format tool arguments get their malformed calls dropped with a `[forky: dropped malformed tool call ...]` text note rather than emit invalid JSON. Stronger function-calling models give better UX.
- **`context_management` body field** is stripped on the OAuth path — Anthropic's OAuth endpoint 400s on it. Claude Code's local context auto-edit still works; only the API-side context-management feature is disabled.

## Terms of service note

Anthropic's [Terms of Service](https://www.anthropic.com/legal) restrict OAuth tokens to "Claude Code and claude.ai." forky's design forwards the OAuth token only on behalf of Claude Code itself (a transparent local proxy), and execution traffic uses an unrelated API key — but Keychain extraction could plausibly be argued as circumvention. Use at your own risk. Keep the proxy bound to `127.0.0.1`, never share tokens, and don't use this in production or multi-user environments.

## License

MIT — see [LICENSE](LICENSE).
