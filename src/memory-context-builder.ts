import type { RerankedMemory } from "./memory-reranker.js";

import type { MemoryTimeline, MemorySearchResponse } from "./memory-manager.js";

export interface MemoryContextResult {
  context: string;

  selectedCount: number;

  droppedCount: number;

  charactersUsed: number;
}

export class MemoryContextBuilder {
  constructor(private readonly maximumCharacters = 2500) {}

  build(searchResult: MemorySearchResponse): MemoryContextResult {
    const { memories, temporalIntent, timelines } = searchResult;

    if (memories.length === 0) {
      return {
        context: "",
        selectedCount: 0,
        droppedCount: 0,
        charactersUsed: 0,
      };
    }

    const rankedMemories = [...memories].sort((a, b) => a.rank - b.rank);

    const selectedMemories: RerankedMemory[] = [];

    /*
     * Historical and mixed questions should
     * retain at least one historical memory
     * when one is available.
     */
    if (temporalIntent === "historical" || temporalIntent === "mixed") {
      const bestHistorical = rankedMemories.find(
        (result) => result.memory.lifecycle === "stale",
      );

      if (bestHistorical) {
        selectedMemories.push(bestHistorical);
      }
    }

    /*
     * Add memories in relevance order while
     * respecting the context budget.
     *
     * The timeline is included in the proposed
     * context calculation so memories cannot
     * consume space reserved by chronology.
     */
    for (const memory of rankedMemories) {
      const alreadySelected = selectedMemories.some(
        (selected) => selected.memory.id === memory.memory.id,
      );

      if (alreadySelected) {
        continue;
      }

      const proposedMemories = [...selectedMemories, memory];

      const proposedContext = this.formatContext(
        proposedMemories,
        temporalIntent,
        timelines,
      );

      if (proposedContext.length <= this.maximumCharacters) {
        selectedMemories.push(memory);
      }
    }

    /*
     * Build the final context.
     */
    let context = this.formatContext(
      selectedMemories,
      temporalIntent,
      timelines,
    );

    /*
     * A timeline can theoretically make the
     * context exceed the budget even when the
     * selected memories are small.
     *
     * If that happens, rebuild without the
     * timeline rather than truncating memory
     * text in the middle of a statement.
     */
    if (context.length > this.maximumCharacters) {
      context = this.formatContext(selectedMemories, temporalIntent, []);
    }

    return {
      context,

      selectedCount: selectedMemories.length,

      droppedCount: memories.length - selectedMemories.length,

      charactersUsed: context.length,
    };
  }

  private formatContext(
    memories: RerankedMemory[],
    temporalIntent: MemorySearchResponse["temporalIntent"],
    timelines: MemoryTimeline[],
  ): string {
    const currentMemories = memories.filter(
      (result) => result.memory.lifecycle === "active",
    );

    const historicalMemories = memories.filter(
      (result) => result.memory.lifecycle === "stale",
    );

    const sections: string[] = [];

    if (currentMemories.length > 0) {
      sections.push(this.buildSection("CURRENT MEMORY", currentMemories));
    }

    if (historicalMemories.length > 0) {
      sections.push(this.buildSection("HISTORICAL MEMORY", historicalMemories));
    }

    /*
     * Chronological timelines are useful only
     * when the user is asking about the past
     * or about changes over time.
     */
    if (temporalIntent === "historical" || temporalIntent === "mixed") {
      for (const timeline of timelines) {
        if (timeline.memories.length <= 1) {
          continue;
        }

        sections.push(this.buildTimelineSection(timeline));
      }
    }

    return sections.join("\n\n");
  }

  private buildSection(title: string, memories: RerankedMemory[]): string {
    return [
      `${title}:`,

      ...memories.map((result) => `- ${result.memory.content}`),
    ].join("\n");
  }

  private buildTimelineSection(timeline: MemoryTimeline): string {
    return [
      `MEMORY TIMELINE — ${timeline.topic}:`,

      ...timeline.memories.map((memory, index) => {
        const state = memory.lifecycle === "active" ? "current" : "historical";

        return `${index + 1}. ` + `[${state}] ` + `${memory.content}`;
      }),
    ].join("\n");
  }
}
