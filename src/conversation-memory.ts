import type {
  ConversationSummarizer,
  ConversationSummary,
} from "./conversation-summarizer.js";

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  createdAt: string;
}

export interface ConversationMemoryOptions {
  maximumMessages?: number;
  maximumCharacters?: number;
  summarizer?: ConversationSummarizer;
}

export class ConversationMemory {
  private readonly messages: ConversationMessage[] = [];

  private readonly maximumMessages: number;

  private readonly maximumCharacters: number;

  private readonly summarizer: ConversationSummarizer | undefined;

  private summary: ConversationSummary | undefined;

  constructor(options: ConversationMemoryOptions = {}) {
    this.maximumMessages = options.maximumMessages ?? 12;

    this.maximumCharacters = options.maximumCharacters ?? 6000;

    this.summarizer = options.summarizer;
  }

  addUserMessage(content: string): void {
    this.addMessage("user", content);
  }

  async addAssistantMessage(content: string): Promise<void> {
    this.addMessage("assistant", content);

    await this.trim();
  }

  getMessages(): ConversationMessage[] {
    return this.messages.map((message) => ({
      ...message,
    }));
  }

  getHistory(): Array<{
    role: "user" | "assistant";
    content: string;
  }> {
    return this.messages.map((message) => ({
      role: message.role,

      content: message.content,
    }));
  }

  getSummary(): ConversationSummary | undefined {
    if (!this.summary) {
      return undefined;
    }

    return {
      ...this.summary,
    };
  }

  getSummaryContent(): string {
    return this.summary?.content ?? "";
  }

  clear(): void {
    this.messages.length = 0;

    this.summary = undefined;
  }

  get size(): number {
    return this.messages.length;
  }

  get characterCount(): number {
    return this.getCharacterCount();
  }

  get summarizedMessageCount(): number {
    return this.summary?.summarizedMessageCount ?? 0;
  }

  private addMessage(role: ConversationRole, content: string): void {
    const trimmed = content.trim();

    if (!trimmed) {
      return;
    }

    this.messages.push({
      role,

      content: trimmed,

      createdAt: new Date().toISOString(),
    });
  }

  private async trim(): Promise<void> {
    /*
     * Trim complete turns transactionally.
     *
     * If a summarizer exists, the oldest
     * turn is summarized BEFORE it is
     * removed from recent history.
     */
    while (this.exceedsLimits() && this.messages.length > 2) {
      const oldestTurn = this.peekOldestTurn();

      if (oldestTurn.length === 0) {
        break;
      }

      /*
       * Without a summarizer we retain the
       * original bounded-buffer behaviour:
       * remove the oldest complete turn.
       */
      if (!this.summarizer) {
        this.removeMessages(oldestTurn.length);

        continue;
      }

      const summarized = await this.trySummarizeMessages(oldestTurn);

      /*
       * Summarization failed.
       *
       * Do NOT remove the old turn because
       * that would lose conversation state.
       *
       * Break rather than retrying forever
       * inside this trim operation.
       */
      if (!summarized) {
        break;
      }

      /*
       * Summary was successfully updated.
       *
       * We can now safely commit removal of
       * the messages represented by it.
       */
      this.removeMessages(oldestTurn.length);
    }

    this.removeLeadingOrphanedAssistants();
  }

  private exceedsLimits(): boolean {
    return (
      this.messages.length > this.maximumMessages ||
      this.getCharacterCount() > this.maximumCharacters
    );
  }

  private peekOldestTurn(): ConversationMessage[] {
    if (this.messages.length === 0) {
      return [];
    }

    /*
     * A healthy conversation begins with
     * a user message.
     *
     * If it does not, defensive cleanup
     * later will remove the orphaned
     * assistant message.
     */
    if (this.messages[0]?.role !== "user") {
      return [];
    }

    const turn: ConversationMessage[] = [];

    for (const message of this.messages) {
      /*
       * Once we already have messages in
       * the turn, the next user message
       * begins a new turn.
       */
      if (turn.length > 0 && message.role === "user") {
        break;
      }

      turn.push({
        ...message,
      });
    }

    return turn;
  }

  private removeMessages(count: number): void {
    if (count <= 0) {
      return;
    }

    this.messages.splice(0, count);
  }

  private async trySummarizeMessages(
    messages: ConversationMessage[],
  ): Promise<boolean> {
    if (messages.length === 0) {
      return false;
    }

    if (!this.summarizer) {
      return false;
    }

    const previousSummary = this.summary?.content ?? "";

    try {
      const content = (
        await this.summarizer.summarize(previousSummary, messages)
      ).trim();

      /*
       * An empty summary is considered a
       * failed summarization because it
       * would not safely represent the
       * conversation we're about to drop.
       */
      if (!content) {
        console.warn(
          "[Conversation memory] " +
            "Summarizer returned an empty summary. " +
            "Old conversation retained.",
        );

        return false;
      }

      const previousCount = this.summary?.summarizedMessageCount ?? 0;

      /*
       * Update the summary first.
       *
       * Removal from recent history happens
       * only after this method succeeds.
       */
      this.summary = {
        content,

        updatedAt: new Date().toISOString(),

        summarizedMessageCount: previousCount + messages.length,
      };

      return true;
    } catch (error) {
      console.error(
        "[Conversation memory] " +
          "Failed to summarize old conversation. " +
          "Old conversation retained:",
        error,
      );

      return false;
    }
  }

  private removeLeadingOrphanedAssistants(): void {
    while (this.messages.length > 0 && this.messages[0]?.role === "assistant") {
      this.messages.shift();
    }
  }

  private getCharacterCount(): number {
    return this.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );
  }
}
