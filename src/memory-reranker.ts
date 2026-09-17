import type { AIModel } from "./models/local-model.js";
import type { MemorySearchResult } from "./long-term-memory.js";

export interface RerankedMemory extends MemorySearchResult {
  relevance: "relevant";
  rank: number;
}

interface RerankerResponse {
  ranked?: unknown;
}

export class MemoryReranker {
  constructor(private readonly model: AIModel) {}

  async rerank(
    query: string,
    candidates: MemorySearchResult[],
  ): Promise<RerankedMemory[]> {
    if (candidates.length === 0) {
      return [];
    }

    candidates = this.deduplicateCandidates(candidates);

    if (candidates.length === 0) {
      return [];
    }

    const memories = candidates
      .map((candidate, index) =>
        [
          `${index}: ${candidate.memory.content}`,
          `semantic_score: ${candidate.score.toFixed(3)}`,
          `importance: ${candidate.memory.importance}/5`,
        ].join(" | "),
      )
      .join("\n");

    const prompt = `
You are a memory relevance evaluator
for a personal AI assistant.

Rank the candidate memories by how useful they are
for answering the user's current question.

Semantic relevance is the PRIMARY signal.

Importance is a SECONDARY signal.

A highly relevant memory should normally rank above
a highly important memory that is unrelated.

Do NOT rank a memory highly merely because its
importance is high.

USER QUESTION:
${query}

CANDIDATE MEMORIES:
${memories}

Return ONLY valid JSON:

{
  "ranked": [2, 0, 1]
}

Rules:
- "ranked" must contain candidate indexes.
- Order the indexes from MOST relevant to LEAST relevant.
- Only include memories that are genuinely useful
  for answering the question.
- Reject unrelated memories.
- An empty ranked array is valid.
- Do not invent indexes.
- Do not invent memories.
- Use semantic relevance as the primary signal.
- Use importance only as a secondary tie-breaking signal.
`;

    const result = await this.model.generate({
      prompt,
      maxTokens: 250,
      thinking: false,
    });

    try {
      const parsed = JSON.parse(result) as RerankerResponse;

      if (!Array.isArray(parsed.ranked)) {
        return [];
      }

      const indexes = parsed.ranked.filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0 &&
          value < candidates.length,
      );

      const uniqueIndexes = [...new Set(indexes)];

      return uniqueIndexes.flatMap((index, rank) => {
        const candidate = candidates[index];

        if (!candidate) {
          return [];
        }

        return [
          {
            ...candidate,

            relevance: "relevant" as const,

            rank: rank + 1,
          },
        ];
      });
    } catch {
      return [];
    }
  }

  private deduplicateCandidates(
    candidates: MemorySearchResult[],
  ): MemorySearchResult[] {
    const threshold = 0.85;

    const unique: MemorySearchResult[] = [];

    for (const candidate of candidates) {
      const duplicate = unique.some(
        (existing) =>
          this.cosineSimilarity(
            candidate.memory.embedding,
            existing.memory.embedding,
          ) >= threshold,
      );

      if (!duplicate) {
        unique.push(candidate);
      }
    }

    return unique;
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
