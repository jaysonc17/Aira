import type {
  EvaluationResult,
  Evaluator,
} from "./evaluator.js";

export class SimpleEvaluator implements Evaluator {
  async evaluate(
    prompt: string,
    answer: string,
  ): Promise<EvaluationResult> {
    const trimmed = answer.trim();

    if (!trimmed) {
      return {
        passed: false,
        score: 0,
        action: "escalate",
        reason: "The model returned an empty answer.",
      };
    }

    if (trimmed.length < 50) {
      return {
        passed: false,
        score: 0.3,
        action: "retry",
        reason: "The answer is probably too short.",
      };
    }

    return {
      passed: true,
      score: 1,
      action: "accept",
      reason: "Basic response validation passed.",
    };
  }
}