export interface ToolDefinition {
  name: string;

  description: string;

  /** Synchronous JSON Schema draft-07 describing accepted input. */
  inputSchema: Record<string, unknown>;

  /** Local execution policy; never inferred from model output. */
  requiresApproval?: boolean;
}

export interface ToolInput {
  [key: string]: unknown;
}

export interface ToolResult {
  success: boolean;

  output: unknown;

  error?: string;
}

export interface Tool {
  definition: ToolDefinition;

  execute(input: ToolInput, signal?: AbortSignal): Promise<ToolResult>;
}
