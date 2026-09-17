import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "aira-test", version: "1.0.0" }, { capabilities: { tools: {} } });
const mode = process.argv[2];
server.setRequestHandler(ListToolsRequestSchema, async (request) => ({
  tools: [{
    name: request.params?.cursor ? "fail" : "echo",
    description: "Local test tool",
    inputSchema: {
      type: "object",
      ...(mode === "unsupported-schema" ? { unsupportedKeyword: true } : {}),
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  }],
  ...(!request.params?.cursor || mode === "repeat" ? { nextCursor: "page2" } : {}),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: request.params.arguments.message }],
  structuredContent: { message: request.params.arguments.message },
  isError: request.params.name === "fail",
}));
await server.connect(new StdioServerTransport());
