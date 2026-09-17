import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool, ToolInput, ToolResult } from "./tool.js";

export type McpConnectionOptions = {
  name: string;
  timeoutMs?: number;
} & (
  | { server: StdioServerParameters; remote?: never }
  | {
      remote: { url: string; headers?: Record<string, string> };
      server?: never;
    }
);

/** Owns one MCP connection and its discovered tools. */
export class McpConnection {
  private closed = false;
  private readonly discoveredTools: Tool[] = [];

  private constructor(
    private readonly client: Client,
    private readonly timeoutMs: number,
  ) {
    client.onclose = () => {
      this.closed = true;
    };
  }

  static async connect(options: McpConnectionOptions): Promise<McpConnection> {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.name)) {
      throw new Error(
        "MCP connection name must contain only letters, numbers, underscores or hyphens",
      );
    }

    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("MCP timeout must be a positive finite number");
    }

    const client = new Client({ name: "aira", version: "1.0.0" });
    const transport = options.remote
      ? new StreamableHTTPClientTransport(new URL(options.remote.url), {
          requestInit: {
            headers: options.remote.headers ?? {},
            redirect: "error",
          },
        })
      : new StdioClientTransport(options.server);
    const connection = new McpConnection(client, timeoutMs);

    try {
      // SDK HTTP sessionId is string | undefined rather than an exact optional.
      await client.connect(transport as Transport, { timeout: timeoutMs });
      await connection.discover(options.name);
      return connection;
    } catch (error) {
      // Also close the transport if initialization failed before attachment.
      await transport.close();
      throw error;
    }
  }

  list(): Tool[] {
    return [...this.discoveredTools];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }

  private async discover(serverName: string): Promise<void> {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const names = new Set<string>();

    do {
      const page = await this.client.listTools(
        cursor === undefined ? {} : { cursor },
        { timeout: this.timeoutMs },
      );

      for (const remote of page.tools) {
        if (names.has(remote.name)) {
          throw new Error(`Duplicate MCP tool: ${remote.name}`);
        }
        names.add(remote.name);

        this.discoveredTools.push({
          definition: {
            name: `${serverName}/${remote.name}`,
            description:
              remote.description ??
              `MCP tool ${remote.name} from ${serverName}`,
            inputSchema: remote.inputSchema,
            requiresApproval: true,
          },
          execute: (input, signal) => this.execute(remote.name, input, signal),
        });
      }

      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) {
          throw new Error("MCP server repeated a tool-list cursor");
        }
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
  }

  private async execute(
    name: string,
    input: ToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (this.closed) {
      throw new Error("MCP connection is closed");
    }

    const result = await this.client.callTool(
      { name, arguments: input },
      undefined,
      { timeout: this.timeoutMs, ...(signal ? { signal } : {}) },
    );

    // Preserve content blocks and structured output for the answering model.
    if (result.isError) {
      return {
        success: false,
        output: result,
        error: `MCP tool ${name} reported an error`,
      };
    }

    return { success: true, output: result };
  }
}
