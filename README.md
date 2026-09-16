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
                    Tools / MCP
                     (planned)
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

## Models

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

Type-check the project:

```bash
npx tsc --noEmit
```

Start the MLX server separately:

```bash
python -m mlx_lm.server
```

Then start Aira:

```bash
npm start
```

## Commands

Aira currently provides several development/debugging commands.

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
- Turn-aware trimming
- Rolling conversation summarization

### Next

- Tool abstraction
- MCP integration
- Tool registry
- Tool selection
- Agent execution loop
- Tool-result evaluation
- Safer action approval
- GitHub integration
- Calendar integration
- Email integration
- Web/research tools

### Future

- 70B+ expert model
- Persistent conversation sessions
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