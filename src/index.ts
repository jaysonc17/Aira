import { RepositoryInvestigator } from "./tools/repository-investigator.js";
import { RepositoryPlanner } from "./tools/repository-planner.js";
import {
  ConversationSessions,
  handleSessionCommand,
} from "./conversation-sessions.js";
import { CLI_HELP } from "./cli-help.js";
import { generateAnswer } from "./answer-generator.js";
import { Router } from "./router.js";

import { ModelRegistry } from "./models/model-registry.js";

import { ConversationMemory } from "./conversation-memory.js";

import { LlmConversationSummarizer } from "./llm-conversation-summarizer.js";

import { LongTermMemory } from "./long-term-memory.js";

import { EmbeddingService } from "./embedding-service.js";

import { MemoryReranker } from "./memory-reranker.js";

import { MemoryManager } from "./memory-manager.js";

import { LlmEvaluator } from "./llm-evaluator.js";

import { MemoryContextBuilder } from "./memory-context-builder.js";

import readline from "node:readline";

import { ToolRegistry } from "./tools/tool-registry.js";
import { inspectTools } from "./tools/tool-inspection.js";
import { ToolSelector } from "./tools/tool-selector.js";
import { ToolRunner } from "./tools/tool-runner.js";
import { LlmToolResultEvaluator } from "./tools/tool-result-evaluator.js";
import { ToolLoop } from "./tools/tool-loop.js";
import { CurrentTimeTool } from "./tools/current-time-tool.js";
import { BrowserTool, isBrowserCliAvailable } from "./tools/browser-tool.js";
import { loadMcpConfig } from "./tools/mcp-config.js";
import { McpSession } from "./tools/mcp-session.js";
import { requestToolApproval } from "./tools/tool-approval.js";

async function main() {
  const modelRegistry = new ModelRegistry();

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new CurrentTimeTool());
  if (await isBrowserCliAvailable()) {
    toolRegistry.register(new BrowserTool());
  } else {
    console.warn(
      "[Tools] llm-browser CLI not found on PATH; the browser tool will not be registered.",
    );
  }

  const toolRunner = new ToolLoop(
    new ToolRunner(
      new ToolSelector(modelRegistry.get("fast"), toolRegistry),
      toolRegistry,
      undefined,
      (request, signal) =>
        process.stdin.isTTY
          ? requestToolApproval(rl, request, signal)
          : Promise.resolve(false),
    ),
    6,
    16_000,
    new LlmToolResultEvaluator(modelRegistry.get("fast"), toolRegistry),
    ({ step, phase, state }) => {
      if (state !== "started") return;
      console.log(
        phase === "tool_step"
          ? `[Tools] Step ${step}: selecting a tool and running it if approved...`
          : `[Tools] Step ${step}: checking whether the evidence is sufficient...`,
      );
    },
  );

  /*
   * Conversation summarization uses the
   * smaller memory model.
   *
   * This is currently Qwen3-14B.
   */
  const conversationSummarizer = new LlmConversationSummarizer(
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
  const conversationMemory = new ConversationMemory({
    maximumMessages: 4,
    maximumCharacters: 2000,
    summarizer: conversationSummarizer,
  });

  const repositoryPlanner = new RepositoryPlanner(
    modelRegistry.get("fast"),
    toolRegistry,
  );
  const sessions = new ConversationSessions();
  const longTermMemory = new LongTermMemory();

  const embeddingService = new EmbeddingService();

  const memoryReranker = new MemoryReranker(modelRegistry.get("memory"));

  const memoryManager = new MemoryManager(
    longTermMemory,
    embeddingService,
    modelRegistry.get("fast"),
    memoryReranker,
    modelRegistry.get("memory"),
  );

  const memoryContextBuilder = new MemoryContextBuilder();

  const router = new Router(modelRegistry.get("fast"));

  const evaluator = new LlmEvaluator(modelRegistry.get("reasoning"));

  const mcpSession = new McpSession();
  await mcpSession.start(await loadMcpConfig(), toolRegistry);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\nYou: ",
  });

  console.log("Personal AI assistant started.");

  console.log(
    "Type /help for commands, /new for a fresh conversation, or /exit to quit.",
  );

  const cancellation = new AbortController();
  const shutdown = () => {
    cancellation.abort();
    rl.close();
    void mcpSession.close().then(
      () => process.exit(0),
      (error) => {
        console.error("MCP shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  rl.once("SIGINT", shutdown);

  try {
    rl.prompt();
    // Process one turn at a time so tool calls and memory updates cannot overlap.
    for await (const line of rl) {
      const prompt = line.trim();
      if (prompt === "/exit") break;
      if (!prompt) {
        rl.prompt();
        continue;
      }

      if (prompt === "/help") {
        console.log(CLI_HELP);
        rl.prompt();
        continue;
      }

      if (prompt === "/new") {
        conversationMemory.clear();
        console.log(
          "Started a new conversation. Long-term memory is unchanged.",
        );
        rl.prompt();
        continue;
      }

      try {
        if (/^\/investigate(?:\s|$)/.test(prompt)) {
          const match = /^\/investigate\s+(\S+)\s+([\s\S]+)$/.exec(prompt);
          if (!match) {
            console.log("Usage: /investigate <owner/repository> <question>");
          } else {
            console.log("Planning and gathering repository evidence...");
            const investigator = new RepositoryInvestigator(
              modelRegistry.get("fast"),
              toolRegistry,
              (request, signal) =>
                process.stdin.isTTY
                  ? requestToolApproval(rl, request, signal)
                  : Promise.resolve(false),
              ({ step, phase, state }) =>
                console.log(
                  `[Investigation] step=${step} phase=${phase} state=${state}`,
                ),
            );
            const result = await investigator.investigate(
              match[1]!,
              match[2]!,
              cancellation.signal,
            );
            console.log(
              `[Investigation] stop=${result.evidence.stopReason} steps=${result.evidence.steps.length}`,
            );
            console.log(result.answer);
          }
          rl.prompt();
          continue;
        }
        if (/^\/plan(?:\s|$)/.test(prompt)) {
          const match = /^\/plan\s+(\S+)\s+([\s\S]+)$/.exec(prompt);
          if (!match) {
            console.log("Usage: /plan <owner/repository> <question>");
          } else {
            console.log("Planning repository investigation...");
            const plan = await repositoryPlanner.plan(
              match[1]!,
              match[2]!,
              cancellation.signal,
            );
            console.log(`Proposed investigation: ${plan.repository}`);
            for (const [index, step] of plan.steps.entries()) {
              console.log(`${index + 1}. ${step.question} [${step.tool}]`);
            }
            console.log(
              "Plan only: no repository tools executed. Proposed steps are not verified findings.",
            );
          }
          rl.prompt();
          continue;
        }
        const sessionResponse = await handleSessionCommand(
          prompt,
          sessions,
          conversationMemory,
        );
        if (sessionResponse !== null) {
          console.log(sessionResponse);
          rl.prompt();
          continue;
        }
        const toolInspection = inspectTools(prompt, toolRegistry);
        if (toolInspection !== null) {
          console.log(toolInspection);
        } else if (
          !(await handleCommand(prompt, longTermMemory, memoryManager))
        ) {
          if (prompt.startsWith("/")) {
            console.log("Unknown command. Type /help for available commands.");
            rl.prompt();
            continue;
          }
          await handleConversation(
            prompt,
            router,
            evaluator,
            modelRegistry,
            conversationMemory,
            memoryManager,
            memoryContextBuilder,
            toolRunner,
            cancellation.signal,
          );
        }
      } catch (error) {
        console.error("\nError:", error);
      }
      rl.prompt();
    }
  } finally {
    rl.close();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await mcpSession.close();
  }
}

async function handleConversation(
  prompt: string,
  router: Router,
  evaluator: LlmEvaluator,
  modelRegistry: ModelRegistry,
  conversationMemory: ConversationMemory,
  memoryManager: MemoryManager,
  memoryContextBuilder: MemoryContextBuilder,
  toolRunner: ToolLoop,
  signal: AbortSignal,
) {
  /*
   * Capture conversation state BEFORE
   * adding the current user message.
   *
   * LocalModel.generate() adds the current
   * prompt itself.
   */
  const history = conversationMemory.getHistory();

  const conversationSummary = conversationMemory.getSummaryContent();

  console.log(
    `[Conversation memory] ` +
      `history=${history.length} ` +
      `stored=${conversationMemory.size} ` +
      `summarized=${conversationMemory.summarizedMessageCount} ` +
      `summaryChars=${conversationSummary.length} ` +
      `recentChars=${conversationMemory.characterCount}`,
  );

  if (conversationSummary) {
    console.log(`[Conversation summary]\n` + `${conversationSummary}`);
  }

  /*
   * Search persistent long-term memory
   * independently from conversation memory.
   */
  const memorySearch = await memoryManager.search(prompt);

  const diagnostics = memorySearch.diagnostics;

  console.log(
    `[Memory diagnostics] ` +
      `candidates=${diagnostics.candidateCount} ` +
      `active=${diagnostics.activeCandidateCount} ` +
      `historical=${diagnostics.historicalCandidateCount} ` +
      `reranked=${diagnostics.rerankedCount} ` +
      `relevant=${diagnostics.relevantCount}`,
  );

  const relevantMemories = memorySearch.memories;

  for (const result of relevantMemories) {
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

  const memoryContextResult = memoryContextBuilder.build(memorySearch);

  const memoryContext = memoryContextResult.context;

  if (memoryContext) {
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

    console.log(`[Memory context]\n${memoryContext}`);
  }

  const route = await router.route(prompt);

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
    route.confidence < 0.75 || route.role !== "fast" ? "reasoning" : "fast";

  if (effectiveRole !== route.role) {
    console.log(`[Router] Low confidence — escalating to reasoning model`);
  }

  // Run a bounded tool loop. Reuse all outcomes during
  // evaluation and escalation so actions are not repeated.
  const toolRun = await toolRunner.run(
    prompt,
    history,
    buildEvaluationContext(conversationSummary, memoryContext),
    signal,
  );

  const toolContext = toolRun.context;
  console.log(
    `[Tool loop] steps=${toolRun.steps.length} stop=${toolRun.stopReason} ` +
      `contextChars=${toolRun.contextCharacters}/${toolRun.maximumContextCharacters} ` +
      `omittedSteps=${toolRun.omittedSteps} totalMs=${toolRun.totalMs.toFixed(1)}`,
  );
  for (const diagnostic of toolRun.evaluationDiagnostics) {
    console.log(
      `[Tool evaluation] step=${diagnostic.step} status=${diagnostic.status} durationMs=${diagnostic.durationMs.toFixed(1)}`,
    );
  }
  for (const evaluation of toolRun.evaluations) {
    console.log(`[Tool evidence] ${JSON.stringify(evaluation)}`);
  }
  for (const toolDiagnostics of toolRun.steps) {
    console.log(
      `[Tools] status=${toolDiagnostics.status} ` +
        `executionAttempted=${toolDiagnostics.executionAttempted} ` +
        `selectionMs=${toolDiagnostics.selectionMs.toFixed(1)} ` +
        `executionMs=${toolDiagnostics.executionMs.toFixed(1)} ` +
        `totalMs=${toolDiagnostics.totalMs.toFixed(1)}`,
    );

    if (toolDiagnostics.selection) {
      console.log(
        `[Tool selection] ${JSON.stringify(toolDiagnostics.selection)}`,
      );
    }

    if (toolDiagnostics.error !== null) {
      console.log(
        `[Tool error] stage=${toolDiagnostics.errorStage} ` +
          `message=${JSON.stringify(toolDiagnostics.error)}`,
      );
    }
  }

  const systemPrompt = buildSystemPrompt(
    conversationSummary,
    memoryContext,
    toolContext,
  );

  const answerResult = await generateAnswer(
    { prompt, systemPrompt, signal, history },
    effectiveRole,
    {
      fast: modelRegistry.get("fast"),
      reasoning: modelRegistry.get("reasoning"),
    },
    evaluator,
    buildEvaluationContext(conversationSummary, memoryContext, toolContext),
  );
  const answer = answerResult.answer;
  for (const evaluation of answerResult.evaluations) {
    console.log(
      `[Evaluator] score=${evaluation.score.toFixed(2)} ` +
        `action=${evaluation.action} reason=${evaluation.reason}`,
    );
  }
  console.log(
    `[Answer] role=${answerResult.role} retried=${answerResult.retried}`,
  );

  console.log(`\nAssistant: ${answer}`);

  /*
   * Store only the final displayed turn.
   */
  conversationMemory.addUserMessage(prompt);

  /*
   * This may trigger rolling
   * summarization if the conversation
   * buffer has exceeded its limits.
   */
  await conversationMemory.addAssistantMessage(answer);

  /*
   * Process persistent long-term memory
   * only after answering.
   */
  await memoryManager.process(prompt);
}

function buildSystemPrompt(
  conversationSummary: string,
  memoryContext: string,
  toolContext: string,
): string {
  const sections: string[] = [];

  sections.push(
    `
You are a personal AI assistant.

Be helpful, accurate, concise,
and use the conversation context
when appropriate.

Do not claim to remember information
unless it is present in the supplied
conversation or memory context.
`.trim(),
  );

  if (conversationSummary) {
    sections.push(
      `
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
`.trim(),
    );
  }

  if (memoryContext) {
    sections.push(
      `
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
`.trim(),
    );
  }

  sections.push(toolContext);

  return sections.join("\n\n");
}

function buildEvaluationContext(
  conversationSummary: string,
  memoryContext: string,
  toolContext = "",
): string {
  const sections: string[] = [];

  if (conversationSummary) {
    sections.push(["CONVERSATION SUMMARY:", conversationSummary].join("\n"));
  }

  if (memoryContext) {
    sections.push(["LONG-TERM MEMORY:", memoryContext].join("\n"));
  }

  if (toolContext) {
    sections.push(toolContext);
  }

  return sections.join("\n\n");
}

async function handleCommand(
  input: string,
  longTermMemory: LongTermMemory,
  memoryManager: MemoryManager,
): Promise<boolean> {
  if (input === "/memories") {
    const memories = longTermMemory.getAll();

    console.log(`\nLong-term memories (${memories.length}):`);

    if (memories.length === 0) {
      console.log("No memories stored.");

      return true;
    }

    for (const memory of memories) {
      console.log(`\nID: ${memory.id}`);

      console.log(`Topic: ${memory.topic}`);

      console.log(`Memory: ${memory.content}`);

      console.log(`Importance: ${memory.importance}/5`);

      console.log(`Confidence: ${memory.confidence.toFixed(2)}`);

      console.log(`Source: ${memory.source}`);

      console.log(`Lifecycle: ${memory.lifecycle}`);

      console.log(`Freshness: ${memory.freshness}`);

      console.log(`Created: ${memory.createdAt}`);

      console.log(`Last confirmed: ${memory.lastConfirmedAt}`);

      if (memory.supersedesId) {
        console.log(`Supersedes: ${memory.supersedesId}`);
      }
    }

    return true;
  }

  if (input === "/memory search") {
    console.log("Usage: /memory search <query>");
    return true;
  }

  if (input === "/memory delete") {
    console.log("Usage: /memory delete <id>");
    return true;
  }

  if (input.startsWith("/memory search ")) {
    const query = input.slice("/memory search ".length).trim();

    if (!query) {
      console.log("Usage: /memory search <query>");

      return true;
    }

    const searchResult = await memoryManager.search(query);

    const results = searchResult.memories;

    console.log(`\nMemory search results (${results.length}):`);

    console.log(`Temporal intent: ${searchResult.temporalIntent}`);

    console.log(`Candidates: ${searchResult.diagnostics.candidateCount}`);

    for (const result of results) {
      console.log(`\nRank: ${result.rank}`);

      console.log(`Topic: ${result.memory.topic}`);

      console.log(`Memory: ${result.memory.content}`);

      console.log(`Semantic score: ${result.semanticConfidence.toFixed(3)}`);

      console.log(`Importance score: ${result.importanceScore.toFixed(3)}`);

      console.log(`Freshness score: ${result.freshnessScore.toFixed(3)}`);

      console.log(`Confidence score: ${result.confidenceScore.toFixed(3)}`);

      console.log(
        `Source reliability: ${result.sourceReliabilityScore.toFixed(3)}`,
      );

      console.log(`Combined score: ${result.combinedScore.toFixed(3)}`);
    }

    return true;
  }

  if (input === "/memory consolidate") {
    memoryManager.consolidate();

    console.log("Memory consolidation complete.");

    return true;
  }

  if (input === "/memory rescore") {
    memoryManager.rescore();

    console.log("Memory rescoring complete.");

    return true;
  }

  if (input.startsWith("/memory delete ")) {
    const id = input.slice("/memory delete ".length).trim();

    if (!id) {
      console.log("Usage: /memory delete <id>");

      return true;
    }

    const deleted = longTermMemory.delete(id);

    console.log(deleted ? "Memory deleted." : "Memory not found.");

    return true;
  }

  if (input === "/memory clear") {
    longTermMemory.clear();

    console.log("All long-term memories cleared.");

    return true;
  }

  return false;
}

main().catch((error) => {
  console.error("Fatal error:", error);

  process.exit(1);
});
