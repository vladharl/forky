# qwen → gemma rectifier chain

A design + evaluation brief for the two-model architecture forky uses to make a strong-but-XML-leaky model (qwen-35b) and a small-but-format-correct model (gemma-micro) work together as an execution backend behind Claude Code.

This doc is self-contained. Hand it to a fresh Claude on another device and ask: *"is this design feasible, are there obvious failure modes I missed, and what's the cleanest implementation?"*

---

## 0. Glossary

- **Primary model**: the strong reasoner that decides what to do. Here: `qwen-35b` (Qwen family, ~35B params with active 3B, 128K context).
- **Reformatter model**: a smaller model used only to fix the primary's malformed tool calls. Here: `gemma-micro` (Gemma-family, fast, strong at OpenAI function-calling).
- **Claude Code**: Anthropic's CLI/IDE coding agent. Sends Anthropic Messages API requests (with `tools[]`) and expects responses with structured `tool_use` content blocks.
- **forky**: a local proxy at `127.0.0.1:3456` that intercepts Claude Code's requests, routes them to one of: Anthropic OAuth (planning), or a configurable OpenAI-compatible endpoint (execution).
- **Tool call**: a structured invocation of a function the agent has access to (Read, Write, Bash, Edit, etc.). The "proper" wire format is OpenAI's `tool_calls` array: `[{id, type: "function", function: {name, arguments: json_string}}]`. The "leaky" format is Anthropic's internal XML: `<function_calls><invoke name="X"><parameter name="Y">value</parameter></invoke></function_calls>` (or a short form `<ToolName attr="value">`).

---

## 1. Problem statement

Claude Code's system prompt contains worked examples of tool invocations written as XML (`<function_calls>…</function_calls>`), because that's how Claude itself was trained to call tools internally. When you route Claude Code traffic through a non-Anthropic model (qwen, llama, etc.) via an OpenAI-compatible API, the model **mimics the XML format** instead of using the OpenAI `tool_calls` field. The XML lands in the response's content as plain text. Claude Code receives it as a regular assistant message, displays it to the user, and **never executes the tool**.

Observed across multiple test sessions:
- qwen-35b: ~100% XML on tool turns when given Claude Code's system prompt
- qwen-27b: same behavior
- gemma-micro: ~0% XML — uses `tool_calls` correctly even under the same XML-priming
- gpt-4o-mini, claude-haiku: also use `tool_calls` correctly

So we have a strong model that won't format tool calls correctly, and a small model that will. The user wants the strong model to do the reasoning but the small model to format.

---

## 2. Proposed architecture

```
              Claude Code  ─── Anthropic Messages API ──►  forky :3456
                                                              │
                                                              ▼
                                                     [translate Anthropic
                                                       Messages → OpenAI
                                                       Chat Completions]
                                                              │
                                                              ▼
                                            ┌─► PRIMARY: qwen-35b (non-streaming)
                                            │
                                            │       returns: text content with
                                            │       <function_calls>…</function_calls>
                                            │       in the content, often with
                                            │       wrong parameter names
                                            │
                                            ▼
                                  ┌────────────────────────────────┐
                                  │  XML-shape detector            │
                                  │  (regex: <function_calls>,     │
                                  │   <invoke name=, <ToolName )   │
                                  └────────────────────────────────┘
                                            │
                            ┌───────────────┴──────────────┐
                            ▼                              ▼
                     XML detected                  No XML detected
                            │                              │
                            ▼                              │
              ┌──────────────────────────┐                 │
              │ REFORMATTER: gemma-micro │                 │
              │                          │                 │
              │ system: "you are a       │                 │
              │ rectifier; here are the  │                 │
              │ tools, here's the bad    │                 │
              │ output; emit proper      │                 │
              │ tool_calls"              │                 │
              │                          │                 │
              │ returns: {content,       │                 │
              │   tool_calls[…]}         │                 │
              └──────────────────────────┘                 │
                            │                              │
                            └──────────────┬───────────────┘
                                           ▼
                              [synthesize Anthropic SSE
                               event stream from the
                               final {content, tool_calls}]
                                           │
                                           ▼
                                      Claude Code
                                  (sees proper tool_use,
                                   auto-executes the tool)
```

### Why this works

1. **qwen does the reasoning** — picks the right tool, supplies the right intent. It just expresses that intent in the wrong wire format.
2. **gemma is given the original tool schemas** + qwen's mangled output and asked to extract structured calls. Since gemma's training favours OpenAI tool_calls and it's not "infected" by the XML examples in the bulk system prompt (it only sees a short rectifier prompt), it emits clean `tool_calls`.
3. **gemma can fix parameter name mismatches**: qwen often writes `<Read path="...">`; the Read tool schema requires `file_path`. gemma sees the schema, sees `path`, infers the mapping, emits `{"file_path": "…"}`.
4. **Trade-off accepted**: token-level streaming is lost during the primary's turn (qwen finishes before forky emits anything), but tool calls actually execute. For tool-heavy workflows, this is the right trade.

---

## 3. Test cases

These are **specification fixtures**, not necessarily runnable as-is. Each describes an input the rectifier might see and the expected output, plus what the broader pipeline should produce.

### Fixture format

Every fixture is structured as:

```yaml
name: <short slug>
description: <one-line summary>
declared_tools:
  - name: <ToolName>
    schema: { … OpenAI parameters JSONSchema … }
primary_output:
  content: <string — what qwen returned in message.content>
  tool_calls: <null | array — what qwen returned in message.tool_calls>
expected_after_rectify:
  content: <string — narrative text, no tool XML>
  tool_calls:
    - id: <opaque>
      function: { name: <ToolName>, arguments: <JSON string of args> }
notes: <anything tricky>
```

---

### T1 — Simple short-form (the most common case)

```yaml
name: short-form-single-tool
description: qwen emits one tool call as a self-closing XML tag with the wrong param name
declared_tools:
  - name: Read
    schema:
      type: object
      properties: { file_path: { type: string } }
      required: [file_path]

primary_output:
  content: |
    Let me check that file.
    <Read path="/tmp/foo.txt">
  tool_calls: null

expected_after_rectify:
  content: "Let me check that file."
  tool_calls:
    - id: <any-non-empty-string>
      function:
        name: Read
        arguments: '{"file_path": "/tmp/foo.txt"}'

notes: |
  Reformatter must (a) map `path` → `file_path` from the schema, and
  (b) strip the XML tag from the narrative content. The trailing `>` and
  surrounding whitespace should not leak into either side.
```

### T2 — Long-form (Claude's canonical training format)

```yaml
name: long-form-canonical
description: full <function_calls><invoke><parameter> XML, parameter names already correct
declared_tools:
  - name: Bash
    schema:
      type: object
      properties:
        command: { type: string }
        timeout: { type: integer }
      required: [command]

primary_output:
  content: |
    Running:
    <function_calls>
    <invoke name="Bash">
    <parameter name="command">ls -la /tmp</parameter>
    <parameter name="timeout">5000</parameter>
    </invoke>
    </function_calls>
  tool_calls: null

expected_after_rectify:
  content: "Running:"
  tool_calls:
    - id: <any>
      function:
        name: Bash
        arguments: '{"command": "ls -la /tmp", "timeout": 5000}'

notes: |
  Integer parameters must be parsed as JSON numbers, not strings.
  Implementations that string-quote everything will fail Claude Code's
  schema validation on Bash.
```

### T3 — Multiple tool calls in one response

```yaml
name: multi-tool-mixed-forms
description: two tool invocations in one response, mixing long and short forms
declared_tools:
  - name: Read
    schema: { type: object, properties: { file_path: { type: string } }, required: [file_path] }
  - name: Bash
    schema: { type: object, properties: { command: { type: string } }, required: [command] }

primary_output:
  content: |
    Let me read the config and then list the directory.

    <Read path="/etc/app/config.yaml">

    Then:

    <function_calls>
    <invoke name="Bash">
    <parameter name="command">ls /etc/app</parameter>
    </invoke>
    </function_calls>
  tool_calls: null

expected_after_rectify:
  content: "Let me read the config and then list the directory."
  tool_calls:
    - id: <any>
      function: { name: Read, arguments: '{"file_path": "/etc/app/config.yaml"}' }
    - id: <any>
      function: { name: Bash, arguments: '{"command": "ls /etc/app"}' }

notes: |
  Order must be preserved (Read before Bash). The "Then:" connective
  text between the two invocations should be dropped, kept, or merged
  — implementer's choice, but be consistent. Recommendation: drop
  connective tissue that has no standalone meaning.
```

### T4 — Already-correct response (no rectification needed)

```yaml
name: already-correct-passthrough
description: primary occasionally uses tool_calls properly; pipeline must not double-process
declared_tools:
  - name: Read
    schema: { type: object, properties: { file_path: { type: string } }, required: [file_path] }

primary_output:
  content: "Here's the contents."
  tool_calls:
    - id: call_abc123
      function: { name: Read, arguments: '{"file_path": "/tmp/x"}' }

expected_after_rectify:
  content: "Here's the contents."
  tool_calls:
    - id: call_abc123
      function: { name: Read, arguments: '{"file_path": "/tmp/x"}' }

notes: |
  The XML-shape detector should NOT fire on this content (no XML).
  Reformatter must not be called. Pipeline cost: only the primary's
  one API call.
```

### T5 — XML pattern in content that is NOT a tool call

```yaml
name: false-positive-xml-in-prose
description: model writes about XML or uses tags in markdown, not actually invoking
declared_tools:
  - name: Read
    schema: { type: object, properties: { file_path: { type: string } }, required: [file_path] }

primary_output:
  content: |
    The XML format looks like `<Read path="...">` but you should
    use the proper tool_calls field instead. Here's a <div> example
    of HTML inline in markdown.
  tool_calls: null

expected_after_rectify:
  content: |
    The XML format looks like `<Read path="...">` but you should
    use the proper tool_calls field instead. Here's a <div> example
    of HTML inline in markdown.
  tool_calls: null

notes: |
  Critical: the detector must distinguish "talking about a tool"
  from "invoking a tool". Heuristic: if the apparent tool tag is
  inside a code block (backticks), do not treat as invocation.
  Implementations that detect blindly will mangle harmless prose.
  Suggested: detector should match `<ToolName` only when at the
  start of a line or preceded by whitespace, and not within
  backticks/fenced code blocks.
```

### T6 — Parameter mismatch beyond a name rename

```yaml
name: param-shape-mismatch
description: qwen invents a parameter that doesn't exist in the schema
declared_tools:
  - name: Edit
    schema:
      type: object
      properties:
        file_path: { type: string }
        old_string: { type: string }
        new_string: { type: string }
      required: [file_path, old_string, new_string]

primary_output:
  content: |
    <Edit file="src/foo.ts" find="const x" replace="const y" reason="cleanup">
  tool_calls: null

expected_after_rectify:
  content: ""
  tool_calls:
    - id: <any>
      function:
        name: Edit
        arguments: '{"file_path": "src/foo.ts", "old_string": "const x", "new_string": "const y"}'

notes: |
  Reformatter must map:
    file → file_path
    find → old_string
    replace → new_string
  and DROP `reason` (no matching schema property). Tools that fail
  schema validation are silently swallowed by Claude Code — bad UX.
  If the rectifier can't confidently map all required params, the
  recommended behaviour is: emit no tool_call and surface the
  problem in content (e.g. "[rectifier: could not map Edit args]").
```

### T7 — Empty content, structured output absent

```yaml
name: empty-response
description: primary returned nothing useful
declared_tools:
  - name: Read
    schema: { … }

primary_output:
  content: ""
  tool_calls: null

expected_after_rectify:
  content: ""
  tool_calls: null

notes: |
  Detector should not fire. Pipeline should pass through as a single
  empty assistant turn. Downstream Anthropic SSE synthesizer should
  emit a valid empty message with stop_reason: end_turn (NOT crash
  on the empty content block).
```

### T8 — Mixed content: narrative + XML interleaved at multiple positions

```yaml
name: interleaved-narrative
description: qwen alternates prose and tool calls multiple times
declared_tools:
  - name: Read
    schema: { type: object, properties: { file_path: { type: string } }, required: [file_path] }

primary_output:
  content: |
    First I'll look at the entry point.
    <Read path="src/index.ts">
    Then the config:
    <Read path="config.yaml">
    Finally I'll check the tests.
    <Read path="tests/index.test.ts">
  tool_calls: null

expected_after_rectify:
  content: |
    First I'll look at the entry point.
    Then the config:
    Finally I'll check the tests.
  tool_calls:
    - id: <any>
      function: { name: Read, arguments: '{"file_path": "src/index.ts"}' }
    - id: <any>
      function: { name: Read, arguments: '{"file_path": "config.yaml"}' }
    - id: <any>
      function: { name: Read, arguments: '{"file_path": "tests/index.test.ts"}' }

notes: |
  Narrative interleaved with tool calls. Order matters: tool execution
  should happen in the order qwen specified. The narrative is folded
  into a single text block (Anthropic accepts content_blocks of
  [text, tool_use, text, tool_use, …] but most rendering UIs prefer
  [text, tool_use, tool_use, tool_use, …] — pick the latter for
  simplicity unless you have a reason not to).
```

### T9 — Unknown tool name in XML

```yaml
name: unknown-tool-name
description: primary hallucinates a tool that wasn't declared
declared_tools:
  - name: Read
    schema: { … }

primary_output:
  content: |
    <Mystery do="something">
    <Read path="/tmp/x">
  tool_calls: null

expected_after_rectify:
  content: ""
  tool_calls:
    - id: <any>
      function: { name: Read, arguments: '{"file_path": "/tmp/x"}' }

notes: |
  Unknown tool names should be silently dropped (NOT passed through
  to Claude Code, which would 400 on the unknown name). Logging
  them is fine. The known Read still gets through.
```

### T10 — Large file context (cost edge)

```yaml
name: large-file-cost
description: not a correctness test — a cost-shape test
declared_tools:
  - name: Edit
    schema: { … }

primary_output:
  content: |
    <Edit file_path="src/big.ts" old_string="..." new_string="...">
    [imagine this is a 30K-token old_string]
  tool_calls: null

expected_after_rectify:
  content: ""
  tool_calls:
    - id: <any>
      function: { name: Edit, arguments: '{"file_path": "src/big.ts", "old_string": "...", "new_string": "..."}' }

notes: |
  Rectifier input includes the FULL primary output (potentially huge).
  Cost = ~input_tokens(primary_output) + small system prompt.
  Mitigation #1: cache the rectifier system prompt with cache_control
  (Anthropic ephemeral or persistent). Mitigation #2: when primary
  output is very large, consider rectifying only the head/tail
  containing XML tags rather than the whole content. Open question:
  does this break correctness?
```

---

## 4. Open questions for the implementer

1. **Detector precision vs recall**. The simplest detector (`indexOf("<function_calls>")` || tool-name regex) has false positives (T5). What's the right precision/recall trade-off? Should the detector be a tiny regex, a real XML parser, or a learned classifier?

2. **Streaming**. The current design loses token-level streaming during the primary's turn. Is it possible to start streaming text-only deltas to the client, detect XML mid-stream, hold back, run the rectifier, then emit corrected tool blocks? Worth the complexity?

3. **Cost ceiling**. Every rectifier call is `input_tokens(primary_output) + ~500 system`. With prompt caching, the system part is amortized. But the primary output can be 10K+ tokens for tool-heavy turns. Should there be a per-session quota / circuit breaker on rectifier calls?

4. **Rectifier failure modes**. What if the rectifier itself returns garbage (hallucinates extra tool calls, drops calls, returns invalid JSON)? Current design: fall back to passing through primary's original output (which contains XML and won't execute). Is there a better fallback?

5. **Multi-tool ordering**. T3 / T8 show order-preservation matters. Does the OpenAI Chat Completions response shape (`tool_calls: [...]`) guarantee execution order? Verify with each backend.

6. **Schema-aware rectification**. The rectifier model needs the tool definitions to map parameter names (T1, T6). Does passing them in the rectifier's `tools` field help, or should they be inlined into the rectifier's system prompt? Test both.

7. **Different primary models**. The design assumes qwen-style XML emission. What if the primary is a different model that emits some other malformed format (TOML? Hermes-style JSON-inside-tags? Markdown headers)? Should the rectifier be format-agnostic, or specialized per primary?

8. **Latency budget**. End-to-end: primary (2-10s) + rectifier-when-needed (1-3s) = 3-13s per turn. Acceptable for IDE coding? Probably yes for tool-heavy work, marginal for chatty Q&A.

9. **Alternative architectures to compare against**:
   - **Pure detector + deterministic XML parser** (no second model). Pros: no extra LLM call. Cons: brittle, can't fix wrong param names.
   - **Use a stronger primary** (gpt-4o-mini, claude-haiku). Pros: no rectifier needed. Cons: not always available, may have its own quirks.
   - **Fine-tune the primary** on OpenAI tool-calling examples to override the XML mimicry. Pros: clean. Cons: lots of work, model-specific.
   - Worth comparing on: correctness, latency, cost, complexity.

10. **Operator visibility**. What metrics matter? Suggested: rectifier-fire-rate per session, mean primary-output tokens, mean rectifier-output tokens, rectifier-success-rate (did it produce parseable tool_calls?), cache hit rate.

---

## 5. Suggested implementation path (for the evaluator)

The current implementation in this repo (`src/translate/reformat.ts` + `src/aistack.ts:dispatchWithRectifier`) does:

1. Lightweight string-match detector (`looksLikeXmlToolCall`).
2. Non-streaming primary call.
3. If detector fires, send primary's content to reformatter as a user message, with declared tools as `tools[]` and a fixed rectifier system prompt.
4. Replace primary's `tool_calls` with reformatter's `tool_calls` (preserve content from reformatter, which has the XML stripped).
5. Synthesize Anthropic SSE event stream from the final `{content, tool_calls}`.
6. Total opt-in: only active when `EXEC_REFORMAT_MODEL` env is set.

For an independent evaluation, I'd suggest:

1. Read `src/translate/reformat.ts` (~85 lines) and `src/aistack.ts:dispatchWithRectifier` (~110 lines) to see the current shape.
2. Build a test runner that takes the fixtures above (T1-T10) and runs both detector and end-to-end pipeline against real backend calls. Record:
   - did the detector fire correctly?
   - did the rectifier produce the expected `tool_calls`?
   - was the cost (tokens) within budget?
3. Identify cases where the current implementation fails or is brittle — those are the highest-value improvements.
4. Then audit the open questions in section 4 and propose answers backed by the test data.

---

## 6. What forky's owner cares about

This isn't an academic exercise — there's a working system that real users (well, one user) depend on. Practical priorities:

- Don't break the working path (T4: pure passthrough must remain fast and correct).
- Detector false positives (T5) are worse than false negatives — a false positive mangles harmless prose; a false negative leaves XML in content and Claude Code displays it as text (annoying but recoverable).
- Cost should remain manageable: ~+25-50% Opus token usage relative to a "no review" baseline is the rough budget already in play.
- Implementation should be ~200-400 LOC additional. Anything heavier needs to justify itself with concrete bug fixes.
