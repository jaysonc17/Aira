import assert from "node:assert/strict";
import test from "node:test";
import { compareEvidence } from "../scripts/compare-evidence.mjs";

function report(actual = "sufficient", overrides = {}) {
  const item = { id: "content", prompt: "Summarize", context: "Text", tools: [], expected: "sufficient", ...overrides };
  return { schemaVersion: 1, cases: [item], results: [{ id: item.id, expected: item.expected, actual, passed: actual === item.expected, durationMs: 100 }] };
}

test("compares decisions by case identity and excludes changed inputs", () => {
  assert.equal(compareEvidence(report("blocked"), report())[0].change, "improved");
  assert.equal(compareEvidence(report(), report("blocked"))[0].change, "regressed");
  for (const change of [{ prompt: "Other" }, { context: "New evidence" }, { tools: [{ name: "new" }] }, { expected: "blocked" }]) {
    assert.equal(compareEvidence(report(), report("blocked", change))[0].change, "case_changed");
  }
  assert.deepEqual(compareEvidence(report(), report("sufficient", { id: "new" })).map((row) => row.change), ["removed", "added"]);
});

test("request errors remain explicit and never produce speed comparisons", () => {
  const rows = compareEvidence(report(), report("timeout"));
  assert.equal(rows[0].change, "regressed");
  assert.equal(rows[0].after, "timeout");
  assert.equal(rows[0].durationDeltaMs, null);
  const faster = report();
  faster.results[0].durationMs = 25;
  assert.equal(compareEvidence(report(), faster)[0].durationDeltaMs, -75);
});

test("rejects malformed, duplicate, missing, and contradictory results", () => {
  for (const mutate of [
    (r) => { r.schemaVersion = 2; },
    (r) => { r.cases.push(r.cases[0]); },
    (r) => { r.results.push(r.results[0]); },
    (r) => { r.results = []; },
    (r) => { r.results[0].passed = false; },
    (r) => { r.results[0].durationMs = -1; },
    (r) => { r.results[0].actual = "nonsense"; },
  ]) {
    const invalid = report();
    mutate(invalid);
    assert.throws(() => compareEvidence(report(), invalid));
  }
});
