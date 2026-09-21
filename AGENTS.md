## What this is

Aira is a local-first personal AI assistant harness. It does not implement its own LLM — it routes
requests between locally hosted models (served via MLX at `http://127.0.0.1:8080/v1`, see
`src/models/local-model.ts`), evaluates answers, retrieves/writes memory, and runs a bounded
model-driven tool loop (including read-only GitHub repository investigation over MCP).

## Commands

```bash
npm run check          # format:check + typecheck + test — run this before considering work done
npm test                # node --test over tests/*.test.mjs (fast, no model server required)
npm run typecheck       # tsc --noEmit
npm run format          # prettier --write src/**/*.ts
npm start               # start the interactive CLI (requires local MLX model server running)
```

Run a single test file directly:

```bash
node --import tsx --test tests/tool-loop.test.mjs
```

Live checks require a running local model server (and some require GitHub credentials). These are
separate from `npm run check`, which uses fake models/synthetic fixtures and needs no server:

```bash
npm run check:evidence [-- fast|reasoning] [--report]   # evidence-assessment prompt regression
npm run compare:evidence -- baseline.json candidate.json
npm run check:tool-loop [-- fast|reasoning]              # live tool-loop with synthetic in-process tools
npm run check:approval                                   # exercise the approval prompt with the local echo fixture
npm run check:github -- <owner/repo> [--model path] [--loop] [--evaluate path]  # GitHub MCP integration checks
```

`npm run check:github` requires `AIRA_GITHUB_TOKEN` (or an existing `gh auth login` session).
`npm start` with the GitHub server configured does not: if `AIRA_GITHUB_TOKEN` is unset, that
server is skipped with a console warning and the rest of Aira (including any other configured
MCP servers) still starts normally. `aira.mcp.json` (git-ignored) configures MCP servers on
startup; copy `aira.mcp.example.json` or `aira.mcp.github.example.json` to try one.

## Architecture

Request flow through `src/index.ts` (`handleConversation`), in order:

1. **Conversation memory** (`conversation-memory.ts`) — recent verbatim turns + a rolling summary.
   Summarization triggers when limits are exceeded and is transactional: old turns are only dropped
   after the new summary is produced (`llm-conversation-summarizer.ts`, uses the `memory` model role).
2. **Long-term memory** (`long-term-memory.ts`, `memory-manager.ts`, `embedding-service.ts`,
   `memory-reranker.ts`, `memory-context-builder.ts`) — persisted to `long-term-memory.json`.
   Retrieval combines semantic similarity with importance/freshness/confidence/source-reliability
   scoring, then an LLM reranks candidates. Memories can be superseded, keeping active vs. historical
   state so Aira can answer both "what is true now" and "how did this change."
3. **Routing** (`router.ts`, `routing-rules.ts`) — picks `fast` vs `reasoning` model role;
   confidence below 0.75 (or a non-`fast` route) escalates to `reasoning`.
4. **Tool loop** (`src/tools/tool-loop.ts`, `tool-runner.ts`, `tool-selector.ts`) — up to 3
   selection/execution steps per turn. Each step: model selects at most one tool (or none), Ajv
   validates arguments against the tool's JSON Schema (draft-07, no coercion/defaults), the tool
   approval gate runs (`tool-approval.ts`), then execution. After each successful result, an
   evidence evaluator (`tool-result-evaluator.ts`) judges `sufficient`/`insufficient`/`blocked` to
   decide whether to keep gathering. The loop stops on 3 steps, a repeated identical call, an
   invalid decision, a tool failure, or a context-character budget limit. Same pattern is reused
   by `RepositoryInvestigator`/`RepositoryPlanner` (`src/tools/repository-*.ts`) for the
   `/plan` and `/investigate` GitHub-repository commands, with their own step/character/time budgets.
5. **Answer generation and evaluation** (`answer-generator.ts`, `llm-evaluator.ts`) — the fast
   model answers first; `LlmEvaluator` (using the `reasoning` model) scores it. Accept requires
   `passed: true` and score ≥ 0.8. One retry is allowed on the fast model reusing the same tool
   evidence; a second failure or an `escalate` decision hands off to the reasoning model once
   (not re-evaluated). Malformed/contradictory evaluator output forces escalation rather than
   being coerced into acceptance.
6. Only the final displayed answer is written back into conversation memory; long-term memory
   processing (`memoryManager.process`) happens after the answer is shown.

**Model roles** (`src/models/model-registry.ts`): `fast` (Qwen3-14B) handles general answers,
routing, tool selection, and memory tasks; `reasoning` (Qwen3-32B) handles escalated answers and
answer evaluation; `memory` (Qwen3-14B) handles summarization and reranking. All roles currently
point at the same local MLX server; swapping models means editing `ModelRegistry`.

**Tools** (`src/tools/`): `Tool` (`tool.ts`) is the common interface; `ToolRunner` enforces approval
uniformly for any tool (built-in or MCP) whose `definition.requiresApproval` is `true`, or whose
`requiresApproval` function returns `true` for the given input — it is not special-cased per
source. `current-time-tool.ts` is a built-in tool that runs without approval.
`browser-tool.ts` is a built-in tool that requires approval per-command (read-only commands like
`snapshot`/`get`/`is`/`extract`/`read`/`screenshot` run automatically; everything else always
requires approval, with no override): it shells out to the external
`llm-browser` CLI (`child_process.execFile`, no shell interpolation) to drive a persistent
SeleniumBase browser session. `isBrowserCliAvailable()` runs `llm-browser --version` at startup
(`src/index.ts`); only `ENOENT` skips registration (with a console warning) — any other failure
still registers the tool so it fails per-call instead of silently. Its single `browser` tool definition uses a draft-07 `oneOf` schema
keyed on a `command` field (open/click/fill/type/get/extract/snapshot/... — see the file for the
full list) so Ajv validates each command's exact required arguments, rather than accepting a loose
argument bag. `screenshot` always forces the CLI's `--stdout` flag internally and never accepts a
model-supplied file path, so it can't be used to write to an arbitrary filesystem location.
`web-search-tool.ts` is a second `llm-browser`-backed built-in tool, wrapping just the CLI's
`search <engine> <query>` shortcut (google/bing/duckduckgo/ddg/reddit/hn/github) for plain research
lookups; it never requires approval and shares `browser`'s persistent session. Registered alongside
`browser` behind the same `isBrowserCliAvailable()` PATH check.
MCP-provided tools (`mcp-connection.ts`, `mcp-session.ts`, `mcp-config.ts`) are loaded from
`aira.mcp.json` at startup and namespaced by server (e.g. `local/echo`, `github/get_file_contents`).
Approval policy for MCP servers defaults to per-call confirmation; a server config can set
`"requireApproval": false` and per-tool `toolApproval` overrides — precedence is per-tool override
> server `requireApproval` > default `true`. The approval gate lives in `ToolRunner`, not in
`Tool.execute` — any new caller invoking tools directly must enforce approval itself. GitHub access
is read-only and allowlisted to `get_file_contents`, `list_branches`, `list_commits`, `get_commit`.

**Cancellation**: a single `AbortController` in `src/index.ts` is wired to SIGINT/SIGTERM and
threaded through model requests, tool execution, and MCP calls via `cancellation.ts`'s
`abortable`/`createDeadline` helpers. Conversation turns are processed serially (one `for await`
loop over stdin) so tool calls and memory updates never overlap.

## Conventions worth knowing

- ESM throughout (`"type": "module"`), TypeScript with `verbatimModuleSyntax`/`isolatedModules` —
  intra-repo imports use explicit `.js` extensions even though source files are `.ts`.
- Tests are `tests/*.test.mjs` run directly under Node's built-in test runner via `tsx`, not a
  separate test framework — they import compiled-at-runtime TS via `tsx`'s loader.
- Diagnostics are deliberately verbose stdout logging (`[Tools]`, `[Tool selection]`,
  `[Memory diagnostics]`, `[Router]`, etc.) rather than a logging library — keep this pattern when
  adding new phases so behavior stays observable from the CLI.
- Model-facing evaluator feedback (reasons/explanations) is deliberately *not* forwarded to
  subsequent model calls, only the decision/action — this prevents untrusted tool output or model
  explanations from being echoed back as instructions in a later step.
