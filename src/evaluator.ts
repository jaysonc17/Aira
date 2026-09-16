export type EvaluationAction =
  | "accept"
  | "retry"
  | "escalate";

export interface EvaluationResult {
  passed: boolean;
  score: number;
  action: EvaluationAction;
  reason: string;
}

export interface Evaluator {
  evaluate(
    prompt: string,
    answer: string,
    context?: string,
  ): Promise<EvaluationResult>;
}