import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { ToolRunner } from "../src/tools/tool-runner.ts";
import { ToolLoop } from "../src/tools/tool-loop.ts";

function setup(decisions, execute) {
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "read", description: "Read", inputSchema: { type: "object" } }, execute });
  const contexts = [];
  const selector = { async select(prompt, history, context) {
    contexts.push(context);
    return decisions.shift();
  } };
  return { loop: new ToolLoop(new ToolRunner(selector, registry)), contexts };
}
const read = (input) => ({ action: "tool", name: "read", input, reason: "Read file" });
const done = { action: "none", reason: "Enough evidence" };

test("follows a hint and preserves both results for the answer", async () => {
  const calls = [];
  const { loop, contexts } = setup([read({ path: "README.md" }), read({ path: "frontend/README.md" }), done], async (input) => {
    calls.push(input.path);
    return { success: true, output: calls.length === 1 ? "Try frontend/README.md" : "React frontend documentation" };
  });
  const result = await loop.run("Read README", [], "Memory context");
  assert.deepEqual(calls, ["README.md", "frontend/README.md"]);
  assert.match(contexts[1], /Try frontend\/README.md/);
  assert.match(contexts[2], /React frontend documentation/);
  assert.match(result.context, /Try frontend\/README.md/);
  assert.match(result.context, /React frontend documentation/);
  assert.equal(result.stopReason, "none");
  assert.equal(result.steps.length, 3);
});

test("blocks duplicate calls even when nested object keys are reordered", async () => {
  let calls = 0;
  const { loop } = setup([
    read({ path: "x", options: { a: 1, b: 2 } }),
    read({ options: { b: 2, a: 1 }, path: "x" }),
  ], async () => { calls++; return { success: true, output: "hint" }; });
  const result = await loop.run("Read");
  assert.equal(calls, 1);
  assert.equal(result.stopReason, "repeated");
  assert.equal(result.steps[1].executionAttempted, false);
});

test("limits execution to three steps", async () => {
  let calls = 0;
  const { loop } = setup([read({ n: 1 }), read({ n: 2 }), read({ n: 3 }), read({ n: 4 })], async () => {
    calls++; return { success: true, output: "more work" };
  });
  const result = await loop.run("Read");
  assert.equal(calls, 3);
  assert.equal(result.stopReason, "limit");
});

test("stops on invalid selection, tool failure, or exception", async () => {
  for (const status of ["invalid", "failed", "error"]) {
    const { loop } = setup([status === "invalid" ? { action: "invalid", reason: "Bad JSON" } : read({})], async () => {
      if (status === "error") throw new Error("Unavailable");
      return { success: false, output: null, error: "Failed" };
    });
    const result = await loop.run("Read");
    assert.equal(result.steps.length, 1);
    assert.equal(result.stopReason, status);
  }
});

test("call history is scoped to one conversation turn", async () => {
  let calls = 0;
  const { loop } = setup([read({}), done, read({}), done], async () => { calls++; return { success: true, output: "ok" }; });
  await loop.run("Read");
  await loop.run("Read again");
  assert.equal(calls, 2);
  assert.throws(() => new ToolLoop({}, 0), /positive integer/);
});

test("oversized results are omitted whole and no further selection runs", async () => {
  let calls = 0;
  const runner = { async run() {
    calls++;
    return {
      context: 'SECRET_LARGE_RESULT' + 'x'.repeat(20_000),
      diagnostics: { status: "success", executionAttempted: true },
    };
  } };
  const result = await new ToolLoop(runner).run("Read");
  assert.equal(calls, 1);
  assert.equal(result.stopReason, "context_limit");
  assert.equal(result.omittedSteps, 1);
  assert.ok(result.context.length <= 16_000);
  assert.equal(result.contextCharacters, result.context.length);
  assert.doesNotMatch(result.context, /SECRET_LARGE_RESULT/);
  assert.match(result.context, /Output omitted/);
  assert.match(result.context, /executionAttempted=true/);
});

test("the budget is cumulative, preserves earlier evidence, and includes notices", async () => {
  const contexts = [];
  const runner = { async run(prompt, history, context) {
    contexts.push(context);
    return { context: 'x'.repeat(700), diagnostics: { status: "success", executionAttempted: true } };
  } };
  const result = await new ToolLoop(runner, 3, 2048).run("Read");
  assert.equal(result.steps.length, 2);
  assert.equal(result.stopReason, "context_limit");
  assert.ok(contexts[1].includes('x'.repeat(700)));
  assert.ok(result.context.includes('x'.repeat(700)));
  assert.ok(result.context.length <= 2048);
});

test("small results stay intact and budgets are validated", async () => {
  const { loop } = setup([read({}), done], async () => ({ success: true, output: "small result" }));
  const result = await loop.run("Read");
  assert.equal(result.omittedSteps, 0);
  assert.match(result.context, /small result/);
  for (const budget of [0, 2047, 2048.5, Infinity, NaN]) {
    assert.throws(() => new ToolLoop({}, 3, budget), /at least 2048/);
  }
});

test("progress arrives before pending work completes and includes no tool data", async () => {
  const events = [];
  let finish;
  const runner = { run() { return new Promise((resolve) => { finish = resolve; }); } };
  const evaluator = { async evaluate() {
    assert.deepEqual(events.at(-1), { step: 1, phase: "evidence_evaluation", state: "started" });
    return { action: "sufficient", reason: "Complete" };
  } };
  const pending = new ToolLoop(runner, 3, 16_000, evaluator, (event) => events.push(event)).run("Private prompt");
  assert.deepEqual(events, [{ step: 1, phase: "tool_step", state: "started" }]);
  finish({ context: "Private evidence", diagnostics: { status: "success", executionAttempted: true } });
  const result = await pending;
  assert.equal(result.stopReason, "sufficient");
  assert.deepEqual(events, [
    { step: 1, phase: "tool_step", state: "started" },
    { step: 1, phase: "tool_step", state: "finished" },
    { step: 1, phase: "evidence_evaluation", state: "started" },
    { step: 1, phase: "evidence_evaluation", state: "finished" },
  ]);
});

test("observer failures cannot rerun tools or discard their evidence", async () => {
  for (const observer of [() => { throw new Error("Logging failed"); }, async () => { throw new Error("Async logging failed"); }]) {
    let calls = 0;
    const runner = { async run() { calls++; return { context: "Retained evidence", diagnostics: { status: "success", executionAttempted: true } }; } };
    const evaluator = { async evaluate() { throw new Error("Evaluator unavailable"); } };
    const result = await new ToolLoop(runner, 3, 16_000, evaluator, observer).run("Read");
    assert.equal(calls, 1);
    assert.equal(result.stopReason, "evaluation_error");
    assert.match(result.context, /Retained evidence/);
  }
});
