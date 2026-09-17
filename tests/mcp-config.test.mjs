import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadMcpConfig } from "../src/tools/mcp-config.ts";
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
      child.stdin.write("/tools\n/tools fixture/echo\n/tools missing\n/exit\n");
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, errors);
  assert.match(output, /fixture\/echo:/);
  assert.match(output, /current_time:/);
  assert.doesNotMatch(output, /fixture\/fail:/);
  assert.match(output, /Tool: fixture\/echo/);
  assert.match(output, /Approval: required for each call/);
  assert.match(output, /Input schema:/);
  assert.match(output, /"message"/);
  assert.match(output, /Unknown tool: missing/);
});
