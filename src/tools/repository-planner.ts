import { abortable, createDeadline } from "../cancellation.js";
import type { AIModel } from "../models/local-model.js";
import type { ToolRegistry } from "./tool-registry.js";

export interface RepositoryPlan {
  repository: string;
  question: string;
  steps: Array<{ question: string; tool: string }>;
}

export const repositoryReadTools = new Set([
  "github/get_file_contents",
  "github/list_branches",
  "github/list_commits",
  "github/get_commit",
]);

export class RepositoryPlanner {
  constructor(
    private readonly model: AIModel,
    private readonly registry: ToolRegistry,
  ) {}

  async plan(
    repository: string,
    question: string,
    signal?: AbortSignal,
    timeoutMs = 60_000,
  ): Promise<RepositoryPlan> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("Use a repository in owner/repository form");
    if (!question.trim() || question.length > 4000)
      throw new Error("Investigation questions must contain 1–4000 characters");
    const definitions = this.registry
      .list()
      .filter(({ name }) => repositoryReadTools.has(name));
    if (!definitions.length)
      throw new Error(
        "No supported GitHub read tools are registered. Enable them in the MCP configuration first.",
      );
    const deadline = createDeadline(timeoutMs, signal);
    try {
      const response = await abortable(
        () =>
          this.model.generate({
            systemPrompt: `Plan a read-only repository investigation. You have not read any repository files.
Break the user's question into one to three concrete evidence questions, ordered
so discovery precedes tracing relationships. Use only the listed tool names.
For questions about current implementation, prioritize locating source files,
reading the entry point, and tracing called components. Branch enumeration and
commit history are not prerequisites unless the user asks about versions or changes.
Use repository documentation to locate code, not as a replacement for code inspection.
Do not invent existing paths, branches, commits, code behavior, or findings.
The questions describe what to discover, not claims that it exists. Do not
include executable arguments. A separate selector will choose actual calls.
A plan is a proposal, not evidence, permission, or a guarantee of completion.
Return ONLY raw JSON: {"steps":[{"question":"Evidence to gather","tool":"registered/name"}]}.
Each question must be 1–300 characters. Include no additional fields or Markdown.
Available read tools: ${JSON.stringify(definitions)}`,
            prompt: JSON.stringify({ repository, question: question.trim() }),
            maxTokens: 500,
            thinking: false,
            signal: deadline.signal,
          }),
        deadline.signal,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(response);
      } catch {
        throw new Error("Repository planner returned invalid JSON");
      }
      if (
        !isRecord(parsed) ||
        Object.keys(parsed).length !== 1 ||
        !Array.isArray(parsed.steps) ||
        parsed.steps.length < 1 ||
        parsed.steps.length > 3
      ) {
        throw new Error("Repository planner returned an invalid plan");
      }
      const names = new Set(definitions.map(({ name }) => name));
      const questions = new Set<string>();
      const steps = parsed.steps.map((step: unknown) => {
        if (
          !isRecord(step) ||
          Object.keys(step).length !== 2 ||
          typeof step.question !== "string" ||
          !step.question.trim() ||
          step.question.length > 300 ||
          typeof step.tool !== "string" ||
          !names.has(step.tool)
        ) {
          throw new Error(
            "Repository planner returned an invalid step or unsupported tool",
          );
        }
        const question = step.question.trim();
        const key = question.toLowerCase();
        if (questions.has(key))
          throw new Error("Repository planner repeated an evidence question");
        questions.add(key);
        return { question, tool: step.tool };
      });
      return { repository, question: question.trim(), steps };
    } finally {
      deadline.dispose();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
