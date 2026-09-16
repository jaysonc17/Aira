import {
  randomUUID,
} from "node:crypto";

import fs from "node:fs";

import path from "node:path";

export type MemorySource =
  | "explicit"
  | "inferred"
  | "updated";

export type MemoryLifecycle =
  | "active"
  | "stale";

export type MemoryFreshness =
  | "stable"
  | "temporary"
  | "dynamic";

export interface Memory {
  id: string;

  topic: string;

  content: string;

  createdAt: string;

  lastConfirmedAt: string;

  importance: number;

  confidence: number;

  embedding: number[];

  source: MemorySource;

  lifecycle: MemoryLifecycle;

  freshness: MemoryFreshness;

  supersedesId?: string;
}

export interface AddMemoryInput {
  topic: string;

  content: string;

  embedding: number[];

  importance?: number;

  confidence?: number;

  source?: MemorySource;

  freshness?: MemoryFreshness;

  supersedesId?: string;
}

export interface MemorySearchResult {
  memory: Memory;

  score: number;

  combinedScore: number;

  semanticConfidence: number;

  importanceScore: number;

  freshnessScore: number;

  confidenceScore: number;

  sourceReliabilityScore: number;
}

export class LongTermMemory {
  private memories: Memory[] = [];

  private readonly filePath: string;

  constructor(
    filePath = path.join(
      process.cwd(),
      "long-term-memory.json",
    ),
  ) {
    this.filePath =
      filePath;

    this.load();
  }

  add(
    input: AddMemoryInput,
  ): Memory {
    const now =
      new Date().toISOString();

    const memory: Memory = {
      id: randomUUID(),

      topic:
        input.topic,

      content:
        input.content,

      createdAt: now,

      lastConfirmedAt: now,

      importance:
        this.clampImportance(
          input.importance ?? 3,
        ),

      confidence:
        this.clampConfidence(
          input.confidence ?? 1,
        ),

      embedding:
        input.embedding,

      source:
        input.source ??
        "explicit",

      lifecycle:
        "active",

      freshness:
        input.freshness ??
        "stable",

      ...(input.supersedesId
        ? {
            supersedesId:
              input.supersedesId,
          }
        : {}),
    };

    this.memories.push(
      memory,
    );

    this.save();

    return memory;
  }

  update(
    id: string,
    content: string,
    embedding: number[],
    importance?: number,
    confidence?: number,
  ): Memory | undefined {
    const memory =
      this.memories.find(
        (item) =>
          item.id === id,
      );

    if (!memory) {
      return undefined;
    }

    memory.content =
      content;

    memory.embedding =
      embedding;

    memory.lastConfirmedAt =
      new Date().toISOString();

    memory.source =
      "updated";

    memory.lifecycle =
      "active";

    if (
      importance !==
      undefined
    ) {
      memory.importance =
        this.clampImportance(
          importance,
        );
    }

    if (
      confidence !==
      undefined
    ) {
      memory.confidence =
        this.clampConfidence(
          confidence,
        );
    }

    this.save();

    return memory;
  }

  confirm(
    id: string,
  ): Memory | undefined {
    const memory =
      this.memories.find(
        (item) =>
          item.id === id,
      );

    if (!memory) {
      return undefined;
    }

    memory.lastConfirmedAt =
      new Date().toISOString();

    memory.lifecycle =
      "active";

    memory.confidence =
      this.clampConfidence(
        memory.confidence +
          0.05,
      );

    this.save();

    return memory;
  }

  supersede(
    id: string,
  ): Memory | undefined {
    const memory =
      this.memories.find(
        (item) =>
          item.id === id,
      );

    if (!memory) {
      return undefined;
    }

    memory.lifecycle =
      "stale";

    this.save();

    return memory;
  }

  setImportance(
    id: string,
    importance: number,
  ): Memory | undefined {
    const memory =
      this.memories.find(
        (item) =>
          item.id === id,
      );

    if (!memory) {
      return undefined;
    }

    memory.importance =
      this.clampImportance(
        importance,
      );

    this.save();

    return memory;
  }

  setConfidence(
    id: string,
    confidence: number,
  ): Memory | undefined {
    const memory =
      this.memories.find(
        (item) =>
          item.id === id,
      );

    if (!memory) {
      return undefined;
    }

    memory.confidence =
      this.clampConfidence(
        confidence,
      );

    this.save();

    return memory;
  }

  setLifecycle(
    id: string,
    lifecycle:
      MemoryLifecycle,
  ): Memory | undefined {
    const memory =
      this.memories.find(
        (item) =>
          item.id === id,
      );

    if (!memory) {
      return undefined;
    }

    memory.lifecycle =
      lifecycle;

    this.save();

    return memory;
  }

  findByTopic(
    topic: string,
  ): Memory | undefined {
    return this.memories.find(
      (memory) =>
        memory.topic ===
          topic &&
        memory.lifecycle ===
          "active",
    );
  }

  findActiveByTopic(
    topic: string,
  ): Memory[] {
    return this.memories.filter(
      (memory) =>
        memory.topic ===
          topic &&
        memory.lifecycle ===
          "active",
    );
  }

  findSimilar(
    queryEmbedding: number[],
    threshold = 0.20,
  ): MemorySearchResult[] {
    return this.findSimilarInternal(
      queryEmbedding,

      this.memories.filter(
        (memory) =>
          memory.lifecycle ===
          "active",
      ),

      threshold,
    );
  }

  findSimilarIncludingHistory(
    queryEmbedding: number[],
    threshold = 0,
  ): MemorySearchResult[] {
    return this.findSimilarInternal(
      queryEmbedding,
      this.memories,
      threshold,
    );
  }

  private findSimilarInternal(
    queryEmbedding: number[],
    memories: Memory[],
    threshold: number,
  ): MemorySearchResult[] {
    const now =
      new Date();

    return memories
      .map(
        (memory) => {
          const score =
            this.cosineSimilarity(
              queryEmbedding,
              memory.embedding,
            );

          const semanticConfidence =
            Math.max(
              0,
              Math.min(
                1,
                score,
              ),
            );

          const importanceScore =
            memory.importance /
            5;

          const freshnessScore =
            this.getFreshnessScore(
              memory,
              now,
            );

          const confidenceScore =
            this.clampConfidence(
              memory.confidence,
            );

          const sourceReliabilityScore =
            this.getSourceReliabilityScore(
              memory.source,
            );

          /*
           * Semantic relevance remains the
           * dominant retrieval signal.
           *
           * Confidence and source reliability
           * can improve ordering between
           * otherwise relevant memories, but
           * cannot bypass the semantic gates
           * applied later by MemoryManager.
           */
          const combinedScore =
            semanticConfidence *
              0.65 +
            importanceScore *
              0.10 +
            freshnessScore *
              0.10 +
            confidenceScore *
              0.10 +
            sourceReliabilityScore *
              0.05;

          return {
            memory,

            score,

            combinedScore,

            semanticConfidence,

            importanceScore,

            freshnessScore,

            confidenceScore,

            sourceReliabilityScore,
          };
        },
      )
      .filter(
        (result) =>
          result.score >=
          threshold,
      )
      .sort(
        (a, b) =>
          b.combinedScore -
          a.combinedScore,
      );
  }

  findHistory(
    id: string,
  ): Memory[] {
    const history:
      Memory[] = [];

    const visited =
      new Set<string>();

    let current =
      this.memories.find(
        (memory) =>
          memory.id === id,
      );

    while (current) {
      if (
        visited.has(
          current.id,
        )
      ) {
        break;
      }

      visited.add(
        current.id,
      );

      history.push(
        current,
      );

      if (
        !current.supersedesId
      ) {
        break;
      }

      const supersedesId =
        current.supersedesId;

      current =
        this.memories.find(
          (memory) =>
            memory.id ===
            supersedesId,
        );
    }

    return history;
  }

  findTopicHistory(
    topic: string,
  ): Memory[] {
    return this.memories
      .filter(
        (memory) =>
          memory.topic ===
          topic,
      )
      .sort(
        (a, b) =>
          this.getTimestamp(
            b.createdAt,
          ) -
          this.getTimestamp(
            a.createdAt,
          ),
      );
  }

  findTopicTimeline(
    topic: string,
  ): Memory[] {
    const topicMemories =
      this.memories.filter(
        (memory) =>
          memory.topic ===
          topic,
      );

    if (
      topicMemories.length ===
      0
    ) {
      return [];
    }

    const supersededIds =
      new Set(
        topicMemories
          .map(
            (memory) =>
              memory.supersedesId,
          )
          .filter(
            (
              id,
            ): id is string =>
              typeof id ===
              "string",
          ),
      );

    const heads =
      topicMemories.filter(
        (memory) =>
          !supersededIds.has(
            memory.id,
          ),
      );

    const canonicalHead =
      [...heads].sort(
        (a, b) => {
          if (
            a.lifecycle !==
            b.lifecycle
          ) {
            return (
              a.lifecycle ===
              "active"
                ? -1
                : 1
            );
          }

          return (
            this.getTimestamp(
              b.lastConfirmedAt,
            ) -
            this.getTimestamp(
              a.lastConfirmedAt,
            )
          );
        },
      )[0];

    if (!canonicalHead) {
      return [
        ...topicMemories,
      ].sort(
        (a, b) =>
          this.getTimestamp(
            a.createdAt,
          ) -
          this.getTimestamp(
            b.createdAt,
          ),
      );
    }

    const canonicalTimeline =
      this.findHistory(
        canonicalHead.id,
      )
        .filter(
          (memory) =>
            memory.topic ===
            topic,
        )
        .reverse();

    const canonicalIds =
      new Set(
        canonicalTimeline.map(
          (memory) =>
            memory.id,
        ),
      );

    const orphanMemories =
      topicMemories.filter(
        (memory) =>
          !canonicalIds.has(
            memory.id,
          ),
      );

    const recoverableOrphans =
      orphanMemories.filter(
        (orphan) =>
          this.isRecoverableTimelineMemory(
            orphan,
            canonicalTimeline,
          ),
      );

    if (
      recoverableOrphans.length ===
      0
    ) {
      return canonicalTimeline;
    }

    const reconstructed = [
      ...canonicalTimeline,
      ...recoverableOrphans,
    ];

    const uniqueById =
      new Map<
        string,
        Memory
      >();

    for (
      const memory of
        reconstructed
    ) {
      uniqueById.set(
        memory.id,
        memory,
      );
    }

    return [
      ...uniqueById.values(),
    ].sort(
      (a, b) => {
        const createdDifference =
          this.getTimestamp(
            a.createdAt,
          ) -
          this.getTimestamp(
            b.createdAt,
          );

        if (
          createdDifference !==
          0
        ) {
          return createdDifference;
        }

        return (
          this.getTimestamp(
            a.lastConfirmedAt,
          ) -
          this.getTimestamp(
            b.lastConfirmedAt,
          )
        );
      },
    );
  }

  private isRecoverableTimelineMemory(
    candidate: Memory,
    canonicalTimeline:
      Memory[],
  ): boolean {
    if (
      candidate.lifecycle !==
      "stale"
    ) {
      return false;
    }

    if (
      candidate.embedding.length ===
      0
    ) {
      return false;
    }

    let bestSimilarity =
      0;

    for (
      const canonical of
        canonicalTimeline
    ) {
      const exactDuplicate =
        this.normalise(
          candidate.content,
        ) ===
        this.normalise(
          canonical.content,
        );

      if (exactDuplicate) {
        return false;
      }

      if (
        canonical.embedding.length ===
        0
      ) {
        continue;
      }

      const similarity =
        this.cosineSimilarity(
          candidate.embedding,
          canonical.embedding,
        );

      bestSimilarity =
        Math.max(
          bestSimilarity,
          similarity,
        );
    }

    return (
      bestSimilarity >=
      0.75
    );
  }

  delete(
    id: string,
  ): boolean {
    const originalLength =
      this.memories.length;

    this.memories =
      this.memories.filter(
        (memory) =>
          memory.id !== id,
      );

    const deleted =
      this.memories.length !==
      originalLength;

    if (deleted) {
      this.save();
    }

    return deleted;
  }

  getAll(): Memory[] {
    return [
      ...this.memories,
    ];
  }

  clear(): void {
    this.memories = [];

    this.save();
  }

  rescore(): void {
    for (
      const memory of
        this.memories
    ) {
      if (
        memory.lifecycle ===
        "stale"
      ) {
        memory.importance =
          Math.max(
            1,
            memory.importance -
              1,
          );
      }
    }

    this.save();
  }

  consolidate(): void {
    const activeByTopic =
      new Map<
        string,
        Memory[]
      >();

    for (
      const memory of
        this.memories
    ) {
      if (
        memory.lifecycle !==
        "active"
      ) {
        continue;
      }

      const existing =
        activeByTopic.get(
          memory.topic,
        ) ?? [];

      existing.push(
        memory,
      );

      activeByTopic.set(
        memory.topic,
        existing,
      );
    }

    for (
      const memories of
        activeByTopic.values()
    ) {
      if (
        memories.length <=
        1
      ) {
        continue;
      }

      const sorted =
        [...memories].sort(
          (a, b) =>
            this.getTimestamp(
              b.lastConfirmedAt,
            ) -
            this.getTimestamp(
              a.lastConfirmedAt,
            ),
        );

      const latest =
        sorted[0];

      if (!latest) {
        continue;
      }

      for (
        const memory of
          sorted.slice(1)
      ) {
        const exactDuplicate =
          this.normalise(
            memory.content,
          ) ===
          this.normalise(
            latest.content,
          );

        const semanticSimilarity =
          this.cosineSimilarity(
            memory.embedding,
            latest.embedding,
          );

        const semanticDuplicate =
          semanticSimilarity >=
          0.85;

        if (
          exactDuplicate ||
          semanticDuplicate
        ) {
          memory.lifecycle =
            "stale";
        }
      }
    }

    this.save();
  }

  private getFreshnessScore(
    memory: Memory,
    now: Date,
  ): number {
    const confirmedAt =
      new Date(
        memory.lastConfirmedAt,
      );

    const ageMs =
      now.getTime() -
      confirmedAt.getTime();

    const ageDays =
      Math.max(
        0,
        ageMs /
          (
            1000 *
            60 *
            60 *
            24
          ),
      );

    switch (
      memory.freshness
    ) {
      case "temporary":
        return Math.max(
          0,
          1 -
            ageDays /
              30,
        );

      case "dynamic":
        return Math.max(
          0,
          1 -
            ageDays /
              90,
        );

      case "stable":
      default:
        return Math.max(
          0,
          1 -
            ageDays /
              365,
        );
    }
  }

  private getSourceReliabilityScore(
    source: MemorySource,
  ): number {
    switch (source) {
      case "explicit":
        return 1;

      case "updated":
        return 1;

      case "inferred":
        return 0.70;

      default:
        return 0.70;
    }
  }

  private clampImportance(
    importance: number,
  ): number {
    return Math.min(
      5,
      Math.max(
        1,
        importance,
      ),
    );
  }

  private clampConfidence(
    confidence: number,
  ): number {
    return Math.min(
      1,
      Math.max(
        0,
        confidence,
      ),
    );
  }

  private cosineSimilarity(
    a: number[],
    b: number[],
  ): number {
    if (
      a.length !==
      b.length
    ) {
      return 0;
    }

    let dot = 0;

    let magnitudeA = 0;

    let magnitudeB = 0;

    for (
      let i = 0;
      i < a.length;
      i++
    ) {
      const valueA =
        a[i];

      const valueB =
        b[i];

      if (
        valueA ===
          undefined ||
        valueB ===
          undefined
      ) {
        continue;
      }

      dot +=
        valueA *
        valueB;

      magnitudeA +=
        valueA *
        valueA;

      magnitudeB +=
        valueB *
        valueB;
    }

    if (
      magnitudeA === 0 ||
      magnitudeB === 0
    ) {
      return 0;
    }

    return (
      dot /
      (
        Math.sqrt(
          magnitudeA,
        ) *
        Math.sqrt(
          magnitudeB,
        )
      )
    );
  }

  private getTimestamp(
    value: string,
  ): number {
    const timestamp =
      new Date(
        value,
      ).getTime();

    return Number.isFinite(
      timestamp,
    )
      ? timestamp
      : 0;
  }

  private normalise(
    text: string,
  ): string {
    return text
      .trim()
      .toLowerCase()
      .replace(
        /\s+/g,
        " ",
      );
  }

  private load(): void {
    if (
      !fs.existsSync(
        this.filePath,
      )
    ) {
      this.memories = [];

      return;
    }

    try {
      const raw =
        fs.readFileSync(
          this.filePath,
          "utf-8",
        );

      const parsed =
        JSON.parse(
          raw,
        );

      if (
        !Array.isArray(
          parsed,
        )
      ) {
        this.memories = [];

        return;
      }

      const now =
        new Date()
          .toISOString();

      this.memories =
        parsed
          .filter(
            (
              memory:
                unknown,
            ): memory is
              Record<
                string,
                unknown
              > =>
              Boolean(
                memory &&
                typeof memory ===
                  "object",
              ),
          )
          .map(
            (
              memory:
                Record<
                  string,
                  unknown
                >,
            ): Memory => {
              const createdAt =
                typeof memory.createdAt ===
                "string"
                  ? memory.createdAt
                  : now;

              const source:
                MemorySource =
                memory.source ===
                  "inferred" ||
                memory.source ===
                  "updated"
                  ? memory.source
                  : "explicit";

              const confidence =
                typeof memory.confidence ===
                "number"
                  ? this.clampConfidence(
                      memory.confidence,
                    )
                  : source ===
                      "inferred"
                    ? 0.70
                    : 1;

              return {
                id:
                  typeof memory.id ===
                  "string"
                    ? memory.id
                    : randomUUID(),

                topic:
                  typeof memory.topic ===
                  "string"
                    ? memory.topic
                    : "",

                content:
                  typeof memory.content ===
                  "string"
                    ? memory.content
                    : "",

                createdAt,

                lastConfirmedAt:
                  typeof memory.lastConfirmedAt ===
                  "string"
                    ? memory.lastConfirmedAt
                    : createdAt,

                importance:
                  typeof memory.importance ===
                  "number"
                    ? this.clampImportance(
                        memory.importance,
                      )
                    : 3,

                confidence,

                embedding:
                  Array.isArray(
                    memory.embedding,
                  )
                    ? memory.embedding.filter(
                        (
                          value,
                        ): value is number =>
                          typeof value ===
                            "number",
                      )
                    : [],

                source,

                lifecycle:
                  memory.lifecycle ===
                  "stale"
                    ? "stale"
                    : "active",

                freshness:
                  memory.freshness ===
                    "temporary" ||
                  memory.freshness ===
                    "dynamic"
                    ? memory.freshness
                    : "stable",

                ...(typeof memory.supersedesId ===
                  "string"
                  ? {
                      supersedesId:
                        memory.supersedesId,
                    }
                  : {}),
              };
            },
          )
          .filter(
            (memory) =>
              Boolean(
                memory.topic,
              ) &&
              Boolean(
                memory.content,
              ),
          );
    } catch (error) {
      console.error(
        "[LongTermMemory] Failed to load memory file:",
        error,
      );

      this.memories = [];
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          this.memories,
          null,
          2,
        ),
        "utf-8",
      );
    } catch (error) {
      console.error(
        "[LongTermMemory] Failed to save memory file:",
        error,
      );
    }
  }
}