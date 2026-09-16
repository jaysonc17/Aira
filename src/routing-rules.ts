import type { ModelRole } from "./models/model-registry.js";

export interface RoutingRule {
  keywords: string[];
  role: ModelRole;
}

export const routingRules: RoutingRule[] = [
  {
    role: "reasoning",
    keywords: [
      "system design",
      "architecture",
      "distributed system",
      "distributed systems",
      "concurrency",
      "race condition",
      "deadlock",
      "transaction consistency",
      "exactly once",
      "eventual consistency",
      "kafka transaction",
      "database commit",
      "outbox pattern",
      "saga pattern",
      "performance bottleneck",
      "memory leak",
      "thread dump",
      "heap dump",
      "complex refactor",
    ],
  },
];