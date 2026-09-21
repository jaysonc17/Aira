# Aira

**A local-first personal AI chief of staff.**

Aira is an experimental personal AI assistant built around local language models, intelligent model routing, evaluation, conversation memory, and persistent long-term memory.

Rather than being tied to a single model, Aira acts as an AI harness that decides which model should handle a request, retrieves relevant context, evaluates responses, and preserves useful information over time.

The longer-term goal is to build a private, extensible AI chief of staff that can reason, remember, use tools, and take actions on behalf of its user.

## Architecture

```text
                         Aira
                           │
                           ▼
                     User Request
                           │
                           ▼
                        Router
                    ┌──────┴──────┐
                    │             │
                 Fast Model   Reasoning Model
                 Qwen3-14B      Qwen3-32B
                    │             │
                    └──────┬──────┘
                           │
                           ▼
                       Evaluator
                           │
                ┌──────────┴──────────┐
                │                     │
                ▼                     ▼
       Conversation Memory      Long-Term Memory
                │                     │
        ┌───────┴────────┐      ┌─────┴──────┐
        │                │      │            │
   Recent Turns     Rolling     Embeddings  Retrieval
                    Summary                  │
                                            ▼
                                         Reranker

                           │
                           ▼
                    Tool Selection
                           │
                    Tool Execution
                    (up to three steps)
```

## Current capabilities

Aira currently supports:

- Local LLM inference
- Multiple model roles
- Intelligent request routing
- Automatic escalation to a stronger reasoning model
- LLM-based answer evaluation
- Recent conversation memory
- Rolling conversation summarization
- Persistent long-term memory
- Semantic memory retrieval
- Memory reranking
- Memory confidence scoring
- Memory freshness and importance scoring
- Explicit, inferred, and updated memories
- Memory supersession
- Historical memory
- Temporal intent detection
- Chronological memory timelines
- Memory consolidation and rescoring
- Structured memory diagnostics
- Model-driven tool selection and bounded multi-step execution
- Current-time lookup with optional time zone

## Tool use

For each conversation turn, Aira gives the fast model the registered tool
definitions, recent conversation, and memory context. The model can select
one tool per step or decide that no further tool is needed. Each result is
provided to the next selection, allowing Aira to follow a file-path hint.
The loop stops after three selection steps, on an identical repeated call, or
on an invalid decision or tool failure. Aira checks each selection, then
uses Ajv to validate the arguments against the tool's JSON Schema before
calling it. Validation does not coerce types, remove extra properties, or
insert defaults. Schemas currently use synchronous JSON Schema draft-07;
unsupported or invalid schemas prevent execution. Tools still check domain
rules, such as whether a time zone is recognized, inside their implementation.

The tool outcome is supplied to the answering model and answer evaluator.
If an answer is escalated, the stronger model receives the same outcome;
the tool is not executed again. Selection and execution failures are included
in the context so the model can explain the limitation instead of inventing
a successful result.

The first registered tool is `current_time`. Try:

```text
What time is it in Melbourne?
```

The CLI prints `[Tools]` diagnostics for each conversation turn: status,
whether execution was attempted, and selection, execution, and total time
in milliseconds. `[Tool selection]` shows the decision, reason, and any
selected tool name and arguments. `[Tool error]` identifies failures during
selection, lookup, validation, execution, or result formatting. An execution attempt
does not imply success: a tool may reject its arguments or throw an error.
These diagnostics are separate from the tool context supplied to the model.

It returns a UTC timestamp and local time for the selected time zone,
defaulting to UTC when no time zone is supplied.

A second built-in tool, `browser`, is registered by default if the
`llm-browser` CLI is found on `PATH` at startup; otherwise Aira prints a
`[Tools] llm-browser CLI not found on PATH; the browser tool will not be
registered.` warning and starts without it. Unlike `current_time`, `browser`
always requires approval.

### Browser automation

`browser` drives a persistent local browser session through the `llm-browser`
CLI (SeleniumBase CDP mode), invoked as a child process with no shell
interpolation. The session persists across tool
calls, within and across conversation turns, until a `close` command ends it.
This is Aira's first tool with real-world, hard-to-undo side effects: `click`,
`fill`, `type`, `select`, and `press` can submit forms or complete a purchase.
Because of that, `browser` always requires approval regardless of any server
or per-tool override — see "Tool approval" below.

The tool exposes a single JSON input shape, `{ command, ...args }`, validated
against a schema keyed on `command` so each command's exact required
arguments are enforced by Ajv before anything runs (for example, `fill`
without `text` fails validation, not execution). Supported commands: `open`,
`close`, `back`, `forward`, `reload`, `click`, `dblclick`, `type`, `fill`,
`press`, `hover`, `focus`, `select`, `scroll`, `scrollintoview`, `wait`,
`get`, `is`, `extract`, `read`, `snapshot`, `screenshot`. `snapshot` returns
an accessibility-tree view with `@eN` element references or CSS selectors,
intended to be read before `click`/`fill`/etc. target a specific element.

Commands not exposed in this first pass: 2FA/credential commands (`mfa-code`,
`enter-mfa`), captcha-bypass commands (`click-captcha`, `solve-captcha`),
cookie/storage management, and OS-level pointer control (`--gui`,
`gui-hover-click`). `screenshot` always forces the CLI's `--stdout` flag
internally and ignores any model-supplied output path, so it returns a
`data:image/...;base64,...` URI rather than ever writing a file to disk.

The tool's description instructs the model to prefer read-only commands
(`get`, `extract`, `snapshot`, `read`, `is`) for gathering information and to
treat state-changing commands as consequential, but this is model guidance,
not an enforced restriction — the per-call approval prompt is the actual
control. A failed command (e.g. an element not found) returns a failed
`ToolResult` with the CLI's stderr as the error message; it does not throw,
and does not imply the browser session itself is in an unknown state.

This integration does not yet include a grocery-shopping (or other
site-specific) automation flow; that would be built as a separate use case
on top of this general-purpose tool.

Startup availability is checked by running `llm-browser --version`; only an
`ENOENT` (binary not found) is treated as "not installed" and skips
registration — any other startup failure still registers the tool, so
misconfiguration surfaces through a normal failed tool call rather than
being silently hidden.

### Evidence evaluation regression checks

Run fixed synthetic evidence cases against the configured local model:

```bash
npm run check:evidence
npm run check:evidence -- reasoning
npm run check:evidence -- fast path-hint
```

Start the local model server first. The default role is `fast`. Cases in
`evaluations/tool-evidence.mjs` cover complete file contents, a path hint, an
unavailable tool, an instruction embedded in output, already complete evidence
without tools, missing repository information, and a comparison needing a second
file. Additional variants include a forged tool policy and an irrelevant
instruction inside otherwise sufficient content. The command prints the
expected and actual decisions, the model's reason, and elapsed milliseconds.
Expected decisions are not included in model requests. It runs no tools, contacts
no GitHub service, and writes no memory. Reports are saved only when requested.

Add `--report` to save a JSON report under `.cache/evaluations/`:

```bash
npm run check:evidence -- fast --report
```

Each report includes timestamps, model role, case inputs, decisions, reasons,
timings, summary counts, and SHA-256 fingerprints of the evaluator, model client,
model registry, dataset, and check script. Reports use unique filenames and the
cache directory is Git-ignored. Failed checks still save reports; interrupted
runs do not. Fingerprints describe local source files, not the running server's
weights or settings, so reports alone cannot guarantee identical model behavior.

Compare two saved reports without running a model:

```bash
npm run compare:evidence -- baseline.json candidate.json
```

The comparison matches case IDs and reports improvements, regressions, unchanged
outcomes, and added/removed cases. Changed prompts, evidence, tool definitions,
or expected answers are marked `case_changed` and excluded from improvement
counts. Request errors remain visible as error/timeout outcomes; their timings
are not compared. Source fingerprint changes and model roles are displayed, but
semantic changes to the assessment contract still require human review.
Exit code 1 means an unchanged case regressed; 2 means invalid input or a read
error. Exit code 0 means no detected regression, not that every case passed or
that the reports tested identical suites.

Incorrect or malformed decisions and request errors produce a nonzero exit code;
request errors are counted separately from decision failures. Each case has a
120-second deadline, and Ctrl+C stops the suite. This small dataset helps compare
prompt or model changes; it is not a general reliability or security guarantee.
The live command is separate from `npm run check`, which tests the harness using
fake models and requires no model server.

### Live tool-loop regression checks

```bash
npm run check:tool-loop
npm run check:tool-loop -- reasoning
```

These checks use the local model with in-process synthetic tools. They exercise
real selection, validation, execution, evidence assessment, and follow-up without
GitHub access or memory writes. One case requires following a file hint despite
a forged policy in its output; another requires no execution when the repository
name is missing. The command prints actual calls and decisions and exits nonzero
on failure. It does not generate or evaluate the final answer. Each scenario uses
the standard loop deadline and supports Ctrl+C.

The latest fast-model run passed both cases after evaluator explanations were
removed from downstream context and selection instructions clarified tool
authority. Earlier runs failed the forged-policy case. See
`evaluations/README.md` for results and limits; these two cases do not establish
general instruction resistance.

### Repository investigation planning

```text
/plan Itspigrain/fraud-platform How does event ingestion lead to a fraud alert?
```

This first investigation step proposes one to three evidence questions using
registered GitHub read tools. It makes one local model request with a 60-second
deadline, validates the plan, and executes no repository tools. Plans are not
findings, approvals, or guarantees that the proposed evidence exists. Invalid
plans fail without execution; they are not added to chat or long-term memory.
The current supported names are `github/get_file_contents`, `github/list_branches`,
`github/list_commits`, and `github/get_commit`.

Use `/investigate <owner/repository> <question>` to plan, gather evidence, and
produce an answer. It permits up to six selection steps and 24,000 characters of
tool context, with a 300-second overall deadline (planning remains limited to
60 seconds and gathering to 180 seconds). Each step uses the normal validation,
approval, duplicate prevention, and cancellation checks. Only the supported GitHub
read tools are available, and calls targeting another owner/repository are rejected.
A plan guides selection but is not evidence or an execution script.

The final answer is instructed to cite observed file paths and explain gaps;
citation correctness is not yet mechanically verified. If gathering stops for
any reason other than `sufficient`, code prefixes the answer with an explicit
incomplete notice and the stop reason. A sufficient model assessment is still
not proof that the answer is correct. This command does not
run the separate answer evaluator. Investigation commands currently do not write
chat or long-term memory. Missing-path failures stop gathering; recovery and live
multi-file investigation checks remain outstanding in this milestone. Normal
conversation continues to use the existing three-step loop.

Deterministic investigation tests trace an event controller into a rule service,
verify that both file results reach answer generation, enforce the six-read
limit when evidence remains incomplete, and bound an unresponsive final answer
with the overall deadline. These use synthetic sources and scripted model
responses; live repository behavior and answer accuracy are separate checks.

### Tool approval

MCP tools require per-call approval by default. After arguments pass validation,
Aira shows the tool name and arguments and asks you to type `yes`. Any other
answer denies the call and stops the tool loop. Closing input, cancellation,
and timeouts also prevent execution. Non-interactive CLI input cannot approve
calls. Approval waits count against the step and loop deadlines.

Set `"requireApproval": false` on a configured server to enable automatic
execution of its allowlisted tools. The read-only GitHub and echo examples
explicitly use this setting. A server's own annotations do not grant approval;
the policy is controlled locally. The built-in current-time tool remains automatic.
The built-in browser tool decides per-call: its read-only commands (`get`,
`is`, `extract`, `read`, `snapshot`, `screenshot`) run automatically, while
every other command (navigation, `click`, `fill`, `type`, `select`, `press`,
etc.) always requires approval and has no override.

Use `toolApproval` to override individual tools by their remote names (without
the server prefix). For example, these fields on a server configuration allow
`echo` automatically while keeping `fail` behind confirmation:

```json
{
  "tools": ["echo", "fail"],
  "requireApproval": true,
  "toolApproval": { "echo": false }
}
```

Precedence is the per-tool override, then `requireApproval`, then the default
`true`. A `true` override also requires confirmation on a server whose default is
`false`. Overrides must be booleans and refer to allowlisted tools; invalid names
fail startup. `/tools` shows the effective policy. An override does not enable a
tool or change its server-side permissions.

The approval gate is enforced by `ToolRunner`; callers invoking `Tool.execute`
directly must enforce their own policy. It is not a process sandbox and does not
control what a configured server does during startup. Each approval applies to
one call, not future turns or other tools.

To exercise approval in a real terminal without a model or GitHub connection:

```bash
npm run check:approval
```

This launches only the local echo fixture. Enter a message, then type `yes` to
approve, `no` to deny, or press Ctrl+C while approval is pending to cancel.
The check prints the stop reason and execution count. It uses the same approval
handler, runner, and loop as Aira, with deterministic selection and no memory
writes. `/exit` quits between checks.

### MCP connection layer

`src/tools/mcp-connection.ts` connects to local MCP servers using the official
MCP SDK's stdio transport. It starts a server process, discovers its tools
(including paginated lists), and adapts them to Aira's `Tool` interface.
Names are scoped to the connection, such as `local/echo`.

Aira optionally reads `aira.mcp.json` from its working directory at startup.
With no file, it starts with built-in tools only. To try the local echo fixture:

```bash
cp aira.mcp.example.json aira.mcp.json
npm start
```

Run `/tools` to see `current_time` and `fixture/echo`. The fixture also exposes
`fail`, but it is not in the configured `tools` allowlist and is not registered.
This example does not connect an external account. An allowlist enables tools
for model-selected execution; `requireApproval` separately controls per-call review.

`/tools` also shows whether each tool runs automatically or requires approval.
Use `/tools github/get_file_contents` (or another registered tool name) to inspect
its description, approval policy, and complete JSON input schema. A schema's
`required` array names mandatory arguments; `properties` describes accepted
fields. Inspection does not call the model, execute a tool, or write memory.

Each server requires `name` and `tools` (remote tool names without the server
prefix). Local servers require `command` and optionally `args`, `cwd`, and `env`.
Remote servers require an HTTPS `url` and optionally `headers` and `authTokenEnv`.
Both support `timeoutMs`. Transport-specific fields cannot be mixed.
Relative working directories resolve against the configuration file's folder;
server arguments are passed literally, without shell expansion. An empty
`tools` list skips launching that server. The config file is Git-ignored because
it may contain environment values. Commands in this file execute on startup,
so configure only servers you intend to run.

Invalid configuration, unsupported enabled tool schemas, startup failures,
and unknown allowlisted tools stop
startup and close connections already opened. Tools are published to the
registry only after all configured servers are ready. `/exit`, end-of-input,
Ctrl+C, and SIGTERM close active connections. Conversation turns run serially.

MCP results preserve content blocks and structured output. Server tool errors
become failed `ToolResult` values; connection errors reach the runner's error
diagnostics. Requests default to a 30-second timeout, configurable through
`timeoutMs`. A timeout does not prove that a remote action had no effect.
Schemas still need to work with Aira's synchronous draft-07 validator.
Discovery is a snapshot taken at connection time; automatic reconnection and
tool-list change notifications are not implemented yet. Remote connections use
Streamable HTTP with bearer-token authentication; interactive OAuth is not implemented.

### GitHub repository reading

The GitHub example uses [GitHub's hosted MCP server](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md),
with read-only mode enabled and four allowlisted tools: `get_file_contents`,
`list_branches`, `list_commits`, and `get_commit`. Docker is not required.

For a fresh setup, copy `aira.mcp.github.example.json` to `aira.mcp.json`.
If you already have configured servers, merge its server entry instead.

```bash
npm run check:github -- Itspigrain/fraud-platform
npm run start:github
```

With the local model server running, test model-driven selection and answering:

```bash
npm run check:github -- Itspigrain/fraud-platform --model frontend/README.md
```

This asks the fast model to choose a tool for reading the specified path (default
`README.md`), checks the
selected tool and repository arguments, executes the read, and prints an answer
based on the result. It does not write conversation or long-term memory. It
checks successful execution and a non-empty answer; factual answer quality still
needs review. A successful GitHub tool response can contain a path suggestion
instead of file contents; this single-step check does not follow such suggestions.
Routing, answer evaluation, and escalation are outside this check.

To test evidence evaluation and bounded tool gathering:

```bash
npm run check:github -- Itspigrain/fraud-platform --loop
```

To include the real answer evaluator and bounded retry/escalation flow:

```bash
npm run check:github -- Itspigrain/fraud-platform --evaluate frontend/README.md
```

`--evaluate` runs the tool loop once, then prints evaluator decisions and the
final answer role. Retries reuse that tool evidence. It requires both configured
local models and still skips routing and memory writes. A first-pass acceptance
does not test the live retry branch; deterministic tests cover those branches.

The live check verified with `Itspigrain/fraud-platform` read the root README in
one call, assessed the evidence as sufficient, and accepted the initial answer.
The summary was also compared with the source README. Hint-following, blocked
assessments, malformed decisions, and cancellation are covered by deterministic
tests; this live run did not exercise those branches.

`--loop` uses the same bounded loop as the CLI and prints diagnostics for each
step. A root README that returns actual content may require only one read; a
path suggestion requires a follow-up read. Repository contents can change, so
this command does not guarantee that the follow-up branch is exercised. Earlier results are preserved for answering, evaluation, and escalation.
The loop allows three selection steps and a total of 16,000 characters of tool
context, including notices and interpretation rules. If a step's result does not
fit, it is omitted in full, earlier results are preserved, and the loop stops
with `context_limit`. The answer must acknowledge missing evidence rather than
infer omitted content. `[Tool loop]` diagnostics show character usage and omitted
step count and total loop duration in milliseconds. `[Tool evaluation]` reports
the step number, elapsed milliseconds, and status of each evidence assessment,
including errors, timeouts, and cancellation. These timings measure how long Aira
waited, not whether remote work stopped. Timing metadata is not sent to the model.
The character budget applies to tool context, not user prompts,
conversation history, memory, or tool definitions. It does not cap network
response size or process memory.

After each successful call whose output fits the context budget, a separate model
assesses only whether the accumulated evidence is `sufficient` or `insufficient`.
Sufficient evidence ends gathering. Insufficient evidence maps to `continue` when
any tools are registered, handing planning back to the selector; this does not
promise that a suitable call exists. The selector may choose no tool when required
arguments or capabilities are missing. With an empty registry, code maps
insufficient evidence to `blocked`. Existing sufficient evidence remains usable
without tools. The evaluator does not receive tool definitions or decide policy.

For example, a matching README path is a hint, not file content. `[Tool evidence]`
diagnostics show the effective decision and reason. These are model judgments,
not verified facts, and the answer must still use the actual tool output.
Free-form assessment reasons remain in diagnostics only. Subsequent model calls
receive the assessment action without its explanation, preventing that feedback
channel from repeating untrusted instructions. Raw tool output remains untrusted.
Malformed assessments and model errors stop with an explicit limitation. Failed or
denied calls and omitted outputs are never assessed. Assessment requests share the
loop deadline; assessment actions count toward the tool-context budget. This adds one
model request per successful, retained tool result. The CLI and GitHub loop checks
enable evaluation; library callers can omit the optional evaluator to retain the
selector-driven loop.

The CLI prints progress as each tool step and evidence assessment starts, before
waiting for the model. GitHub loop checks also print phase completion events.
A finished phase does not imply success; final diagnostics report the outcome.
Library callers can supply an optional fifth `ToolLoop` constructor argument to
observe `{ step, phase, state }` events. Events contain no prompts, arguments, or
tool output. Observers should return quickly; asynchronous observers are not
awaited, and observer errors do not alter tool execution or evidence.

The tool loop has a separate 180-second deadline, each selection/execution step
has a 120-second deadline, and each local model request has a 120-second limit.
Configured MCP request timeouts still apply and may be shorter. These are not
an overall conversation deadline: memory retrieval, routing, evaluation, and
answer generation are separate phases. Code callers can supply an `AbortSignal`
to the loop or runner. Ctrl+C and SIGTERM signal cancellation before shutdown.

Timeouts and cancellation stop further loop steps and appear as `timeout` or
`cancelled` diagnostics. Signals propagate to model HTTP requests and MCP calls.
Aira stops waiting even if a tool ignores the signal, but cannot guarantee that
remote work has stopped or undo side effects. Interrupted operations are not
automatically retried. Timers cannot interrupt synchronous code blocking the
JavaScript event loop.

These commands use `AIRA_GITHUB_TOKEN` if supplied, otherwise your existing
`gh auth login` credential. Tokens remain in process memory and are not printed
or written to configuration. Ordinary `npm start` requires `AIRA_GITHUB_TOKEN`
to be set when the GitHub server is enabled. The application does not load `.env`
files automatically.

Try `/tools`, then “Read README.md from Itspigrain/fraud-platform” or
“List branches in Itspigrain/fraud-platform”. Repository names belong in the
request; this configuration does not restrict access to one repository. GitHub
credential permissions determine which repositories are accessible. For narrower
access, supply a fine-grained token limited to selected repositories with read
permissions for repository contents. Tool allowlisting and read-only mode do
not narrow the credential's underlying permissions.

Aira executes at most three tool-selection steps per turn. Larger repository
reviews can still require multiple requests. A successful connection check verifies a direct
repository read, not the quality of model-selected answers.

## Models

### Answer evaluation and retries

After tool execution, Aira generates an answer using the collected evidence.
Fast-model answers are evaluated before display. An `accept` decision with
`passed: true` keeps the answer. A `retry` decision gives the fast model one
chance to revise using the rejected answer and evaluator feedback, then evaluates
the revision. Another retry request, a failed acceptance, or an `escalate`
decision sends the task to the reasoning model.

Evaluator responses must contain exactly a boolean `passed`, a finite numeric
`score` from 0 to 1, a supported `action`, and a non-empty `reason`. Acceptance
requires `passed: true` and a score of at least 0.8; retry and escalation require
`passed: false` and a score below 0.8. Malformed or contradictory decisions
produce an explicit escalation result rather than being coerced into approval.

Retries and escalation reuse the original conversation state and tool evidence;
they do not execute tools again. Only the final displayed answer enters
conversation memory. The CLI reports each evaluation and the final model role.

This bounds answer generation to two fast-model attempts and one reasoning-model
attempt. Reasoning-model answers are not evaluated again, so escalation is not
a guarantee of correctness. The evaluator is itself a model and can make mistakes.

Aira currently runs local models using MLX.

### Fast model

```text
mlx-community/Qwen3-14B-4bit
```

Used for:

- General questions
- Fast responses
- Memory-related tasks
- Conversation summarization
- Routing

### Reasoning model

```text
mlx-community/Qwen3-32B-4bit
```

Used for:

- More difficult reasoning
- Complex coding tasks
- Escalated requests
- Answer evaluation

The model layer is abstracted so additional local or remote models can be added later.

## Memory architecture

Aira separates memory into two different systems.

### Conversation memory

Short-term context for the current session.

```text
Recent conversation
        │
        ├── recent verbatim turns
        │
        └── rolling summary
```

When the recent conversation exceeds its configured limits, older complete turns are summarized by a local model.

Recent messages remain verbatim while older context is compressed into a rolling session summary.

Summarization is transactional: old conversation turns are removed only after the updated summary has been successfully generated.

### Long-term memory

Persistent information that may be useful across conversations.

Long-term memories contain metadata such as:

```text
topic
content
importance
confidence
source
freshness
lifecycle
createdAt
lastConfirmedAt
embedding
supersedesId
```

Aira distinguishes between:

```text
active memory
historical memory
```

When information changes, the previous memory can become historical rather than simply disappearing.

This allows Aira to answer questions about both the user's current state and how something has changed over time.

## Memory retrieval

Long-term memory retrieval uses multiple signals.

```text
semantic similarity
        +
importance
        +
freshness
        +
confidence
        +
source reliability
        │
        ▼
candidate memories
        │
        ▼
LLM reranker
        │
        ▼
relevant context
```

Semantic relevance remains the primary retrieval signal.

Importance, freshness, confidence, and source reliability influence ranking but cannot make an unrelated memory relevant.

## Temporal memory

Aira understands three temporal intents:

```text
current
historical
mixed
```

For example:

```text
"What programming language am I currently using?"
→ current

"What was my stack before?"
→ historical

"How has my main programming language changed?"
→ mixed
```

Historical and mixed queries can produce memory timelines such as:

```text
Java
  ↓
Java again
  ↓
TypeScript
```

This preserves changes in state instead of treating historical memories as an unordered collection.

## Running Aira

### Requirements

- Node.js
- npm
- Python
- MLX / MLX-LM
- Apple Silicon Mac

Install Node dependencies:

```bash
npm install
```

Run all automated checks (formatting, TypeScript, and tests):

```bash
npm run check
```

The checks use fixture servers and stub models; they need no GitHub credentials
or running model server. Live GitHub/model checks remain separate commands.

`.github/workflows/check.yml` runs the same checks on pushes and pull requests,
and supports manual runs from the Actions tab. It uses Node.js 22 on Ubuntu,
installs exact lockfile versions with `npm ci`, and runs `npm run check`.
No custom secrets or live model server are required. The workflow uses the
standard read-only repository token for checkout and does not persist its Git
credentials. New runs cancel older runs for the same ref; jobs have a 15-minute
limit. Hosted execution begins after the workflow and source changes are committed
and pushed. Requiring a passing check before merge is a separate repository setting.

Type-check the project separately:

```bash
npm run typecheck
```

Run the automated tests separately:

```bash
npm test
```

Use `npm run format` to apply TypeScript formatting, or `npm run format:check`
to check it without editing files. The root `models/` directory is ignored for
downloaded model data; `src/models/` contains application code and belongs in Git.

Start the MLX server separately:

```bash
python -m mlx_lm.server
```

Then start Aira:

```bash
npm start
```

## Commands

Type `/help` to see available commands inside Aira. Help is handled locally,
without a model request or memory changes. Lines beginning with `/` are reserved
for commands. Unknown commands show guidance locally; missing search queries or
memory IDs show usage rather than reaching the model. To discuss a file path,
include it in a sentence such as “Explain /path/to/file”. Aira provides these
conversation and development/debugging commands.

```text
/session list
/session inspect <name>
/session save <name>
/session load <name>
/session delete <name>
```

Save and resume recent chat messages and the rolling summary. Use
`/session inspect <name>` to validate a saved file and view message counts,
summary size, and the last stored message timestamp without loading it or
printing conversation content. Sessions are plain
JSON files in `.aira/sessions/`, relative to the working directory and ignored by
Git. Names use letters, digits, underscores, and hyphens (up to 64 characters,
starting with a letter or digit). Saving requires a new name; existing files are
not overwritten. A save writes and syncs a temporary file before atomically
publishing the session name; concurrent saves cannot overwrite one another.
This requires a filesystem supporting hard links. Interrupted temporary files
are excluded from session listing; directory metadata is not synced, so this is
not a guarantee against loss during a power failure. Nothing is saved automatically.

Loading replaces active conversation context after validation; invalid or missing
files leave it intact. Long-term memory, tool connections, and approval policies
are not included or changed. Commands run between turns and make no model calls.
Files are limited to 1 MiB and 1,000 recent messages. Sessions contain conversation
text, so treat them as private local data. Use `/session delete <name>` to delete a saved file immediately; the active
conversation and long-term memory are unchanged. This command can also remove
a malformed saved file. `/new` clears active context but does not remove saved sessions.
A restart regression test launches two separate CLI processes and verifies that
messages and the rolling summary survive save/load, while `/new` leaves existing
saved files intact. This tests persistence without requiring a live model.

```text
/new
```

Start a fresh conversation by clearing recent messages and the rolling summary.
Long-term memories remain available for retrieval, and tools stay connected.
The command makes no model request. Commands are processed between turns, so
`/new` does not cancel an in-flight request. Use `/memory clear` separately if you
intend to delete long-term memory.

```text
/memories
```

Display stored long-term memories.

```text
/memory search <query>
```

Search long-term memory and display retrieval diagnostics.

```text
/memory consolidate
```

Consolidate semantically duplicate memories.

```text
/memory rescore
```

Recalculate memory metadata.

```text
/memory delete <id>
```

Delete a specific memory.

```text
/memory clear
```

Clear persistent long-term memory.

```text
/exit
```

Exit Aira.

## Local data

Aira's persistent memory is stored locally.

```text
long-term-memory.json
```

This file is intentionally excluded from Git because it may contain personal information learned during conversations.

Do not commit personal memory, credentials, API keys, or other private runtime data.

## Roadmap

### Completed

- Local model abstraction
- Multi-model routing
- Routing confidence
- Automatic model escalation
- LLM evaluator
- Persistent long-term memory
- Embedding-based retrieval
- LLM memory reranking
- Memory conflict handling
- Memory supersession
- Historical memory
- Temporal intent classification
- Chronological memory timelines
- Memory diagnostics
- Memory confidence and source reliability
- Bounded conversation memory
- Explicit local conversation save/load with rolling summaries
- Turn-aware trimming
- Rolling conversation summarization
- Tool abstraction and registry
- Shared tool argument validation
- MCP stdio connection and tool adapter (tested with a local fixture server)
- MCP startup configuration, tool allowlists, and shutdown cleanup
- GitHub repository reading over Streamable HTTP
- Tool selection
- Bounded multi-step tool execution integrated into conversation turns
- Shared tool-context character budget and explicit output omission
- Tool-loop deadlines and cooperative cancellation
- Per-call MCP approval with server defaults and per-tool overrides
- Current-time tool
- Tool evidence evaluation after successful calls

### Next

- Additional MCP service integrations
- Approval policies based on tool arguments
- GitHub integration
- Calendar integration
- Email integration
- Web/research tools

### Future

- 70B+ expert model
- Memory database/vector store
- Memory maintenance jobs
- Planning
- Multi-step autonomous tasks
- User approval policies
- Observability
- Evaluation datasets
- Feedback-driven improvement
- API/server mode
- Voice interface

## Vision

Aira is intended to evolve from:

```text
AI that answers
```

into:

```text
AI that understands
        ↓
AI that remembers
        ↓
AI that reasons
        ↓
AI that uses tools
        ↓
AI that coordinates work
```

The goal is a local-first AI chief of staff that remains understandable, controllable, and extensible rather than hiding everything behind a single model call.

## Status

Aira is currently an experimental personal project and is under active development.
