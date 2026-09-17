import assert from "node:assert/strict";
import test from "node:test";
import { LlmEvaluator } from "../src/llm-evaluator.ts";
import { generateAnswer } from "../src/answer-generator.ts";

const accepted = { passed: true, score: 0.8, action: "accept", reason: "Supported by evidence" };
const evaluatorFor = (response) => new LlmEvaluator({ async generate() { return response; } });

test("preserves valid decisions including score boundaries", async () => {
  for (const decision of [
    accepted, { ...accepted, score: 1 },
    { passed: false, score: 0.79, action: "retry", reason: "Needs clarification" },
    { passed: false, score: 0, action: "escalate", reason: "Incorrect" },
  ]) {
    assert.deepEqual(await evaluatorFor(JSON.stringify(decision)).evaluate("Question", "Answer"), decision);
  }
});

test("malformed JSON and wrong response shapes cannot approve", async () => {
  for (const response of ["invalid", "null", "[]", "42", '"accept"', "{}"]) {
    const result = await evaluatorFor(response).evaluate("Question", "Answer");
    assert.equal(result.action, "escalate");
    assert.equal(result.passed, false);
    assert.equal(result.score, 0);
  }
});

test("rejects coercion, missing fields, extra fields, and contradictory decisions", async () => {
  for (const decision of [
    { ...accepted, passed: "false" }, { ...accepted, passed: "true" },
    { ...accepted, passed: 1 }, { ...accepted, passed: false },
    { ...accepted, score: "0.9" }, { ...accepted, score: -1 },
    { ...accepted, score: 2 }, { ...accepted, score: 0.79 },
    { ...accepted, score: null }, { ...accepted, reason: " " },
    { ...accepted, reason: undefined }, { ...accepted, passed: undefined },
    { ...accepted, action: "unknown" }, { ...accepted, extra: true },
    { ...accepted, action: "retry" },
    { ...accepted, passed: false, action: "escalate" },
  ]) {
    const result = await evaluatorFor(JSON.stringify(decision)).evaluate("Question", "Answer");
    assert.equal(result.action, "escalate", JSON.stringify(decision));
    assert.equal(result.passed, false);
    assert.match(result.reason, /invalid or inconsistent/);
  }
  assert.equal((await evaluatorFor('{"passed":true,"score":1e400,"action":"accept","reason":"Test"}').evaluate("Q", "A")).passed, false);
});

test("malformed approval escalates through the answer generation flow", async () => {
  const calls = [];
  const models = Object.fromEntries(["fast", "reasoning"].map(role => [role, {
    async generate() { calls.push(role); return role; },
  }]));
  const result = await generateAnswer({ prompt: "Question" }, "fast", models,
    evaluatorFor(JSON.stringify({ ...accepted, passed: "false" })), "Evidence");
  assert.deepEqual(calls, ["fast", "reasoning"]);
  assert.equal(result.role, "reasoning");
});

test("model failures propagate and cancellation reaches the judge", async () => {
  const controller = new AbortController();
  const failure = new Error("Model unavailable");
  const evaluator = new LlmEvaluator({ async generate(request) {
    assert.equal(request.signal, controller.signal);
    throw failure;
  } });
  await assert.rejects(evaluator.evaluate("Q", "A", "Evidence", controller.signal), failure);
});
