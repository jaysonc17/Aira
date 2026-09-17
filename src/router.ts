import type { AIModel } from "./models/local-model.js";

import type { ModelRole } from "./models/model-registry.js";

import { routingRules } from "./routing-rules.js";

export interface RouteResult {
  role: ModelRole;

  confidence: number;

  reason: string;

  matchedRule?: string;
}

interface ClassificationResponse {
  role?: unknown;

  confidence?: unknown;

  reason?: unknown;
}

export class Router {
  constructor(private readonly classifierModel: AIModel) {}

  async route(prompt: string): Promise<RouteResult> {
    const ruleMatch = this.matchRule(prompt);

    if (ruleMatch) {
      return {
        role: ruleMatch.role,

        confidence: 0.95,

        reason: `Matched routing rule: ${ruleMatch.keyword}`,

        matchedRule: ruleMatch.keyword,
      };
    }

    return this.classify(prompt);
  }

  private matchRule(prompt: string):
    | {
        role: ModelRole;
        keyword: string;
      }
    | undefined {
    const text = prompt.toLowerCase();

    for (const rule of routingRules) {
      for (const keyword of rule.keywords) {
        if (text.includes(keyword.toLowerCase())) {
          return {
            role: rule.role,

            keyword,
          };
        }
      }
    }

    return undefined;
  }

  private async classify(prompt: string): Promise<RouteResult> {
    const classifierPrompt = `
You are a routing classifier
for a personal AI assistant.

Decide which model should answer
the user's request.

Available models:

fast
- Qwen3-14B
- general questions
- simple coding
- straightforward explanations
- normal conversation
- simple transformations

reasoning
- Qwen3-32B
- difficult coding problems
- system architecture
- distributed systems
- concurrency
- debugging complex problems
- multi-step reasoning
- difficult technical analysis

Choose "reasoning" when the request
requires substantial reasoning or
technical depth.

Choose "fast" for straightforward
requests.

USER REQUEST:
${prompt}

Return ONLY valid JSON:

{
  "role": "fast",
  "confidence": 0.90,
  "reason": "Straightforward question"
}

Rules:

- role must be "fast" or "reasoning".
- confidence must be between 0 and 1.
- confidence represents how certain
  you are about the routing decision.
- Do not include markdown.
- Do not include additional fields.
`;

    const result = await this.classifierModel.generate({
      prompt: classifierPrompt,

      maxTokens: 200,

      thinking: false,
    });

    try {
      const parsed = JSON.parse(result) as ClassificationResponse;

      const role =
        parsed.role === "reasoning" || parsed.role === "fast"
          ? parsed.role
          : "fast";

      const confidence =
        typeof parsed.confidence === "number"
          ? Math.min(1, Math.max(0, parsed.confidence))
          : 0;

      const reason =
        typeof parsed.reason === "string"
          ? parsed.reason
          : "No routing reason provided";

      /*
       * Low-confidence decisions are
       * deliberately escalated.
       */
      if (confidence < 0.75) {
        return {
          role: "reasoning",

          confidence,

          reason: `Low-confidence classification: ${reason}`,
        };
      }

      return {
        role,

        confidence,

        reason,
      };
    } catch {
      /*
       * If the classifier produces invalid
       * JSON, we don't trust the routing
       * decision. Returning confidence=0
       * causes the caller to escalate.
       */
      return {
        role: "reasoning",

        confidence: 0,

        reason: "Invalid classifier response; escalating to reasoning model",
      };
    }
  }
}
