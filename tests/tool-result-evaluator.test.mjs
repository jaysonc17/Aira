import assert from "node:assert/strict";
import test from "node:test";
import { LlmToolResultEvaluator } from "../src/tools/tool-result-evaluator.ts";
import { ToolLoop } from "../src/tools/tool-loop.ts";
import { ToolRunner } from "../src/tools/tool-runner.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";

function setup(responses, output = "Try frontend/README.md") {
  const registry = new ToolRegistry();
  const calls = [];
  registry.register({ definition: { name: "read", description: "Read file", inputSchema: { type: "object" } },
    async execute(input) { calls.push(input.path); return { success: true, output: calls.length === 1 ? output : "React application documentation" }; } });
  const selectionContexts = [];
  const selector = { async select(prompt, history, context) {
    selectionContexts.push(context);
    return { action: "tool", name: "read", input: { path: calls.length ? "frontend/README.md" : "README.md" }, reason: "Read documentation" };
  } };
  const requests = [];
  const evaluator = new LlmToolResultEvaluator({ async generate(request) { requests.push(request); return responses.shift(); } }, registry);
  return { loop: new ToolLoop(new ToolRunner(selector, registry), 3, 16_000, evaluator), calls, requests, selectionContexts };
}
const decision = (action, reason) => JSON.stringify({ action: action === "continue" ? "insufficient" : action, reason });

test("evaluates a hint, follows up, and stops when actual evidence is sufficient", async () => {
  const { loop, calls, requests, selectionContexts } = setup([
    decision("continue", "Read frontend/README.md to obtain the contents"),
    decision("sufficient", "The file contents are available"),
  ]);
  const result = await loop.run("Summarize README", [{ role: "user", content: "Use my repository" }], "Repository context");
  assert.deepEqual(calls, ["README.md", "frontend/README.md"]);
  assert.equal(result.stopReason, "sufficient");
  assert.equal(result.steps.length, 2);
  assert.equal(result.evaluations.length, 2);
  assert.deepEqual(result.evaluationDiagnostics.map(({ step, status }) => ({ step, status })), [
    { step: 1, status: "completed" }, { step: 2, status: "completed" },
  ]);
  assert.ok(result.evaluationDiagnostics.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0));
  assert.ok(result.totalMs >= result.evaluationDiagnostics.reduce((sum, item) => sum + item.durationMs, 0));
  assert.doesNotMatch(selectionContexts[1], /Read frontend\/README.md to obtain/);
  assert.match(selectionContexts[1], /"action":"continue"/);
  assert.doesNotMatch(result.context, /Read frontend\/README.md to obtain/);
  assert.equal(result.evaluations[0].reason, "Read frontend/README.md to obtain the contents");
  assert.match(requests[1].prompt, /React application documentation/);
  assert.match(requests[1].prompt, /Repository context/);
  assert.equal(requests[0].history.length, 1);
  assert.match(result.context, /model judgment, not evidence/);
});

test("malformed assessments stop without another tool call", async () => {
  for (const response of [decision("blocked", "Missing repository owner"), "oops", "null", "[]", '{}',
    decision("accept", "Wrong action"), decision(["sufficient"], "Wrong type"), decision("sufficient", " "), decision("continue", "x".repeat(401)),
    JSON.stringify({ action: "sufficient", reason: "ok", extra: true })]) {
    const { loop, calls } = setup([response]);
    const result = await loop.run("Read");
    assert.equal(calls.length, 1);
    assert.equal(result.stopReason, "evaluation_invalid");
    assert.match(result.context, /Try frontend\/README.md/);
  }
});

test("evaluation shares loop cancellation and handles model errors", async () => {
  const runner = { async run() { return { context: "Evidence", diagnostics: { status: "success", executionAttempted: true } }; } };
  for (const mode of ["timeout", "cancelled", "evaluation_error"]) {
    const controller = new AbortController();
    const evaluator = { async evaluate(prompt, history, context, signal) {
      assert.ok(signal instanceof AbortSignal);
      if (mode === "evaluation_error") throw new Error("Model unavailable");
      if (mode === "cancelled") controller.abort();
      return new Promise(() => {});
    } };
    const result = await new ToolLoop(runner, 3, 16_000, evaluator).run("Read", [], "", controller.signal, 30);
    assert.equal(result.stopReason, mode);
    assert.equal(result.evaluationDiagnostics.length, 1);
    assert.equal(result.evaluationDiagnostics[0].status, mode === "evaluation_error" ? "error" : mode);
    assert.ok(result.evaluationDiagnostics[0].durationMs >= 0);
    assert.equal(result.steps.length, 1);
    assert.match(result.context, /Evidence/);
    assert.match(result.context, /sufficiency is unknown/);
  }
});

test("assessments respect context and step budgets", async () => {
  let evaluations = 0;
  const evaluator = { async evaluate() { evaluations++; return { action: "continue", reason: "x".repeat(400) }; } };
  const runner = { async run() { return { context: "x".repeat(700), diagnostics: { status: "success", executionAttempted: true } }; } };
  const result = await new ToolLoop(runner, 3, 2048, evaluator).run("Read");
  assert.equal(result.stopReason, "context_limit");
  assert.ok(result.contextCharacters <= 2048);
  assert.equal(evaluations, 1);
  const limited = await new ToolLoop(runner, 2, 16_000, evaluator).run("Read");
  assert.equal(limited.stopReason, "limit");
  assert.equal(limited.steps.length, 2);
});

test("failed, denied, and oversized results are never assessed", async () => {
  for (const status of ["failed", "denied", "success"]) {
    const runner = { async run() { return { context: status === "success" ? "x".repeat(20_000) : "Failure", diagnostics: { status, executionAttempted: status !== "denied" } }; } };
    const evaluator = { async evaluate() { assert.fail("Must not evaluate"); } };
    const result = await new ToolLoop(runner, 3, 16_000, evaluator).run("Read");
    assert.equal(result.stopReason, status === "success" ? "context_limit" : status);
    assert.deepEqual(result.evaluations, []);
    assert.deepEqual(result.evaluationDiagnostics, []);
  }
});

test("no-tools guard blocks continuation without rejecting already sufficient evidence", async () => {
  for (const action of ["continue", "sufficient"]) {
    const evaluator = new LlmToolResultEvaluator({ async generate() {
      return decision(action, "Model judgment");
    } }, new ToolRegistry());
    const result = await evaluator.evaluate("Read", [], "Evidence", new AbortController().signal);
    assert.equal(result.action, action === "continue" ? "blocked" : action);
    if (action === "continue") assert.match(result.reason, /no tools are available/);
  }
});

test("insufficient evidence defers missing arguments to selection without execution", async () => {
  let calls = 0;
  const runner = { async run() {
    calls++;
    return calls === 1
      ? { context: "Found INSTALL.md but repository is unknown", diagnostics: { status: "success", executionAttempted: true } }
      : { context: "No tool selected: repository name is missing", diagnostics: { status: "none", executionAttempted: false } };
  } };
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "read", description: "Read file", inputSchema: { type: "object" } }, async execute() { assert.fail("Must not execute"); } });
  const evaluator = new LlmToolResultEvaluator({ async generate() { return decision("continue", "Installation contents are missing"); } }, registry);
  const result = await new ToolLoop(runner, 3, 16_000, evaluator).run("Summarize installation");
  assert.equal(result.stopReason, "none");
  assert.equal(result.steps[1].executionAttempted, false);
  assert.match(result.context, /repository name is missing/);
});
