import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Ajv } from "ajv";

export interface McpServerConfig {
  name: string;
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  authTokenEnv?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  tools: string[];
  timeoutMs?: number;
  requireApproval?: boolean;
  toolApproval?: Record<string, boolean>;
}

// Required fields in transport branches are declared on the parent schema.
const validate = new Ajv({ strict: true, strictRequired: false }).compile({
  type: "object",
  additionalProperties: false,
  required: ["servers"],
  properties: {
    servers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "tools"],
        oneOf: [
          {
            required: ["command"],
            not: {
              anyOf: [
                { required: ["url"] },
                { required: ["headers"] },
                { required: ["authTokenEnv"] },
              ],
            },
          },
          {
            required: ["url"],
            not: {
              anyOf: [
                { required: ["command"] },
                { required: ["args"] },
                { required: ["cwd"] },
                { required: ["env"] },
              ],
            },
          },
        ],
        properties: {
          name: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
          command: { type: "string", pattern: "\\S" },
          url: { type: "string", pattern: "^https://" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          authTokenEnv: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string", minLength: 1 },
          env: { type: "object", additionalProperties: { type: "string" } },
          tools: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          timeoutMs: { type: "integer", minimum: 1 },
          requireApproval: { type: "boolean" },
          toolApproval: {
            type: "object",
            additionalProperties: { type: "boolean" },
          },
        },
      },
    },
  },
});

export async function loadMcpConfig(
  path = "aira.mcp.json",
): Promise<McpServerConfig[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const parsed: unknown = JSON.parse(content);
  if (!validate(parsed)) {
    throw new Error(
      `Invalid MCP configuration: ${JSON.stringify(validate.errors)}`,
    );
  }

  const { servers } = parsed as { servers: McpServerConfig[] };
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) {
      throw new Error(`Duplicate MCP server name: ${server.name}`);
    }
    names.add(server.name);
    validateToolApproval(server);
    if (server.url) {
      const url = new URL(server.url);
      if (url.username || url.password || url.hash) {
        throw new Error("MCP URLs must not contain credentials or fragments");
      }
    }
  }

  return servers.map((server) => ({
    ...server,
    ...(server.url
      ? {}
      : { cwd: resolve(dirname(resolve(path)), server.cwd ?? ".") }),
  }));
}

// Validate overrides for programmatic callers as well as JSON configuration.
export function validateToolApproval(server: McpServerConfig): void {
  for (const [name, required] of Object.entries(server.toolApproval ?? {})) {
    if (!server.tools.includes(name) || typeof required !== "boolean") {
      throw new Error(
        `Invalid approval override for MCP tool: ${server.name}/${name}`,
      );
    }
  }
}
