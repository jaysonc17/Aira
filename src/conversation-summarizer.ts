import type { ConversationMessage } from "./conversation-memory.js";

export interface ConversationSummary {
  content: string;
  updatedAt: string;
  summarizedMessageCount: number;
}

export interface ConversationSummarizer {
  summarize(
    previousSummary: string,
    messages: ConversationMessage[],
  ): Promise<string>;
}
