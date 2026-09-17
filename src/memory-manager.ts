import { LongTermMemory } from "./long-term-memory.js";

import type { Memory, MemorySearchResult } from "./long-term-memory.js";

import { EmbeddingService } from "./embedding-service.js";

import { MemoryReranker } from "./memory-reranker.js";

import type { RerankedMemory } from "./memory-reranker.js";

import type { AIModel } from "./models/local-model.js";

interface MemoryClassification {
  action: "create" | "update" | "confirm" | "keep";

  topic: string;

  memory: string;

  importance: number;

  confidence: number;

  source: "explicit" | "inferred" | "updated";
}

interface MemoryConflictDecision {
  conflict: boolean;

  supersedes: boolean;

  targetMemoryId?: string;

  confidence: number;
}

interface DuplicateDecision {
  duplicate: boolean;

  memoryId?: string;

  similarity: number;
}

export type TemporalIntent = "current" | "historical" | "mixed";

export interface MemoryTimeline {
  topic: string;

  memories: Memory[];
}

export interface MemorySearchDiagnostics {
  candidateCount: number;

  activeCandidateCount: number;

  historicalCandidateCount: number;

  rerankedCount: number;

  relevantCount: number;
}

export interface MemorySearchResponse {
  memories: RerankedMemory[];

  temporalIntent: TemporalIntent;

  timelines: MemoryTimeline[];

  diagnostics: MemorySearchDiagnostics;
}

export class MemoryManager {
  constructor(
    private readonly memory: LongTermMemory,

    private readonly embeddingService: EmbeddingService,

    private readonly classifierModel: AIModel,

    private readonly reranker: MemoryReranker,

    private readonly memoryModel: AIModel = classifierModel,
  ) {}

  async process(userMessage: string): Promise<void> {
    if (!this.shouldInspectMemory(userMessage)) {
      return;
    }

    const initialDecision = await this.classifyMessage(userMessage);

    console.log(
      `[Memory classification] ` +
        `action=${initialDecision.action} ` +
        `topic=${initialDecision.topic} ` +
        `confidence=${initialDecision.confidence.toFixed(2)} ` +
        `source=${initialDecision.source}`,
    );

    if (
      initialDecision.action === "create" &&
      initialDecision.confidence < 0.75
    ) {
      console.log(
        `[Memory skipped: low confidence ` +
          `${initialDecision.confidence.toFixed(2)}]`,
      );

      return;
    }

    if (initialDecision.action === "keep") {
      return;
    }

    const existingMemories = initialDecision.topic
      ? this.memory.findActiveByTopic(initialDecision.topic)
      : [];

    const conflictDecision = await this.analyzeConflict(
      userMessage,
      initialDecision,
      existingMemories,
    );

    console.log(
      `[Memory conflict] ` +
        `conflict=${conflictDecision.conflict} ` +
        `supersedes=${conflictDecision.supersedes} ` +
        `target=${conflictDecision.targetMemoryId ?? "none"} ` +
        `confidence=${conflictDecision.confidence.toFixed(2)}`,
    );

    const targetMemory = conflictDecision.targetMemoryId
      ? existingMemories.find(
          (memory) => memory.id === conflictDecision.targetMemoryId,
        )
      : undefined;

    if (conflictDecision.supersedes && targetMemory) {
      await this.supersedeMemory(initialDecision, targetMemory);

      return;
    }

    if (initialDecision.action === "confirm") {
      const duplicateDecision = await this.findDuplicateMemory(
        initialDecision.memory,
        existingMemories,
      );

      if (duplicateDecision.memoryId) {
        this.memory.confirm(duplicateDecision.memoryId);

        console.log(`[Memory confirmed] ` + `${duplicateDecision.memoryId}`);
      }

      return;
    }

    const duplicateDecision = await this.findDuplicateMemory(
      initialDecision.memory,
      existingMemories,
    );

    if (duplicateDecision.duplicate && duplicateDecision.memoryId) {
      this.memory.confirm(duplicateDecision.memoryId);

      console.log(
        `[Memory duplicate confirmed] ` +
          `${duplicateDecision.memoryId} ` +
          `(similarity=${duplicateDecision.similarity.toFixed(3)})`,
      );

      return;
    }

    const embedding = await this.embeddingService.embed(initialDecision.memory);

    if (initialDecision.action === "update" && targetMemory) {
      this.memory.update(
        targetMemory.id,
        initialDecision.memory,
        embedding,
        initialDecision.importance,
        initialDecision.confidence,
      );

      console.log(`[Memory updated] ` + `${targetMemory.id}`);

      return;
    }

    this.memory.add({
      topic: initialDecision.topic,

      content: initialDecision.memory,

      embedding,

      importance: initialDecision.importance,

      confidence: initialDecision.confidence,

      source: initialDecision.source,

      freshness: "stable",
    });

    console.log(`[Memory created] ` + `${initialDecision.topic}`);
  }

  async search(query: string): Promise<MemorySearchResponse> {
    const temporalIntent = await this.classifyTemporalIntent(query);

    console.log(`[Memory temporal] ` + `intent=${temporalIntent}`);

    const embedding = await this.embeddingService.embed(query);

    const candidates =
      temporalIntent === "historical" || temporalIntent === "mixed"
        ? this.memory.findSimilarIncludingHistory(embedding)
        : this.memory.findSimilar(embedding);

    const candidateDiagnostics = this.buildCandidateDiagnostics(candidates);

    if (candidates.length === 0) {
      return {
        memories: [],

        temporalIntent,

        timelines: [],

        diagnostics: {
          ...candidateDiagnostics,

          rerankedCount: 0,

          relevantCount: 0,
        },
      };
    }

    const reranked = await this.reranker.rerank(query, candidates);

    const memories = this.filterRetrievedMemories(reranked, temporalIntent);

    const timelines =
      temporalIntent === "historical" || temporalIntent === "mixed"
        ? this.buildTimelines(memories)
        : [];

    return {
      memories,

      temporalIntent,

      timelines,

      diagnostics: {
        ...candidateDiagnostics,

        rerankedCount: reranked.length,

        relevantCount: memories.length,
      },
    };
  }

  rescore(): void {
    this.memory.rescore();
  }

  consolidate(): void {
    this.memory.consolidate();
  }

  private buildCandidateDiagnostics(
    candidates: MemorySearchResult[],
  ): Pick<
    MemorySearchDiagnostics,
    "candidateCount" | "activeCandidateCount" | "historicalCandidateCount"
  > {
    let activeCandidateCount = 0;

    let historicalCandidateCount = 0;

    for (const candidate of candidates) {
      if (candidate.memory.lifecycle === "active") {
        activeCandidateCount += 1;
      } else {
        historicalCandidateCount += 1;
      }
    }

    return {
      candidateCount: candidates.length,

      activeCandidateCount,

      historicalCandidateCount,
    };
  }

  private buildTimelines(memories: RerankedMemory[]): MemoryTimeline[] {
    const topics = new Set(memories.map((result) => result.memory.topic));

    const timelines: MemoryTimeline[] = [];

    for (const topic of topics) {
      const timeline = this.memory.findTopicTimeline(topic);

      if (timeline.length === 0) {
        continue;
      }

      timelines.push({
        topic,

        memories: timeline,
      });
    }

    return timelines;
  }

  private async classifyMessage(
    userMessage: string,
  ): Promise<MemoryClassification> {
    const prompt = `
You are the memory classifier
for a personal AI assistant.

Determine whether the user's message
contains information worth storing as
long-term memory about the user.

Classify the message as one of:

create
genuinely new long-term information

update
the user is changing or correcting
information they previously gave

confirm
the user is reaffirming information
they likely already stated

keep
no useful long-term memory should
be created or changed

USER MESSAGE:
${userMessage}

Return ONLY valid JSON:

{
  "action": "create",
  "topic": "fitness_goal",
  "memory": "User is training for a duathlon this year.",
  "importance": 4,
  "confidence": 0.95,
  "source": "explicit"
}

Rules:

Only store information about the user.

Do not store general facts or questions.

Do not store the assistant's information.

Do not invent information.

Prefer explicit information over inference.

Use "explicit" when the user directly states something.

Use "inferred" only when the information is
strongly implied by the user's statement.

Use "updated" when the user clearly changes
or corrects previously stated information.

importance must be between 1 and 5.

confidence must be between 0 and 1.

For direct explicit statements about the user,
confidence should normally be high.

For inferred memories, confidence should be
lower than for direct explicit statements.

topic should be short and stable.

memory should be a concise factual statement.

For questions, normally use "keep".

For temporary events, do not automatically
treat them as permanent preferences.
`;

    const result = await this.classifierModel.generate({
      prompt,

      maxTokens: 300,

      thinking: false,
    });

    try {
      const parsed = JSON.parse(result) as {
        action?: unknown;

        topic?: unknown;

        memory?: unknown;

        importance?: unknown;

        confidence?: unknown;

        source?: unknown;
      };

      const validActions = ["create", "update", "confirm", "keep"] as const;

      const validSources = ["explicit", "inferred", "updated"] as const;

      const action = validActions.includes(
        parsed.action as (typeof validActions)[number],
      )
        ? (parsed.action as MemoryClassification["action"])
        : "keep";

      const source = validSources.includes(
        parsed.source as (typeof validSources)[number],
      )
        ? (parsed.source as MemoryClassification["source"])
        : "explicit";

      const topic = typeof parsed.topic === "string" ? parsed.topic.trim() : "";

      const memory =
        typeof parsed.memory === "string" ? parsed.memory.trim() : "";

      const importance =
        typeof parsed.importance === "number"
          ? Math.min(5, Math.max(1, parsed.importance))
          : 3;

      const confidence =
        typeof parsed.confidence === "number"
          ? Math.min(1, Math.max(0, parsed.confidence))
          : 0;

      if (action !== "keep" && (!topic || !memory)) {
        return {
          action: "keep",

          topic: "",

          memory: "",

          importance: 1,

          confidence: 0,

          source,
        };
      }

      return {
        action,

        topic,

        memory,

        importance,

        confidence,

        source,
      };
    } catch {
      return {
        action: "keep",

        topic: "",

        memory: "",

        importance: 1,

        confidence: 0,

        source: "explicit",
      };
    }
  }

  private async analyzeConflict(
    userMessage: string,
    classification: MemoryClassification,
    existingMemories: Memory[],
  ): Promise<MemoryConflictDecision> {
    if (existingMemories.length === 0) {
      return {
        conflict: false,

        supersedes: false,

        confidence: 1,
      };
    }

    const existingMemoryContext = existingMemories
      .map(
        (memory) =>
          `ID: ${memory.id}\n` +
          `Topic: ${memory.topic}\n` +
          `Memory: ${memory.content}`,
      )
      .join("\n\n");

    const prompt = `
You are a memory conflict analyzer.

Determine whether the user's new information
conflicts with or replaces an existing memory.

USER MESSAGE:
${userMessage}

PROPOSED MEMORY:
${classification.memory}

EXISTING ACTIVE MEMORIES:
${existingMemoryContext}

Return ONLY valid JSON:

{
  "conflict": false,
  "supersedes": false,
  "targetMemoryId": null,
  "confidence": 0.95
}

Rules:

conflict=true when the new information
contradicts an existing memory.

supersedes=true when the new information
replaces an existing memory.

If supersedes=true, targetMemoryId MUST
identify the specific existing memory.

If no memory is replaced,
targetMemoryId must be null.

Do not invent memory IDs.

Unrelated memories are not conflicts.

Additional information is not necessarily
a conflict.

A temporary situation does not necessarily
replace a permanent fact.

confidence must be between 0 and 1.
`;

    const result = await this.memoryModel.generate({
      prompt,

      maxTokens: 250,

      thinking: false,
    });

    console.log(`[Memory conflict raw] ${result}`);

    try {
      const parsed = JSON.parse(result) as {
        conflict?: unknown;

        supersedes?: unknown;

        targetMemoryId?: unknown;

        confidence?: unknown;
      };

      const targetMemoryId =
        typeof parsed.targetMemoryId === "string"
          ? parsed.targetMemoryId
          : undefined;

      const validTarget =
        targetMemoryId &&
        existingMemories.some((memory) => memory.id === targetMemoryId)
          ? targetMemoryId
          : undefined;

      const confidence =
        typeof parsed.confidence === "number"
          ? Math.min(1, Math.max(0, parsed.confidence))
          : 0;

      const supersedes = Boolean(parsed.supersedes) && Boolean(validTarget);

      const conflict = Boolean(parsed.conflict) && Boolean(validTarget);

      return {
        conflict,

        supersedes,

        ...(validTarget
          ? {
              targetMemoryId: validTarget,
            }
          : {}),

        confidence,
      };
    } catch {
      return {
        conflict: false,

        supersedes: false,

        confidence: 0,
      };
    }
  }

  private async findDuplicateMemory(
    content: string,
    existingMemories: Memory[],
  ): Promise<DuplicateDecision> {
    if (existingMemories.length === 0) {
      return {
        duplicate: false,

        similarity: 0,
      };
    }

    const embedding = await this.embeddingService.embed(content);

    let bestMemory: Memory | undefined;

    let bestSimilarity = 0;

    for (const memory of existingMemories) {
      const similarity = this.cosineSimilarity(embedding, memory.embedding);

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;

        bestMemory = memory;
      }
    }

    const threshold = 0.85;

    return {
      duplicate: bestSimilarity >= threshold,

      ...(bestMemory
        ? {
            memoryId: bestMemory.id,
          }
        : {}),

      similarity: bestSimilarity,
    };
  }

  private async supersedeMemory(
    classification: MemoryClassification,
    targetMemory: Memory,
  ): Promise<void> {
    this.memory.supersede(targetMemory.id);

    const activeMemories = this.memory.findActiveByTopic(targetMemory.topic);

    const duplicateThreshold = 0.85;

    for (const memory of activeMemories) {
      if (memory.id === targetMemory.id) {
        continue;
      }

      const similarity = this.cosineSimilarity(
        targetMemory.embedding,
        memory.embedding,
      );

      if (similarity >= duplicateThreshold) {
        this.memory.supersede(memory.id);

        console.log(
          `[Memory duplicate superseded] ` +
            `${memory.id} ` +
            `(similarity=${similarity.toFixed(3)})`,
        );
      }
    }

    const embedding = await this.embeddingService.embed(classification.memory);

    this.memory.add({
      topic: classification.topic,

      content: classification.memory,

      embedding,

      importance: classification.importance,

      confidence: classification.confidence,

      source: "updated",

      freshness: "stable",

      supersedesId: targetMemory.id,
    });

    console.log(`[Memory superseded] ` + `${targetMemory.id} → new memory`);
  }

  private async classifyTemporalIntent(query: string): Promise<TemporalIntent> {
    if (this.isMixedTemporalQuery(query)) {
      return "mixed";
    }

    if (this.isHistoricalQuery(query)) {
      return "historical";
    }

    const prompt = `
You are a temporal intent classifier
for a personal AI memory system.

Classify the user's question as:

"current"
The user is asking about their current
or present state.

"historical"
The user is asking about a previous,
older, past, or superseded state.

"mixed"
The user is asking about both current
and historical state, or about how
something changed over time.

Return ONLY valid JSON:

{
  "intent": "current"
}

Examples:

"What programming language am I using?"
=> current

"What language did I use before switching?"
=> historical

"What was my stack back then?"
=> historical

"How has my programming language changed?"
=> mixed

"What did I use before, and what do I use now?"
=> mixed

USER QUESTION:
${query}
`;

    const result = await this.memoryModel.generate({
      prompt,

      maxTokens: 100,

      thinking: false,
    });

    try {
      const parsed = JSON.parse(result) as {
        intent?: unknown;
      };

      if (
        parsed.intent === "current" ||
        parsed.intent === "historical" ||
        parsed.intent === "mixed"
      ) {
        return parsed.intent;
      }
    } catch {
      /*
       * Safe fallback below.
       */
    }

    return "current";
  }

  private isMixedTemporalQuery(query: string): boolean {
    const mixedPatterns = [
      /\bbefore\b.*\bnow\b/i,

      /\bnow\b.*\bbefore\b/i,

      /\bpreviously\b.*\bnow\b/i,

      /\bnow\b.*\bpreviously\b/i,

      /\bused to\b.*\bnow\b/i,

      /\bchanged\b.*\bover time\b/i,

      /\bhow has\b.*\bchanged\b/i,

      /\bhow did\b.*\bchange\b/i,

      /\bthen\b.*\bnow\b/i,

      /\bnow\b.*\bthen\b/i,
    ];

    return mixedPatterns.some((pattern) => pattern.test(query));
  }

  private isHistoricalQuery(query: string): boolean {
    const historicalPatterns = [
      /\bpreviously\b/i,

      /\bprevious\b/i,

      /\bbefore\b/i,

      /\bused to\b/i,

      /\bformerly\b/i,

      /\bearlier\b/i,

      /\bpast\b/i,

      /\bwas i\b/i,

      /\bdid i\b.*\bbefore\b/i,

      /\bback then\b/i,
    ];

    return historicalPatterns.some((pattern) => pattern.test(query));
  }

  private filterRetrievedMemories(
    memories: RerankedMemory[],
    temporalIntent: TemporalIntent,
  ): RerankedMemory[] {
    const minimumSemanticScore = temporalIntent === "current" ? 0.25 : 0.1;

    const maximumMemories = 5;

    return memories
      .filter((result) => result.semanticConfidence >= minimumSemanticScore)
      .slice(0, maximumMemories);
  }

  private shouldInspectMemory(userMessage: string): boolean {
    const text = userMessage.trim();

    if (!text) {
      return false;
    }

    if (
      text.endsWith("?") ||
      /^(what|why|how|when|where|who|which|can|could|would|should|is|are|do|does|did)\b/i.test(
        text,
      )
    ) {
      return false;
    }

    if (/\b(i|i'm|i am|i've|i have|i'll|i will|my|me)\b/i.test(text)) {
      return true;
    }

    if (
      /\b(prefer|like|love|hate|enjoy|use|work with|work in|learning|learn|training|train|planning|plan to|want to|trying to|usually|always|often)\b/i.test(
        text,
      )
    ) {
      return true;
    }

    return false;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dot = 0;

    let magnitudeA = 0;

    let magnitudeB = 0;

    for (let i = 0; i < a.length; i++) {
      const valueA = a[i];

      const valueB = b[i];

      if (valueA === undefined || valueB === undefined) {
        continue;
      }

      dot += valueA * valueB;

      magnitudeA += valueA * valueA;

      magnitudeB += valueB * valueB;
    }

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
  }
}
