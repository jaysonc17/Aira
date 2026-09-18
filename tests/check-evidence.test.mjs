import assert from "node:assert/strict";
import test from "node:test";
import { checkEvidence } from "../scripts/check-evidence.mjs";
import { toolEvidenceCases } from "../evaluations/tool-evidence.mjs";

test("evidence harness scores fixed cases without leaking expected decisions to the model", async () => {
  let index = 0;
  const model = { async generate(request) {
    const item = toolEvidenceCases[index++];
    const data = JSON.parse(request.prompt);
    assert.equal(data.request, item.prompt);
    assert.equal(data.evidence, item.context);
    assert.equal(Object.hasOwn(data, "availableTools"), false);
    assert.equal(Object.hasOwn(data, "expected"), false);
    assert.ok(request.signal instanceof AbortSignal);
    return JSON.stringify({ action: item.expected === "sufficient" ? "sufficient" : "insufficient", reason: "Fixture decision" });
  } };
  const results = await checkEvidence(model, toolEvidenceCases, () => {});
  assert.equal(results.length, toolEvidenceCases.length);
  assert.ok(results.every(({ passed, durationMs }) => passed && durationMs >= 0));
});

test("wrong judgments, invalid output and model errors are recorded as failures", async () => {
  const responses = ['{"action":"blocked","reason":"Wrong"}', 'not JSON'];
  const results = await checkEvidence({ async generate() {
    if (responses.length) return responses.shift();
    throw new Error("Model unavailable");
  } }, toolEvidenceCases.slice(0, 3), () => {});
  assert.deepEqual(results.map(({ passed }) => passed), [false, false, false]);
  assert.deepEqual(results.map(({ actual }) => actual), ["invalid", "invalid", "error"]);
});

test("cancellation stops the evaluation suite before another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = { async generate() {
    calls++;
    controller.abort(new DOMException("Cancelled", "AbortError"));
    return new Promise(() => {});
  } };
  await assert.rejects(checkEvidence(model, toolEvidenceCases, () => {}, controller.signal), /Cancelled/);
  assert.equal(calls, 1);
});

test("reports preserve failed cases and do not overwrite earlier runs", async (t) => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveEvidenceReport } = await import("../scripts/check-evidence.mjs");
  const directory = await mkdtemp(join(tmpdir(), "aira-evaluation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = { schemaVersion: 1, results: [{ id: "path-hint", actual: "blocked", passed: false }], summary: { passed: 0, total: 1 } };
  const first = await saveEvidenceReport(report, directory);
  const second = await saveEvidenceReport(report, directory);
  assert.notEqual(first, second);
  assert.deepEqual(JSON.parse(await readFile(first, "utf8")), report);
  assert.deepEqual(JSON.parse(await readFile(second, "utf8")), report);
});
