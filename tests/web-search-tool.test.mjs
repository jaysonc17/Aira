import assert from "node:assert/strict";
import test from "node:test";
import { WebSearchTool } from "../src/tools/web-search-tool.ts";
import { ToolInputValidator } from "../src/tools/tool-input-validator.ts";

function fakeRunner(calls, response = { stdout: "ok", stderr: "" }) {
  return async (args, signal) => {
    calls.push({ args, signal });
    return response;
  };
}

test("definition never requires approval and validates engine/query", () => {
  const tool = new WebSearchTool();
  assert.equal(tool.definition.requiresApproval, false);
  const validator = new ToolInputValidator();
  assert.equal(
    validator.validate(tool.definition, { engine: "google", query: "llm browser automation" }),
    null,
  );
  assert.equal(typeof validator.validate(tool.definition, { engine: "altavista", query: "x" }), "string");
  assert.equal(typeof validator.validate(tool.definition, { engine: "google" }), "string");
  assert.equal(typeof validator.validate(tool.definition, { engine: "google", query: "x", extra: true }), "string");
});

test("builds the base search command", async () => {
  const calls = [];
  const tool = new WebSearchTool("llm-browser", fakeRunner(calls));
  const result = await tool.execute({ engine: "hn", query: "llm agents" });
  assert.equal(result.success, true);
  assert.equal(result.output, "ok");
  assert.deepEqual(calls[0].args, ["search", "hn", "llm agents"]);
});

test("forwards --json and --pages when provided", async () => {
  const calls = [];
  const tool = new WebSearchTool("llm-browser", fakeRunner(calls));
  await tool.execute({ engine: "google", query: "x", json: true });
  await tool.execute({ engine: "google", query: "x", json: true, pages: 3 });
  assert.deepEqual(calls[0].args, ["search", "google", "x", "--json"]);
  assert.deepEqual(calls[1].args, ["search", "google", "x", "--json", "--pages", "3"]);
});

test("a non-zero exit becomes a failed ToolResult using stderr, not a thrown error", async () => {
  const tool = new WebSearchTool("llm-browser", async () => {
    const error = new Error("Command failed");
    error.stderr = "Unknown engine";
    throw error;
  });
  const result = await tool.execute({ engine: "google", query: "x" });
  assert.equal(result.success, false);
  assert.equal(result.error, "Unknown engine");
});

test("the abort signal is forwarded to the process runner", async () => {
  const calls = [];
  const tool = new WebSearchTool("llm-browser", fakeRunner(calls));
  const controller = new AbortController();
  await tool.execute({ engine: "google", query: "x" }, controller.signal);
  assert.equal(calls[0].signal, controller.signal);
});
