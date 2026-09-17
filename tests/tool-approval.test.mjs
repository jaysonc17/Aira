import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { ToolRunner } from "../src/tools/tool-runner.ts";
import { ToolLoop } from "../src/tools/tool-loop.ts";
import { requestToolApproval } from "../src/tools/tool-approval.ts";

function setup(approve, input = { value: "reviewed" }) {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "action", description: "Test", requiresApproval: true, inputSchema: {
      type: "object", properties: { value: { type: "string" } }, required: ["value"],
    } },
    async execute(args) { calls++; return { success: true, output: args }; },
  });
  const runner = new ToolRunner({ async select() {
    return { action: "tool", name: "action", input, reason: "Test" };
  } }, registry, undefined, approve);
  return { runner, calls: () => calls };
}

test("no handler or denial prevents execution and stops the loop", async () => {
  for (const handler of [undefined, async () => false]) {
    const { runner, calls } = setup(handler);
    const result = await new ToolLoop(runner).run("Test");
    assert.equal(result.stopReason, "denied");
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].executionAttempted, false);
    assert.equal(calls(), 0);
  }
});

test("approval reviews arguments without allowing the handler to change execution", async () => {
  const { runner, calls } = setup(async (request) => {
    assert.equal(request.name, "action");
    assert.equal(request.input.value, "reviewed");
    request.input.value = "changed";
    return true;
  });
  const result = await runner.run("Test");
  assert.equal(result.diagnostics.status, "success");
  assert.equal(calls(), 1);
  assert.equal(JSON.parse(result.context.split("\n\n")[1]).result.output.value, "reviewed");
});

test("invalid input never requests approval", async () => {
  const { runner, calls } = setup(async () => assert.fail("Must not ask"), { value: 42 });
  assert.equal((await runner.run("Test")).diagnostics.status, "invalid");
  assert.equal(calls(), 0);
});

test("approval waits expire without execution", async () => {
  const { runner, calls } = setup(() => new Promise(() => {}));
  const result = await runner.run("Test", [], "", new Set(), undefined, 30);
  assert.equal(result.diagnostics.status, "timeout");
  assert.equal(result.diagnostics.errorStage, "approval");
  assert.equal(calls(), 0);
});

test("terminal approval accepts only yes and handles closed input", async () => {
  for (const answer of ["yes", "no", "", "y", null]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = createInterface({ input, output });
    try {
      const result = requestToolApproval(rl, { name: "action", input: {} }, new AbortController().signal);
      if (answer === null) input.end();
      else input.write(answer + "\n");
      assert.equal(await result, answer === "yes");
    } finally { rl.close(); input.destroy(); output.destroy(); }
  }
});
