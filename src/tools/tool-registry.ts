import type { Tool, ToolDefinition } from "./tool.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    const name = tool.definition.name;

    if (!name.trim()) {
      throw new Error("Tool name must not be empty");
    }

    if (this.tools.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }

    this.tools.set(name, tool);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    return tool;
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values(), (tool) => tool.definition);
  }
}
