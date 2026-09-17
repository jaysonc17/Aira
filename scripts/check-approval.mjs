import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { McpSession } from "../src/tools/mcp-session.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { ToolRunner } from "../src/tools/tool-runner.ts";
import { ToolLoop } from "../src/tools/tool-loop.ts";
import { requestToolApproval } from "../src/tools/tool-approval.ts";

if (!process.stdin.isTTY) throw new Error("Run this check in an interactive terminal");

const session = new McpSession();
const registry = new ToolRegistry();
await session.start([{
  name: "fixture",
  command: process.execPath,
  args: [fileURLToPath(new URL("../tests/fixtures/mcp-server.mjs", import.meta.url))],
  tools: ["echo"],
  requireApproval: true,
}], registry);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "Check> " });
const controller = new AbortController();
const cancel = () => { controller.abort(); rl.close(); };
rl.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const loop = new ToolLoop(new ToolRunner({
  async select(prompt, history, context, followUp) {
    return followUp
      ? { action: "none", reason: "Echo result received" }
      : { action: "tool", name: "fixture/echo", input: { message: prompt }, reason: "Terminal approval check" };
  },
}, registry, undefined, (request, signal) => requestToolApproval(rl, request, signal)));

console.log("Local echo fixture only; no model, GitHub access, or memory writes.");
console.log("Enter a message, then approve with yes or deny with any other answer. /exit quits.");
try {
  rl.prompt();
  for await (const line of rl) {
    if (line.trim() === "/exit") break;
    const result = await loop.run(line, [], "", controller.signal);
    const executed = result.steps.filter((step) => step.executionAttempted).length;
    if (result.stopReason === "denied" || result.stopReason === "cancelled") assert.equal(executed, 0);
    if (result.stopReason === "none") assert.equal(executed, 1);
    console.log(`stop=${result.stopReason} executed=${executed}`);
    if (controller.signal.aborted) break;
    rl.prompt();
  }
} finally {
  rl.close();
  process.off("SIGTERM", cancel);
  await session.close();
}
