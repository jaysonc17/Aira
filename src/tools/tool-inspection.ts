import type { ToolRegistry } from "./tool-registry.js";

/** Formats inspection commands without selecting or executing tools. */
export function inspectTools(
  command: string,
  registry: ToolRegistry,
): string | null {
  const match = /^\/tools(?:\s+(.*))?$/.exec(command.trim());
  if (!match) return null;

  const name = match[1]?.trim();
  const definitions = registry.list();
  if (!name) {
    if (definitions.length === 0) return "No tools are registered.";
    return [
      ...definitions.map(
        (tool) =>
          `${tool.name}: ${tool.description}\n  Approval: ${tool.requiresApproval ? "required for each call" : "automatic"}`,
      ),
      "Use /tools <name> to inspect a tool's input schema.",
    ].join("\n");
  }

  const tool = definitions.find((definition) => definition.name === name);
  if (!tool)
    return `Unknown tool: ${name}. Use /tools to list available names.`;

  return [
    `Tool: ${tool.name}`,
    tool.description,
    `Approval: ${tool.requiresApproval ? "required for each call" : "automatic"}`,
    "Input schema:",
    JSON.stringify(tool.inputSchema, null, 2),
  ].join("\n");
}
