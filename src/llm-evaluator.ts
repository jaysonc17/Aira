import type { AIModel } from "./models/local-model.js";
import type {
  EvaluationResult,
  Evaluator,
} from "./evaluator.js";

export class LlmEvaluator implements Evaluator {
  constructor(
    private readonly judge: AIModel,
  ) {}

  async evaluate(
    prompt: string,
    answer: string,
    context = "",
  ): Promise<EvaluationResult> {
    const evaluationPrompt = `
You are an AI answer evaluator.

Evaluate whether the answer adequately answers
the user's question.

The answer may use information supplied in
retrieved memory/context.

Do NOT mark an answer as unsupported merely because
the information was not explicitly contained in the
user's current question.

Choose one action:

"accept"
- The answer is correct, relevant and sufficiently
  complete.
- No stronger model is required.

"retry"
- The answer has a significant problem but could
  potentially be improved by asking the same model
  again with better instructions.
- Use this only for relatively minor issues.

"escalate"
- The answer is incorrect, incomplete, misleading,
  or requires deeper reasoning.
- A stronger model should answer the question.

Return ONLY valid JSON:

{
  "passed": true,
  "score": 0.9,
  "action": "accept",
  "reason": "Brief explanation"
}

Rules:

- score must be between 0 and 1
- passed is true only when the answer is acceptable
- action must be "accept", "retry", or "escalate"
- use "accept" when score >= 0.80
- use "retry" for a significant but potentially
  recoverable problem
- use "escalate" when deeper reasoning is required
- reason should be concise

USER QUESTION:
${prompt}

RETRIEVED MEMORY/CONTEXT:
${context || "No retrieved context."}

ANSWER:
${answer}
`;

    const result =
      await this.judge.generate({
        prompt: evaluationPrompt,
        maxTokens: 300,
        thinking: false,
      });

    try {
      const parsed =
        JSON.parse(result) as {
          passed?: unknown;
          score?: unknown;
          action?: unknown;
          reason?: unknown;
        };

      const score =
        typeof parsed.score === "number"
          ? Math.min(
              1,
              Math.max(
                0,
                parsed.score,
              ),
            )
          : 0;

      const action =
        parsed.action === "accept" ||
        parsed.action === "retry" ||
        parsed.action === "escalate"
          ? parsed.action
          : "escalate";

      return {
        passed:
          action === "accept" &&
          Boolean(parsed.passed),
        score,
        action,
        reason:
          typeof parsed.reason === "string"
            ? parsed.reason
            : "Evaluator decision.",
      };
    } catch {
      return {
        passed: false,
        score: 0,
        action: "escalate",
        reason:
          "Evaluator returned invalid JSON.",
      };
    }
  }
}