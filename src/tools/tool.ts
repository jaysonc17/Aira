export interface ToolDefinition {
  name: string;

  description: string;

  /** Synchronous JSON Schema draft-07 describing accepted input. */
  inputSchema: Record<string, unknown>;

  /**
   * Local execution policy; never inferred from model output. A function
   * receives the validated input and decides per-call, e.g. to exempt
   * read-only sub-commands of a multi-command tool from approval.
   */
  requiresApproval?: boolean | ((input: ToolInput) => boolean);
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
