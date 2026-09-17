import assert from "node:assert/strict";
import test from "node:test";
import { generateAnswer } from "../src/answer-generator.ts";

function setup(actions) {
  const generated = [];
  const judged = [];
  const models = Object.fromEntries(["fast", "reasoning"].map(role => [role, {
    async generate(request) {
      generated.push({ role, request });
      return `${role} answer ${generated.length}`;
    },
  }]));
  const evaluator = { async evaluate(...args) {
    judged.push(args);
    const action = actions.shift();
    assert.ok(action, "Unexpected evaluation");
    return { action, passed: action === "accept", score: 0.9, reason: "Explain the missing detail" };
  } };
  return { generated, judged, models, evaluator };
}
const request = { prompt: "Summarize", systemPrompt: "TOOL EVIDENCE", history: [{ role: "user", content: "Earlier" }] };

test("accepted first answer needs no additional generation", async () => {
  const s = setup(["accept"]);
  const result = await generateAnswer(request, "fast", s.models, s.evaluator, "Evidence");
  assert.equal(s.generated.length, 1);
  assert.equal(result.answer, "fast answer 1");
  assert.equal(result.retried, false);
});

test("one retry receives feedback and is re-evaluated with unchanged evidence", async () => {
  const s = setup(["retry", "accept"]);
  const before = structuredClone(request);
  const result = await generateAnswer(request, "fast", s.models, s.evaluator, "Evidence");
  assert.deepEqual(s.generated.map(call => call.role), ["fast", "fast"]);
  assert.match(s.generated[1].request.systemPrompt, /TOOL EVIDENCE/);
  assert.match(s.generated[1].request.systemPrompt, /Explain the missing detail/);
  assert.match(s.generated[1].request.systemPrompt, /fast answer 1/);
  assert.deepEqual(s.judged.map(call => call[2]), ["Evidence", "Evidence"]);
  assert.deepEqual(request, before);
  assert.deepEqual(s.generated[1].request.history, request.history);
  assert.equal(result.answer, "fast answer 2");
  assert.equal(result.retried, true);
});

test("repeated retry requests escalate instead of looping", async () => {
  const s = setup(["retry", "retry"]);
  const result = await generateAnswer(request, "fast", s.models, s.evaluator, "Evidence");
  assert.deepEqual(s.generated.map(call => call.role), ["fast", "fast", "reasoning"]);
  assert.equal(result.role, "reasoning");
  assert.equal(s.judged.length, 2);
  assert.match(s.generated[2].request.systemPrompt, /TOOL EVIDENCE/);
});

test("immediate escalation and direct reasoning are bounded", async () => {
  const s = setup(["escalate"]);
  const result = await generateAnswer(request, "fast", s.models, s.evaluator, "Evidence");
  assert.equal(result.retried, false);
  assert.deepEqual(s.generated.map(call => call.role), ["fast", "reasoning"]);
  const direct = setup([]);
  await generateAnswer(request, "reasoning", direct.models, direct.evaluator, "Evidence");
  assert.equal(direct.generated.length, 1);
  assert.equal(direct.judged.length, 0);
});

test("cancellation after evaluation prevents retry or escalation", async () => {
  const controller = new AbortController();
  const s = setup([]);
  const evaluator = { async evaluate(prompt, answer, context, signal) {
    assert.equal(signal, controller.signal);
    controller.abort();
    return { action: "retry", passed: false, score: 0, reason: "Test" };
  } };
  await assert.rejects(generateAnswer({ ...request, signal: controller.signal }, "fast", s.models, evaluator, "Evidence"), { name: "AbortError" });
  assert.equal(s.generated.length, 1);
});
