import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { ToolSelector } from "../src/tools/tool-selector.ts";
import { ToolRunner } from "../src/tools/tool-runner.ts";
import { CurrentTimeTool } from "../src/tools/current-time-tool.ts";

function outcome({ context }) {
  return JSON.parse(context.split("\n\n")[1]);
}

function createRunner(response, registry) {
  return new ToolRunner(new ToolSelector({
    async generate() { return JSON.stringify(response); },
  }, registry), registry);
}

const selection = {
  action: "tool",
  name: "current_time",
  input: { timeZone: "Australia/Melbourne" },
  reason: "Current time requested",
};

test("selection executes the real current-time tool and supplies its result", async () => {
  const registry = new ToolRegistry();
  registry.register(new CurrentTimeTool());
  const runner = createRunner(selection, registry);
  const before = Date.now();
  const result = outcome(await runner.run("What time is it in Melbourne?"));

  assert.equal(result.status, "success");
  assert.equal(result.name, "current_time");
  assert.equal(result.result.output.timeZone, "Australia/Melbourne");
  assert.ok(Date.parse(result.result.output.iso) >= before);
  assert.ok(Date.parse(result.result.output.iso) <= Date.now());
});

test("passes history and memory to selection and executes only once", async () => {
  let calls = 0;
  const history = [{ role: "user", content: "I mean Melbourne." }];
  const registry = new ToolRegistry();
  registry.register({
    definition: new CurrentTimeTool().definition,
    async execute(input) {
      calls++;
      assert.deepEqual(input, selection.input);
      return { success: true, output: "test result" };
    },
  });
  const runner = new ToolRunner(new ToolSelector({
    async generate(request) {
      assert.deepEqual(request.history, history);
      assert.ok(request.systemPrompt.includes("Earlier discussion"));
      return JSON.stringify(selection);
    },
  }, registry), registry);

  const result = outcome(await runner.run("What time is it there?", history, "Earlier discussion"));
  assert.equal(calls, 1);
  assert.equal(result.result.output, "test result");
});

test("no-tool and invalid selections never execute", async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: new CurrentTimeTool().definition,
    async execute() { assert.fail("Must not execute"); },
  });
  for (const [decision, status] of [
    [{ action: "none", reason: "No tool needed" }, "none"],
    [{ ...selection, name: "missing" }, "invalid"],
    [null, "invalid"],
  ]) {
    const result = outcome(await createRunner(decision, registry).run("Hello"));
    assert.equal(result.status, status);
    assert.equal(result.executed, false);
  }
});

test("tool argument validation failures remain failures in answer context", async () => {
  const registry = new ToolRegistry();
  registry.register(new CurrentTimeTool());
  const runner = createRunner({ ...selection, input: { timeZone: "Invalid/Zone" } }, registry);
  const result = outcome(await runner.run("What time is it?"));
  assert.equal(result.status, "failed");
  assert.equal(result.result.success, false);
  assert.equal(result.result.output, null);
  assert.match(result.result.error, /Invalid time zone/);
});

test("model and execution exceptions become explicit error context", async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: new CurrentTimeTool().definition,
    async execute() { throw new Error("Execution unavailable"); },
  });
  const executionFailure = outcome(await createRunner(selection, registry).run("Time?"));
  assert.equal(executionFailure.status, "error");
  assert.equal(executionFailure.reason, "Execution unavailable");

  const runner = new ToolRunner(new ToolSelector({
    async generate() { throw new Error("Model unavailable"); },
  }, registry), registry);
  const modelFailure = outcome(await runner.run("Time?"));
  assert.equal(modelFailure.status, "error");
  assert.equal(modelFailure.reason, "Model unavailable");
});

test("diagnostics retain selections and distinguish attempts from success", async () => {
  const registry = new ToolRegistry();
  registry.register(new CurrentTimeTool());
  for (const [decision, status, attempted] of [
    [selection, "success", true],
    [{ ...selection, input: { timeZone: "Invalid/Zone" } }, "failed", true],
    [{ action: "none", reason: "No tool needed" }, "none", false],
    [null, "invalid", false],
  ]) {
    const run = await createRunner(decision, registry).run("Time?");
    const diagnostics = run.diagnostics;
    assert.equal(diagnostics.status, status);
    assert.equal(outcome(run).status, status);
    assert.equal(diagnostics.executionAttempted, attempted);
    if (status !== "invalid") {
      assert.deepEqual(diagnostics.selection, decision);
    }
    for (const key of ["selectionMs", "executionMs", "totalMs"]) {
      assert.ok(Number.isFinite(diagnostics[key]));
      assert.ok(diagnostics[key] >= 0);
    }
    assert.ok(diagnostics.totalMs >= diagnostics.selectionMs + diagnostics.executionMs);
    if (!attempted) assert.equal(diagnostics.executionMs, 0);
    assert.equal(diagnostics.errorStage, status === "failed" ? "execution" : null);
    assert.ok(!run.context.includes('"totalMs"'));
  }
});

test("diagnostics identify exceptions without losing the selected tool", async () => {
  for (const stage of ["selection", "lookup", "execution", "context"]) {
    const registry = new ToolRegistry();
    if (stage !== "lookup") {
      registry.register({
        definition: new CurrentTimeTool().definition,
        async execute() {
          if (stage === "execution") throw new Error("Tool failed");
          return { success: true, output: 1n };
        },
      });
    }
    const runner = new ToolRunner({
      async select() {
        if (stage === "selection") throw new Error("Model failed");
        return selection;
      },
    }, registry);
    const run = await runner.run("Time?");
    assert.equal(run.diagnostics.status, "error");
    assert.equal(run.diagnostics.errorStage, stage);
    assert.equal(run.diagnostics.executionAttempted, stage === "execution" || stage === "context");
    assert.deepEqual(run.diagnostics.selection, stage === "selection" ? null : selection);
    assert.equal(outcome(run).reason, run.diagnostics.error);
    assert.equal(typeof run.diagnostics.error, "string");
  }
});

test("schema validation rejects bad arguments before calling execute", async () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({
    definition: new CurrentTimeTool().definition,
    async execute() {
      calls++;
      return { success: true, output: "ok" };
    },
  });
  for (const input of [{ timeZone: 42 }, { extra: true }]) {
    const run = await createRunner({ ...selection, input }, registry).run("Time?");
    assert.equal(run.diagnostics.status, "invalid");
    assert.equal(run.diagnostics.errorStage, "validation");
    assert.equal(run.diagnostics.executionAttempted, false);
    assert.equal(run.diagnostics.executionMs, 0);
    assert.equal(outcome(run).executed, false);
    assert.equal(outcome(run).reason, run.diagnostics.error);
  }
  assert.equal(calls, 0);
  const valid = await createRunner(selection, registry).run("Time?");
  assert.equal(valid.diagnostics.status, "success");
  assert.equal(calls, 1);
});

test("invalid schema configuration cannot reach tool execution", async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: { ...new CurrentTimeTool().definition, inputSchema: { type: "bad-type" } },
    async execute() { assert.fail("Must not execute"); },
  });
  const run = await createRunner(selection, registry).run("Time?");
  assert.equal(run.diagnostics.status, "error");
  assert.equal(run.diagnostics.errorStage, "validation");
  assert.equal(run.diagnostics.executionAttempted, false);
});
