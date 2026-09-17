import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpConnection } from "../src/tools/mcp-connection.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { ToolSelector } from "../src/tools/tool-selector.ts";
import { ToolRunner } from "../src/tools/tool-runner.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const options = {
  name: "fixture",
  server: { command: process.execPath, args: [fixture] },
  timeoutMs: 5000,
};

test("discovers paginated MCP tools and runs one through Aira", { timeout: 15000 }, async (t) => {
  const connection = await McpConnection.connect(options);
  t.after(() => connection.close());
  const tools = connection.list();
  assert.deepEqual(tools.map((tool) => tool.definition.name), ["fixture/echo", "fixture/fail"]);
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  let input = { message: "hello" };
  const runner = new ToolRunner(new ToolSelector({
    async generate() {
      return JSON.stringify({ action: "tool", name: "fixture/echo", input, reason: "Test" });
    },
  }, registry), registry, undefined, async () => true);
  const run = await runner.run("Echo hello");
  assert.equal(run.diagnostics.status, "success");
  const outcome = JSON.parse(run.context.split("\n\n")[1]);
  assert.deepEqual(outcome.result.output.structuredContent, { message: "hello" });
  assert.deepEqual(outcome.result.output.content, [{ type: "text", text: "hello" }]);

  input = { message: 42 };
  const invalid = await runner.run("Invalid input");
  assert.equal(invalid.diagnostics.errorStage, "validation");
  assert.equal(invalid.diagnostics.executionAttempted, false);

  const failure = await registry.get("fixture/fail").execute({ message: "failed" });
  assert.equal(failure.success, false);
  assert.equal(failure.output.isError, true);

  await connection.close();
  await connection.close();
  await assert.rejects(registry.get("fixture/echo").execute({ message: "hello" }), /closed/);
});

test("rejects repeated pagination cursors and closes the server", { timeout: 15000 }, async () => {
  await assert.rejects(McpConnection.connect({
    ...options,
    server: { command: process.execPath, args: [fixture, "repeat"] },
  }), /repeated.*cursor/);
});

test("reports server startup failures", { timeout: 15000 }, async () => {
  await assert.rejects(McpConnection.connect({
    ...options,
    server: { command: process.execPath, args: ["-e", "process.exit(1)"] },
  }));
});

test("times out an unresponsive server during initialization", { timeout: 15000 }, async () => {
  await assert.rejects(McpConnection.connect({
    ...options,
    timeoutMs: 200,
    server: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
  }), /timed out/i);
});
