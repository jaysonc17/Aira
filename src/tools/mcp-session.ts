import { McpConnection } from "./mcp-connection.js";
import { validateToolApproval } from "./mcp-config.js";
import type { McpServerConfig } from "./mcp-config.js";
import type { Tool } from "./tool.js";
import type { ToolRegistry } from "./tool-registry.js";
import { ToolInputValidator } from "./tool-input-validator.js";

export class McpSession {
  private readonly connections: McpConnection[] = [];
  private started = false;

  async start(
    servers: McpServerConfig[],
    registry: ToolRegistry,
  ): Promise<void> {
    if (this.started) throw new Error("MCP session has already started");
    this.started = true;
    const pending: Tool[] = [];
    const validator = new ToolInputValidator();
    const names = new Set(registry.list().map((tool) => tool.name));

    try {
      for (const server of servers) validateToolApproval(server);
      for (const server of servers) {
        if (server.tools.length === 0) continue;
        const headers = { ...server.headers };
        if (server.authTokenEnv) {
          const token = process.env[server.authTokenEnv];
          if (!token?.trim()) {
            console.warn(
              `[MCP] ${server.authTokenEnv} is not set; skipping MCP server "${server.name}" and its tools.`,
            );
            continue;
          }
          if (
            Object.keys(headers).some(
              (key) => key.toLowerCase() === "authorization",
            )
          ) {
            throw new Error(
              "Use authTokenEnv instead of an Authorization header",
            );
          }
          headers.Authorization = `Bearer ${token}`;
        }
        const connection = await McpConnection.connect({
          name: server.name,
          ...(server.url
            ? { remote: { url: server.url, headers } }
            : {
                server: {
                  command: server.command!,
                  ...(server.args === undefined ? {} : { args: server.args }),
                  ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
                  ...(server.env === undefined ? {} : { env: server.env }),
                },
              }),
          ...(server.timeoutMs === undefined
            ? {}
            : { timeoutMs: server.timeoutMs }),
        });
        this.connections.push(connection);
        const available = connection.list();
        for (const remoteName of server.tools) {
          const name = `${server.name}/${remoteName}`;
          const tool = available.find(
            (candidate) => candidate.definition.name === name,
          );
          if (!tool)
            throw new Error(`Configured MCP tool was not found: ${name}`);
          tool.definition.requiresApproval =
            server.toolApproval &&
            Object.hasOwn(server.toolApproval, remoteName)
              ? server.toolApproval[remoteName]!
              : (server.requireApproval ?? true);
          if (names.has(name))
            throw new Error(`Tool already registered: ${name}`);
          try {
            validator.prepare(tool.definition);
          } catch (error) {
            throw new Error(`Unsupported input schema for MCP tool: ${name}`, {
              cause: error,
            });
          }
          names.add(name);
          pending.push(tool);
        }
      }
      // Publish only after every server and allowlisted tool is ready.
      for (const tool of pending) registry.register(tool);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      this.connections.splice(0).map((connection) => connection.close()),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        "MCP shutdown failed",
      );
    }
  }
}
