import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadMcpConfig } from "../src/tools/mcp-config.ts";
import { ToolRunner } from "../src/tools/tool-runner.ts";
import { McpSession } from "../src/tools/mcp-session.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const server = { name: "fixture", command: process.execPath, args: [fixture], tools: ["echo"], timeoutMs: 2000 };

async function temporaryDirectory(t) {
  const dir = await mkdtemp(join(tmpdir(), "aira-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("optional config resolves working directories and rejects invalid configuration", async (t) => {
  const dir = await temporaryDirectory(t);
  const path = join(dir, "aira.mcp.json");
  assert.deepEqual(await loadMcpConfig(path), []);
  await writeFile(path, JSON.stringify({ servers: [server] }));
  assert.equal((await loadMcpConfig(path))[0].cwd, dir);
  for (const config of [
    { servers: [{ ...server, tools: undefined }] },
    { servers: [{ ...server, timeoutMs: 0 }] },
    { servers: [{ ...server, tools: ["echo", "echo"] }] },
    { servers: [server, server] },
    { servers: [{ ...server, env: { KEY: 42 } }] },
    { servers: [], typo: true },
    { servers: [{ ...server, url: "https://example.com/mcp" }] },
    { servers: [{ name: "remote", url: "http://example.com/mcp", tools: [] }] },
    { servers: [{ name: "remote", url: "https://user:secret@example.com/mcp", tools: [] }] },
  ]) {
    await writeFile(path, JSON.stringify(config));
    await assert.rejects(loadMcpConfig(path));
  }
  await writeFile(path, "not JSON");
  await assert.rejects(loadMcpConfig(path));
});

test("only allowlisted tools are registered and shutdown closes them", async (t) => {
  const session = new McpSession();
  t.after(() => session.close());
  const registry = new ToolRegistry();
  await session.start([server], registry);
  assert.deepEqual(registry.list().map((tool) => tool.name), ["fixture/echo"]);
  assert.equal((await registry.get("fixture/echo").execute({ message: "ok" })).success, true);
  await session.close();
  await assert.rejects(registry.get("fixture/echo").execute({ message: "ok" }), /closed/);
});

test("startup failure leaves registry unchanged; empty allowlists do not launch", async () => {
  const registry = new ToolRegistry();
  const session = new McpSession();
  await assert.rejects(session.start([server, { ...server, name: "other", tools: ["missing"] }], registry), /not found/);
  assert.deepEqual(registry.list(), []);
  await new McpSession().start([{ ...server, command: "does-not-exist", tools: [] }], registry);
});

test("unsupported enabled schemas fail startup before publishing any tools", async () => {
  const registry = new ToolRegistry();
  const session = new McpSession();
  await assert.rejects(session.start([
    server,
    { ...server, name: "unsupported", args: [fixture, "unsupported-schema"] },
  ], registry), /Unsupported input schema for MCP tool: unsupported\/echo/);
  assert.deepEqual(registry.list(), []);
});

test("CLI loads config, lists only enabled tools, and exits cleanly", { timeout: 15000 }, async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, "aira.mcp.json"), JSON.stringify({ servers: [server] }));
  const child = spawn(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  let errors = "";
  let sent = false;
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!sent && output.includes("You:")) {
      sent = true;
      child.stdin.write("/hepl\n/memory search\n/memory delete\n/memory clear extra\n/help\n/new\n/session save cli-test\n/session list\n/session load cli-test\n/tools\n/tools fixture/echo\n/tools missing\n/exit\n");
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, errors);
  assert.match(output, /Unknown command\. Type \/help/);
  assert.match(output, /Usage: \/memory search <query>/);
  assert.match(output, /Usage: \/memory delete <id>/);
  assert.doesNotMatch(output, /All long-term memories cleared/);
  assert.doesNotMatch(output, /\[Router\]/);
  assert.match(output, /Saved conversation: cli-test/);
  assert.match(output, /Loaded conversation: cli-test/);
  assert.match(output, /Commands:/);
  assert.match(output, /\/memory clear\s+Delete all long-term memories; keep current chat context/);
  assert.match(output, /\/tools <name>/);
  assert.match(output, /Started a new conversation\. Long-term memory is unchanged\./);
  assert.match(output, /fixture\/echo:/);
  assert.match(output, /current_time:/);
  assert.doesNotMatch(output, /fixture\/fail:/);
  assert.match(output, /Tool: fixture\/echo/);
  assert.match(output, /Approval: required for each call/);
  assert.match(output, /Input schema:/);
  assert.match(output, /"message"/);
  assert.match(output, /Unknown tool: missing/);
});

test("per-tool approval overrides take precedence over server defaults", async (t) => {
  for (const requireApproval of [undefined, true, false]) {
    const session = new McpSession();
    t.after(() => session.close());
    const registry = new ToolRegistry();
    await session.start([{ ...server, tools: ["echo", "fail"],
      ...(requireApproval === undefined ? {} : { requireApproval }),
      toolApproval: { echo: requireApproval === false },
    }], registry);
    assert.equal(registry.get("fixture/echo").definition.requiresApproval, requireApproval === false);
    assert.equal(registry.get("fixture/fail").definition.requiresApproval, requireApproval ?? true);
    const runner = new ToolRunner({ async select() {
      return { action: "tool", name: "fixture/echo", input: { message: "ok" }, reason: "Test effective policy" };
    } }, registry);
    const result = await runner.run("Echo");
    assert.equal(result.diagnostics.status, requireApproval === false ? "denied" : "success");
    assert.equal(result.diagnostics.executionAttempted, requireApproval !== false);
  }
});

test("approval overrides reject misspelled, disabled, and non-boolean entries", async (t) => {
  const dir = await temporaryDirectory(t);
  const path = join(dir, "aira.mcp.json");
  for (const toolApproval of [{ typo: false }, { fail: false }, { echo: "false" }, { echo: null }, []]) {
    await writeFile(path, JSON.stringify({ servers: [{ ...server, toolApproval }] }));
    await assert.rejects(loadMcpConfig(path));
  }
  await writeFile(path, JSON.stringify({ servers: [{ ...server, toolApproval: { echo: false } }] }));
  assert.deepEqual((await loadMcpConfig(path))[0].toolApproval, { echo: false });
  const registry = new ToolRegistry();
  await assert.rejects(new McpSession().start([{ ...server, command: "does-not-exist", toolApproval: { typo: false } }], registry), /Invalid approval override/);
  assert.deepEqual(registry.list(), []);
});
