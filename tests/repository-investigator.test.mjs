import assert from "node:assert/strict";
import test from "node:test";
import { RepositoryInvestigator } from "../src/tools/repository-investigator.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";

function setup({ owner = "example", approval = false, allow = false } = {}) {
  const calls = [];
  const requests = [];
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "github/get_file_contents", description: "Read", requiresApproval: approval,
    inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["owner", "repo", "path"], additionalProperties: false } },
    async execute(input) { calls.push(input); return { success: true, output: "README.md: A CSV converter." }; } });
  registry.register({ definition: { name: "github/create_issue", description: "Write", inputSchema: { type: "object" } }, async execute() { assert.fail("Must not write"); } });
  const responses = [
    JSON.stringify({ steps: [{ question: "What does the documentation say?", tool: "github/get_file_contents" }] }),
    JSON.stringify({ action: "tool", name: "github/get_file_contents", input: { owner, repo: "project", path: "README.md" }, reason: "Read documentation" }),
    ...((owner === "example" && (!approval || allow)) ? [JSON.stringify({ action: "sufficient", reason: "Content is present" })] : []),
    "Repository findings or limitations.",
  ];
  const investigator = new RepositoryInvestigator({ async generate(request) { requests.push(request); return responses.shift(); } }, registry, async () => allow);
  return { investigator, calls, requests };
}

test("investigation plans, executes scoped reads, and answers from evidence", async () => {
  const { investigator, calls, requests } = setup();
  const result = await investigator.investigate("example/project", "What is this?");
  assert.equal(calls.length, 1);
  assert.equal(result.evidence.stopReason, "sufficient");
  assert.match(requests.at(-1).systemPrompt, /CSV converter/);
  assert.doesNotMatch(requests.at(-1).systemPrompt, /What does the documentation say/);
  assert.doesNotMatch(requests[1].systemPrompt, /github\/create_issue/);
  assert.equal(result.plan.steps.length, 1);
});

test("a model cannot execute against a different repository", async () => {
  const { investigator, calls } = setup({ owner: "other" });
  const result = await investigator.investigate("example/project", "Read");
  assert.equal(calls.length, 0);
  assert.equal(result.evidence.stopReason, "failed");
  assert.match(result.evidence.context, /requested owner and repository/);
});

test("investigation retains approval policy", async () => {
  for (const allow of [false, true]) {
    const { investigator, calls } = setup({ approval: true, allow });
    const result = await investigator.investigate("example/project", "Read");
    assert.equal(calls.length, allow ? 1 : 0);
    assert.equal(result.evidence.stopReason, allow ? "sufficient" : "denied");
  }
});

test("cancellation prevents planning and execution", async () => {
  const { investigator, calls, requests } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(investigator.investigate("example/project", "Read", controller.signal), { name: "AbortError" });
  assert.equal(calls.length, 0);
  assert.equal(requests.length, 0);
});

function multiFileSetup(paths, outputs, assessments) {
  const calls = [];
  const requests = [];
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "github/get_file_contents", description: "Read repository file",
      inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["owner", "repo", "path"], additionalProperties: false },
    },
    async execute(input) { calls.push(input.path); return { success: true, output: outputs[input.path] }; },
  });
  const responses = [JSON.stringify({ steps: [
    { question: "Locate the event entry point", tool: "github/get_file_contents" },
    { question: "Trace how rule matches become alerts", tool: "github/get_file_contents" },
  ] })];
  for (const [index, path] of paths.entries()) {
    responses.push(JSON.stringify({ action: "tool", name: "github/get_file_contents", input: { owner: "example", repo: "project", path }, reason: "Read the next source file" }));
    responses.push(JSON.stringify({ action: assessments[index], reason: "Check source coverage" }));
  }
  responses.push("Answer based on the collected source files.");
  const model = { async generate(request) { requests.push(request); assert.ok(responses.length, "Unexpected additional model request"); return responses.shift(); } };
  return { investigator: new RepositoryInvestigator(model, registry), calls, requests };
}

test("multi-file investigation carries discovered relationships into selection and the final answer", async () => {
  const { investigator, calls, requests } = multiFileSetup(
    ["src/EventController.java", "src/RuleService.java"],
    {
      "src/EventController.java": "EventController.ingest validates an event then calls RuleService.evaluate. Implementation: src/RuleService.java.",
      "src/RuleService.java": "RuleService.evaluate saves a FraudAlert when a rule matches the event.",
    }, ["insufficient", "sufficient"],
  );
  const result = await investigator.investigate("example/project", "How do ingested events generate alerts?");
  assert.deepEqual(calls, ["src/EventController.java", "src/RuleService.java"]);
  assert.match(requests[3].systemPrompt, /EventController.ingest validates/);
  assert.match(requests[3].systemPrompt, /src\/RuleService.java/);
  const answerContext = requests.at(-1).systemPrompt;
  assert.match(answerContext, /EventController.ingest validates/);
  assert.match(answerContext, /saves a FraudAlert/);
  assert.doesNotMatch(answerContext, /Locate the event entry point/);
  assert.equal(result.evidence.stopReason, "sufficient");
  assert.equal(result.evidence.steps.length, 2);
});

test("unfinished investigation stops after six reads and passes its limit to the answer", async () => {
  const paths = Array.from({ length: 6 }, (_, index) => `src/Step${index}.java`);
  const { investigator, calls, requests } = multiFileSetup(paths,
    Object.fromEntries(paths.map((path) => [path, `Partial evidence from ${path}; additional implementation is missing.`])),
    paths.map(() => "insufficient"));
  const result = await investigator.investigate("example/project", "Trace the full pipeline");
  assert.deepEqual(calls, paths);
  assert.equal(result.evidence.stopReason, "limit");
  assert.equal(result.incomplete, true);
  assert.match(result.answer, /^Investigation incomplete \(stop: limit\)/);
  assert.match(requests.at(-1).systemPrompt, /Tool loop stopped: limit/);
  assert.match(requests.at(-1).systemPrompt, /explain.*\nmissing information or limits/);
});

test("overall investigation deadline also bounds final answer generation", async () => {
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "github/get_file_contents", description: "Read", inputSchema: { type: "object" } }, async execute() { assert.fail("No tool selected"); } });
  let calls = 0;
  const model = { async generate() {
    calls++;
    if (calls === 1) return JSON.stringify({ steps: [{ question: "Find evidence", tool: "github/get_file_contents" }] });
    if (calls === 2) return JSON.stringify({ action: "none", reason: "Missing information" });
    return new Promise(() => {});
  } };
  await assert.rejects(new RepositoryInvestigator(model, registry).investigate("example/project", "Trace", undefined, 100), { name: "TimeoutError" });
  assert.equal(calls, 3);
});

test("resolved directory hints reach subsequent selection without claiming source inspection", async () => {
  const { investigator, calls, requests } = multiFileSetup(
    ["event/", "src/main/java/example/event/", "src/main/java/example/event/Controller.java"],
    {
      "event/": "Matching directories: src/main/java/example/event/, src/test/java/example/event/. Contents not retrieved.",
      "src/main/java/example/event/": "Files: src/main/java/example/event/Controller.java",
      "src/main/java/example/event/Controller.java": "Controller.ingest calls the rule evaluator.",
    }, ["insufficient", "insufficient", "sufficient"],
  );
  const result = await investigator.investigate("example/project", "Trace ingestion");
  assert.match(requests[3].systemPrompt, /Matching directories: src\/main\/java\/example\/event/);
  assert.match(requests[3].systemPrompt, /use a returned full path/);
  assert.equal(calls.at(-1), "src/main/java/example/event/Controller.java");
  assert.equal(result.incomplete, false);
  assert.doesNotMatch(result.answer, /^Investigation incomplete/);
});

test("incomplete gathering is visibly labeled independently of model wording", async () => {
  const { investigator } = setup({ owner: "other" });
  const result = await investigator.investigate("example/project", "Trace implementation");
  assert.equal(result.incomplete, true);
  assert.match(result.answer, /^Investigation incomplete \(stop: failed\)/);
  assert.match(result.answer, /trace has not been verified/);
});
