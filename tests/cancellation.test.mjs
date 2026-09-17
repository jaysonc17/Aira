import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { ToolRunner } from "../src/tools/tool-runner.ts";
import { ToolLoop } from "../src/tools/tool-loop.ts";
import { LocalModel } from "../src/models/local-model.ts";

const decision = { action: "tool", name: "slow", input: {}, reason: "Test" };
const never = () => new Promise(() => {});

test("selection timeout prevents execution even for an uncooperative model", async () => {
  const runner = new ToolRunner({ select: never }, new ToolRegistry());
  const result = await runner.run("Test", [], "", new Set(), undefined, 20);
  assert.equal(result.diagnostics.status, "timeout");
  assert.equal(result.diagnostics.errorStage, "selection");
  assert.equal(result.diagnostics.executionAttempted, false);
});

test("cancelled execution receives the signal and stops subsequent loop steps", async () => {
  const controller = new AbortController();
  let calls = 0;
  let received;
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "slow", description: "Test", inputSchema: { type: "object" } },
    async execute(input, signal) {
      calls++;
      received = signal;
      controller.abort();
      return never();
    },
  });
  const loop = new ToolLoop(new ToolRunner({ async select() { return decision; } }, registry));
  const result = await loop.run("Test", [], "", controller.signal);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(calls, 1);
  assert.equal(received.aborted, true);
  assert.equal(result.steps[0].executionAttempted, true);
  assert.match(result.context, /external action may still finish/);
});

test("a pre-cancelled turn starts no selection", async () => {
  const runner = new ToolRunner({ async select() { assert.fail("Must not select"); } }, new ToolRegistry());
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runner.run("Test", [], "", new Set(), controller.signal)).diagnostics.status, "cancelled");
});

test("whole-loop deadline interrupts a pending selection", async () => {
  const loop = new ToolLoop(new ToolRunner({ select: never }, new ToolRegistry()));
  const result = await loop.run("Test", [], "", undefined, 20);
  assert.equal(result.stopReason, "timeout");
  assert.equal(result.steps.length, 1);
});

test("execution timeout aborts the tool signal and preserves uncertainty", async () => {
  let received;
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "slow", description: "Test", inputSchema: { type: "object" } },
    execute(input, signal) { received = signal; return never(); },
  });
  const runner = new ToolRunner({ async select() { return decision; } }, registry);
  const result = await runner.run("Test", [], "", new Set(), undefined, 50);
  assert.equal(result.diagnostics.status, "timeout");
  assert.equal(result.diagnostics.errorStage, "execution");
  assert.equal(result.diagnostics.executionAttempted, true);
  assert.equal(received.aborted, true);
  assert.match(result.context, /Do not automatically retry/);
});

test("local model passes cancellation to fetch and stops waiting", async (t) => {
  const controller = new AbortController();
  let received;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    received = options.signal;
    controller.abort();
    return never();
  });
  await assert.rejects(new LocalModel("test").generate({ prompt: "Test", signal: controller.signal }), { name: "AbortError" });
  assert.equal(received.aborted, true);
});
