import type { AIModel } from "./models/local-model.js";

import type { ConversationMessage } from "./conversation-memory.js";

import type { ConversationSummarizer } from "./conversation-summarizer.js";

export class LlmConversationSummarizer implements ConversationSummarizer {
  constructor(private readonly model: AIModel) {}

  async summarize(
    previousSummary: string,
    messages: ConversationMessage[],
  ): Promise<string> {
    if (messages.length === 0) {
      return previousSummary;
    }

    const conversation = messages
      .map(
        (message) => `${message.role.toUpperCase()}: ` + `${message.content}`,
      )
      .join("\n\n");

    const prompt = `
You maintain a rolling conversation summary
for a personal AI assistant.

Your job is to preserve useful conversational
context while removing unnecessary conversational
noise.

PREVIOUS SUMMARY:
${previousSummary || "No previous summary."}

NEW CONVERSATION MESSAGES:
${conversation}

Create an updated summary that combines the
previous summary with the important information
from the new messages.

Preserve information that may be needed to
understand later messages, including:

- the current topic or task
- important people, systems, products, projects,
  technologies, files, or other named entities
- decisions that were made
- choices that were rejected
- reasons behind important decisions
- requirements and constraints
- user instructions relevant to the current task
- implementation details that later messages may
  refer back to
- unresolved questions
- pending work
- references that may matter later
- important corrections or clarifications

Prefer the newest information when the
conversation changes or corrects an earlier
statement.

Do NOT:

- invent information
- add outside knowledge
- turn temporary conversation details into
  permanent user preferences
- preserve greetings or small talk unless relevant
- preserve repetitive statements
- preserve evaluator/debugging chatter unless it
  matters to the user's task
- include information merely because it appeared
  in the conversation

The summary is session context, NOT long-term
memory about the user.

Write a concise factual summary.

Do not explain what you are doing.

Return ONLY the summary text.
`;

    const result = await this.model.generate({
      prompt,
      maxTokens: 500,
      thinking: false,
    });

    const summary = result.trim();

    /*
     * If the model unexpectedly returns an
     * empty result, keep the previous summary
     * rather than destroying useful context.
     */
    if (!summary) {
      return previousSummary;
    }

    return summary;
  }
}
