import type { AIModel } from "./local-model.js";
import { LocalModel } from "./local-model.js";

export type ModelRole = "fast" | "reasoning" | "memory";

export class ModelRegistry {
  private readonly models: Record<ModelRole, AIModel>;

  constructor() {
    this.models = {
      fast: new LocalModel("mlx-community/Qwen3-14B-4bit"),

      reasoning: new LocalModel("mlx-community/Qwen3-32B-4bit"),

      memory: new LocalModel("mlx-community/Qwen3-14B-4bit"),
    };
  }

  get(role: ModelRole): AIModel {
    return this.models[role];
  }
}
