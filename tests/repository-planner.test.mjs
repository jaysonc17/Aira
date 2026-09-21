import assert from "node:assert/strict";
import test from "node:test";
import { RepositoryPlanner } from "../src/tools/repository-planner.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";

function registry() {
  const registry = new ToolRegistry();
  for (const name of ["github/get_file_contents", "github/create_issue"]) {
    registry.register({ definition: { name, description: name, inputSchema: { type: "object" } }, async execute() { assert.fail("Planning must not execute tools"); } });
  }
  return registry;
}
const step = { question: "Which files describe event ingestion?", tool: "github/get_file_contents" };

test("planning returns bounded evidence questions without executing or exposing write tools", async () => {
  const planner = new RepositoryPlanner({ async generate(request) {
    assert.doesNotMatch(request.systemPrompt, /github\/create_issue/);
    assert.deepEqual(JSON.parse(request.prompt), { repository: "example/project", question: "Trace events" });
    assert.ok(request.signal instanceof AbortSignal);
    return JSON.stringify({ steps: [step] });
  } }, registry());
  assert.deepEqual(await planner.plan("example/project", " Trace events "), { repository: "example/project", question: "Trace events", steps: [step] });
});

test("malformed plans, extra fields, duplicates, and unsupported tools are rejected", async () => {
  for (const value of [null, [], {}, { steps: [] }, { steps: [step], extra: true },
    { steps: [step, step] }, { steps: [step, step, step, step] },
    { steps: [{ ...step, question: " " }] }, { steps: [{ ...step, question: "x".repeat(301) }] },
    { steps: [{ ...step, tool: "github/create_issue" }] }, { steps: [{ ...step, input: {} }] }]) {
    const planner = new RepositoryPlanner({ async generate() { return JSON.stringify(value); } }, registry());
    await assert.rejects(planner.plan("example/project", "Trace events"));
  }
});

test("invalid requests and absent tools do not invoke a model", async () => {
  const model = { async generate() { assert.fail("Must not generate"); } };
  await assert.rejects(new RepositoryPlanner(model, registry()).plan("bad", "question"), /owner\/repository/);
  await assert.rejects(new RepositoryPlanner(model, registry()).plan("a/b", " "), /characters/);
  await assert.rejects(new RepositoryPlanner(model, new ToolRegistry()).plan("a/b", "question"), /No supported/);
});

test("planning is bounded even when the model ignores cancellation", async () => {
  const planner = new RepositoryPlanner({ async generate() { return new Promise(() => {}); } }, registry());
  await assert.rejects(planner.plan("a/b", "Trace", undefined, 20), { name: "TimeoutError" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(planner.plan("a/b", "Trace", controller.signal), { name: "AbortError" });
});
