import type { AIModel } from "./models/local-model.js";
import type { EvaluationResult, Evaluator } from "./evaluator.js";

export class LlmEvaluator implements Evaluator {
  constructor(private readonly judge: AIModel) {}

  async evaluate(
    prompt: string,
    answer: string,
    context = "",
    signal?: AbortSignal,
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
- passed must be a boolean, never a string
- passed must be true for accept and false for retry or escalate
- action must be "accept", "retry", or "escalate"
- accept requires score >= 0.80; retry and escalate require score < 0.80
- use "retry" for a significant but potentially
  recoverable problem
- use "escalate" when deeper reasoning is required
- reason must be a non-empty string
- include exactly passed, score, action, and reason

USER QUESTION:
${prompt}

RETRIEVED MEMORY/CONTEXT:
${context || "No retrieved context."}

ANSWER:
${answer}
`;

    const result = await this.judge.generate({
      prompt: evaluationPrompt,
      maxTokens: 300,
      thinking: false,
      ...(signal ? { signal } : {}),
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      return invalidEvaluation("Evaluator returned invalid JSON.");
    }

    if (!isEvaluationResult(parsed)) {
      return invalidEvaluation(
        "Evaluator returned an invalid or inconsistent decision.",
      );
    }
    return parsed;
  }
}

function invalidEvaluation(reason: string): EvaluationResult {
  return { passed: false, score: 0, action: "escalate", reason };
}

function isEvaluationResult(value: unknown): value is EvaluationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const parsed = value as Record<string, unknown>;
  if (
    typeof parsed.passed !== "boolean" ||
    typeof parsed.score !== "number" ||
    !Number.isFinite(parsed.score) ||
    parsed.score < 0 ||
    parsed.score > 1 ||
    typeof parsed.reason !== "string" ||
    !parsed.reason.trim() ||
    !Object.keys(parsed).every((key) =>
      ["passed", "score", "action", "reason"].includes(key),
    )
  )
    return false;

  if (parsed.action === "accept") return parsed.passed && parsed.score >= 0.8;
  if (parsed.action === "retry" || parsed.action === "escalate") {
    return !parsed.passed && parsed.score < 0.8;
  }
  return false;
}
