import assert from "node:assert/strict";
import test from "node:test";
import { loadMcpConfig } from "../src/tools/mcp-config.ts";
import { McpSession } from "../src/tools/mcp-session.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";

test("GitHub configuration loads and forwards authentication and read-only headers", async (t) => {
  const servers = await loadMcpConfig(new URL("../aira.mcp.github.example.json", import.meta.url).pathname);
  const tokenEnv = "AIRA_MCP_TEST_TOKEN";
  process.env[tokenEnv] = "test-only-token";
  t.after(() => { delete process.env[tokenEnv]; });
  servers[0].authTokenEnv = tokenEnv;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://api.githubcopilot.com/mcp/");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("authorization"), "Bearer test-only-token");
    assert.equal(headers.get("x-mcp-readonly"), "true");
    assert.equal(options.redirect, "error");
    if (options.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(options.body);
    calls.push(message.method);
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (message.method === "initialize") {
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "github-test", version: "1" } };
    } else if (message.method === "tools/list") {
      result = { tools: servers[0].tools.map((name) => ({ name, inputSchema: { type: "object" } })) };
    } else if (message.method === "tools/call") {
      result = { content: [{ type: "text", text: "README content" }] };
    } else assert.fail(`Unexpected method ${message.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
  });
  const session = new McpSession();
  t.after(() => session.close());
  const registry = new ToolRegistry();
  await session.start(servers, registry);
  assert.equal(registry.list().length, 4);
  const result = await registry.get("github/get_file_contents").execute({ owner: "example", repo: "example", path: "README.md" });
  assert.equal(result.success, true);
  assert.equal(result.output.content[0].text, "README content");
  assert.ok(calls.includes("tools/call"));
});

test("missing authentication skips the server instead of failing startup", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Must not connect"));
  const session = new McpSession();
  t.after(() => session.close());
  const registry = new ToolRegistry();
  await session.start([{
    name: "github", url: "https://api.githubcopilot.com/mcp/",
    authTokenEnv: "AIRA_MISSING_TEST_TOKEN", tools: ["get_file_contents"],
  }], registry);
  assert.equal(registry.list().length, 0);
});
