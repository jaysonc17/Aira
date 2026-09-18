import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationMemory } from "../src/conversation-memory.ts";
import { ConversationSessions } from "../src/conversation-sessions.ts";

async function runCli(t, cwd, commands) {
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
      child.stdin.write(commands.join("\n") + "\n/exit\n");
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, errors);
  assert.equal(errors, "");
  return output;
}

test("a fresh CLI restores saved chat and summary; /new never deletes the saved session", { timeout: 20000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "aira-restart-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, ".aira", "sessions");
  const memory = new ConversationMemory({ maximumMessages: 2, summarizer: { async summarize() { return "Earlier discussion: compare CSV parsers."; } } });
  memory.addUserMessage("Compare parser libraries.");
  await memory.addAssistantMessage("Consider input sizes.");
  memory.addUserMessage("Focus on streaming.");
  await memory.addAssistantMessage("We will compare streaming support.");
  const original = memory.snapshot();
  await new ConversationSessions(directory).save("seed", memory);

  const first = await runCli(t, cwd, ["/session load seed", "/session save checkpoint"]);
  assert.match(first, /Loaded conversation: seed/);
  assert.match(first, /Saved conversation: checkpoint/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "checkpoint.json"), "utf8")), original);

  const second = await runCli(t, cwd, [
    "/session load checkpoint", "/session inspect checkpoint", "/session save resumed",
    "/new", "/session save fresh", "/session list",
  ]);
  assert.match(second, /Recent messages: 2/);
  assert.match(second, /covering 2 earlier messages/);
  assert.doesNotMatch(second, /\[Router\]/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "resumed.json"), "utf8")), original);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "fresh.json"), "utf8")), { version: 1, messages: [] });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "checkpoint.json"), "utf8")), original);
  await assert.rejects(readFile(join(cwd, "long-term-memory.json")), { code: "ENOENT" });
});
