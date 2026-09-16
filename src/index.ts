import { Router } from "./router.js";

import {
  ModelRegistry,
} from "./models/model-registry.js";

import {
  ConversationMemory,
} from "./conversation-memory.js";

import {
  LlmConversationSummarizer,
} from "./llm-conversation-summarizer.js";

import {
  LongTermMemory,
} from "./long-term-memory.js";

import {
  EmbeddingService,
} from "./embedding-service.js";

import {
  MemoryReranker,
} from "./memory-reranker.js";

import {
  MemoryManager,
} from "./memory-manager.js";

import {
  LlmEvaluator,
} from "./llm-evaluator.js";

import {
  MemoryContextBuilder,
} from "./memory-context-builder.js";

import readline from "node:readline";

async function main() {
  const modelRegistry =
    new ModelRegistry();

  /*
   * Conversation summarization uses the
   * smaller memory model.
   *
   * This is currently Qwen3-14B.
   */
  const conversationSummarizer =
    new LlmConversationSummarizer(
      modelRegistry.get("memory"),
    );

  // const conversationMemory =
  //   new ConversationMemory({
  //     maximumMessages: 12,
  //     maximumCharacters: 6000,
  //     summarizer:
  //       conversationSummarizer,
  //   });

  // for testing, we use a smaller conversation memory to trigger summarization more quickly
  const conversationMemory =
    new ConversationMemory({
      maximumMessages: 4,
      maximumCharacters: 2000,
      summarizer:
        conversationSummarizer,
    });

  const longTermMemory =
    new LongTermMemory();

  const embeddingService =
    new EmbeddingService();

  const memoryReranker =
    new MemoryReranker(
      modelRegistry.get("memory"),
    );

  const memoryManager =
    new MemoryManager(
      longTermMemory,
      embeddingService,
      modelRegistry.get("fast"),
      memoryReranker,
      modelRegistry.get("memory"),
    );

  const memoryContextBuilder =
    new MemoryContextBuilder();

  const router =
    new Router(
      modelRegistry.get("fast"),
    );

  const evaluator =
    new LlmEvaluator(
      modelRegistry.get("reasoning"),
    );

  const rl =
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\nYou: ",
    });

  console.log(
    "Personal AI assistant started.",
  );

  console.log(
    "Type /memories to inspect long-term memory.",
  );

  console.log(
    "Type /memory search <query> to search memory.",
  );

  console.log(
    "Type /memory consolidate to consolidate memory.",
  );

  console.log(
    "Type /memory rescore to rescore memory.",
  );

  console.log(
    "Type /memory delete <id> to delete a memory.",
  );

  console.log(
    "Type /memory clear to clear long-term memory.",
  );

  console.log(
    "Type /exit to quit.",
  );

  rl.prompt();

  rl.on(
    "line",
    async (line) => {
      const prompt =
        line.trim();

      if (!prompt) {
        rl.prompt();
        return;
      }

      try {
        if (
          await handleCommand(
            prompt,
            longTermMemory,
            memoryManager,
          )
        ) {
          rl.prompt();
          return;
        }

        await handleConversation(
          prompt,
          router,
          evaluator,
          modelRegistry,
          conversationMemory,
          memoryManager,
          memoryContextBuilder,
        );
      } catch (error) {
        console.error(
          "\nError:",
          error,
        );
      }

      rl.prompt();
    },
  );
}

async function handleConversation(
  prompt: string,
  router: Router,
  evaluator: LlmEvaluator,
  modelRegistry: ModelRegistry,
  conversationMemory: ConversationMemory,
  memoryManager: MemoryManager,
  memoryContextBuilder: MemoryContextBuilder,
) {
  /*
   * Capture conversation state BEFORE
   * adding the current user message.
   *
   * LocalModel.generate() adds the current
   * prompt itself.
   */
  const history =
    conversationMemory.getHistory();

  const conversationSummary =
    conversationMemory
      .getSummaryContent();

  console.log(
    `[Conversation memory] ` +
    `history=${history.length} ` +
    `stored=${conversationMemory.size} ` +
    `summarized=${conversationMemory.summarizedMessageCount} ` +
    `summaryChars=${conversationSummary.length} ` +
    `recentChars=${conversationMemory.characterCount}`,
  );

  if (
    conversationSummary
  ) {
    console.log(
      `[Conversation summary]\n` +
      `${conversationSummary}`,
    );
  }

  /*
   * Search persistent long-term memory
   * independently from conversation memory.
   */
  const memorySearch =
    await memoryManager.search(
      prompt,
    );

  const diagnostics =
    memorySearch.diagnostics;

  console.log(
    `[Memory diagnostics] ` +
    `candidates=${diagnostics.candidateCount} ` +
    `active=${diagnostics.activeCandidateCount} ` +
    `historical=${diagnostics.historicalCandidateCount} ` +
    `reranked=${diagnostics.rerankedCount} ` +
    `relevant=${diagnostics.relevantCount}`,
  );

  const relevantMemories =
    memorySearch.memories;

  for (
    const result of
    relevantMemories
  ) {
    console.log(
      `[Memory result] ` +
      `rank=${result.rank} ` +
      `topic=${result.memory.topic} ` +
      `semantic=${result.semanticConfidence.toFixed(3)} ` +
      `importance=${result.importanceScore.toFixed(2)} ` +
      `freshness=${result.freshnessScore.toFixed(2)} ` +
      `confidence=${result.confidenceScore.toFixed(2)} ` +
      `source=${result.sourceReliabilityScore.toFixed(2)} ` +
      `combined=${result.combinedScore.toFixed(3)} ` +
      `lifecycle=${result.memory.lifecycle} ` +
      `content="${result.memory.content}"`,
    );
  }

  const memoryContextResult =
    memoryContextBuilder.build(
      memorySearch,
    );

  const memoryContext =
    memoryContextResult.context;

  if (
    memoryContext
  ) {
    console.log(
      `\n[Memory] Using ` +
      `${memoryContextResult.selectedCount} ` +
      `relevant memories`,
    );

    console.log(
      `[Memory context] ` +
      `selected=${memoryContextResult.selectedCount} ` +
      `dropped=${memoryContextResult.droppedCount} ` +
      `chars=${memoryContextResult.charactersUsed}/2500`,
    );

    console.log(
      `[Memory context]\n${memoryContext}`,
    );
  }

  const route =
    await router.route(
      prompt,
    );

  console.log(
    `[Router] role=${route.role} ` +
    `confidence=${route.confidence.toFixed(2)} ` +
    `reason=${route.reason}`,
  );

  /*
   * Low-confidence routing decisions
   * are escalated to the reasoning model.
   */
  const effectiveRole =
    route.confidence < 0.75
      ? "reasoning"
      : route.role;

  if (
    effectiveRole !==
    route.role
  ) {
    console.log(
      `[Router] Low confidence — escalating to reasoning model`,
    );
  }

  /*
   * System context contains two distinct
   * memory layers:
   *
   * 1. Rolling session summary
   * 2. Persistent long-term memory
   *
   * Recent conversation remains in the
   * normal chat history.
   */
  const systemPrompt =
    buildSystemPrompt(
      conversationSummary,
      memoryContext,
    );

  const model =
    modelRegistry.get(
      effectiveRole,
    );

  let answer =
    await model.generate({
      prompt,

      systemPrompt,

      history,

      maxTokens:
        effectiveRole ===
          "reasoning"
          ? 2000
          : 1500,

      thinking:
        effectiveRole ===
        "reasoning",
    });

  /*
   * Fast-model answers are evaluated
   * before being accepted.
   */
  if (
    effectiveRole ===
    "fast"
  ) {
    const evaluation =
      await evaluator.evaluate(
        prompt,
        answer,
        buildEvaluationContext(
          conversationSummary,
          memoryContext,
        ),
      );

    console.log(
      `[Evaluator] ` +
      `score=${evaluation.score.toFixed(2)} ` +
      `action=${evaluation.action} ` +
      `reason=${evaluation.reason}`,
    );

    if (
      evaluation.action ===
      "escalate"
    ) {
      console.log(
        `[Evaluator] Escalating answer to reasoning model`,
      );

      const reasoningModel =
        modelRegistry.get(
          "reasoning",
        );

      /*
       * The stronger model receives exactly
       * the same conversation state that the
       * original model received.
       *
       * The rejected answer is not inserted
       * into conversation memory.
       */
      answer =
        await reasoningModel.generate(
          {
            prompt,

            systemPrompt,

            history,

            maxTokens: 2000,

            thinking: true,
          },
        );
    }
  }

  console.log(
    `\nAssistant: ${answer}`,
  );

  /*
   * Store only the final displayed turn.
   */
  conversationMemory.addUserMessage(
    prompt,
  );

  /*
   * This may trigger rolling
   * summarization if the conversation
   * buffer has exceeded its limits.
   */
  await conversationMemory
    .addAssistantMessage(
      answer,
    );

  /*
   * Process persistent long-term memory
   * only after answering.
   */
  await memoryManager.process(
    prompt,
  );
}

function buildSystemPrompt(
  conversationSummary: string,
  memoryContext: string,
): string {
  const sections: string[] = [];

  sections.push(`
You are a personal AI assistant.

Be helpful, accurate, concise,
and use the conversation context
when appropriate.

Do not claim to remember information
unless it is present in the supplied
conversation or memory context.
`.trim());

  if (
    conversationSummary
  ) {
    sections.push(`
CONVERSATION SUMMARY:

${conversationSummary}

Conversation summary rules:

- This summary represents earlier context
  from the current conversation session.

- Use it to understand references to earlier
  discussion, decisions, requirements,
  entities, and unresolved work.

- Prefer newer information from the recent
  conversation history if it conflicts with
  the summary.

- Do not treat session-specific information
  as a permanent user preference merely
  because it appears in this summary.
`.trim());
  }

  if (
    memoryContext
  ) {
    sections.push(`
RELEVANT LONG-TERM MEMORY ABOUT THE USER:

${memoryContext}

Memory rules:

- CURRENT MEMORY represents information
  believed to be currently true.

- HISTORICAL MEMORY represents information
  that was previously true but has been
  replaced or superseded.

- MEMORY TIMELINE is ordered from older
  state to newer/current state. Use it
  when answering questions about changes
  over time.

- Do not treat historical memory as the
  user's current state.

- Use historical memory when the user asks
  about previous states, changes, or history.

- Use memories only when relevant to the
  current question.

- Do not force unrelated memories into
  the answer.
`.trim());
  }

  return sections.join(
    "\n\n",
  );
}

function buildEvaluationContext(
  conversationSummary: string,
  memoryContext: string,
): string {
  const sections:
    string[] = [];

  if (
    conversationSummary
  ) {
    sections.push(
      [
        "CONVERSATION SUMMARY:",
        conversationSummary,
      ].join("\n"),
    );
  }

  if (
    memoryContext
  ) {
    sections.push(
      [
        "LONG-TERM MEMORY:",
        memoryContext,
      ].join("\n"),
    );
  }

  return sections.join(
    "\n\n",
  );
}

async function handleCommand(
  input: string,
  longTermMemory: LongTermMemory,
  memoryManager: MemoryManager,
): Promise<boolean> {
  if (
    input === "/exit"
  ) {
    process.exit(0);
  }

  if (
    input === "/memories"
  ) {
    const memories =
      longTermMemory.getAll();

    console.log(
      `\nLong-term memories (${memories.length}):`,
    );

    if (
      memories.length === 0
    ) {
      console.log(
        "No memories stored.",
      );

      return true;
    }

    for (
      const memory of
      memories
    ) {
      console.log(
        `\nID: ${memory.id}`,
      );

      console.log(
        `Topic: ${memory.topic}`,
      );

      console.log(
        `Memory: ${memory.content}`,
      );

      console.log(
        `Importance: ${memory.importance}/5`,
      );

      console.log(
        `Confidence: ${memory.confidence.toFixed(2)}`,
      );

      console.log(
        `Source: ${memory.source}`,
      );

      console.log(
        `Lifecycle: ${memory.lifecycle}`,
      );

      console.log(
        `Freshness: ${memory.freshness}`,
      );

      console.log(
        `Created: ${memory.createdAt}`,
      );

      console.log(
        `Last confirmed: ${memory.lastConfirmedAt}`,
      );

      if (
        memory.supersedesId
      ) {
        console.log(
          `Supersedes: ${memory.supersedesId}`,
        );
      }
    }

    return true;
  }

  if (
    input.startsWith(
      "/memory search ",
    )
  ) {
    const query =
      input
        .slice(
          "/memory search ".length,
        )
        .trim();

    if (!query) {
      console.log(
        "Usage: /memory search <query>",
      );

      return true;
    }

    const searchResult =
      await memoryManager.search(
        query,
      );

    const results =
      searchResult.memories;

    console.log(
      `\nMemory search results (${results.length}):`,
    );

    console.log(
      `Temporal intent: ${searchResult.temporalIntent}`,
    );

    console.log(
      `Candidates: ${searchResult.diagnostics.candidateCount}`,
    );

    for (
      const result of
      results
    ) {
      console.log(
        `\nRank: ${result.rank}`,
      );

      console.log(
        `Topic: ${result.memory.topic}`,
      );

      console.log(
        `Memory: ${result.memory.content}`,
      );

      console.log(
        `Semantic score: ${result.semanticConfidence.toFixed(3)}`,
      );

      console.log(
        `Importance score: ${result.importanceScore.toFixed(3)}`,
      );

      console.log(
        `Freshness score: ${result.freshnessScore.toFixed(3)}`,
      );

      console.log(
        `Confidence score: ${result.confidenceScore.toFixed(3)}`,
      );

      console.log(
        `Source reliability: ${result.sourceReliabilityScore.toFixed(3)}`,
      );

      console.log(
        `Combined score: ${result.combinedScore.toFixed(3)}`,
      );
    }

    return true;
  }

  if (
    input ===
    "/memory consolidate"
  ) {
    memoryManager.consolidate();

    console.log(
      "Memory consolidation complete.",
    );

    return true;
  }

  if (
    input ===
    "/memory rescore"
  ) {
    memoryManager.rescore();

    console.log(
      "Memory rescoring complete.",
    );

    return true;
  }

  if (
    input.startsWith(
      "/memory delete ",
    )
  ) {
    const id =
      input
        .slice(
          "/memory delete ".length,
        )
        .trim();

    if (!id) {
      console.log(
        "Usage: /memory delete <id>",
      );

      return true;
    }

    const deleted =
      longTermMemory.delete(
        id,
      );

    console.log(
      deleted
        ? "Memory deleted."
        : "Memory not found.",
    );

    return true;
  }

  if (
    input ===
    "/memory clear"
  ) {
    longTermMemory.clear();

    console.log(
      "All long-term memories cleared.",
    );

    return true;
  }

  return false;
}

main().catch(
  (error) => {
    console.error(
      "Fatal error:",
      error,
    );

    process.exit(1);
  },
);