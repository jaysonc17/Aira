import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { ToolSelector } from "../src/tools/tool-selector.ts";

function createRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "current_time",
      description: "Get the current time",
      inputSchema: { type: "object" },
    },
    async execute() {
      assert.fail("Selection must not execute a tool");
    },
  });
  return registry;
}

test("an empty registry skips model generation", async () => {
  const selector = new ToolSelector({
    async generate() {
      assert.fail("No model call is needed without tools");
    },
  }, new ToolRegistry());

  assert.equal((await selector.select("Hello")).action, "none");
});

test("selects a registered tool without executing it", async () => {
  const decision = {
    action: "tool",
    name: "current_time",
    input: { timeZone: "Australia/Melbourne" },
    reason: "The user needs the current time",
  };
  const selector = new ToolSelector({
    async generate(request) {
      assert.equal(request.prompt, "What time is it in Melbourne?");
      assert.ok(request.systemPrompt.includes('"name":"current_time"'));
      assert.ok(request.systemPrompt.includes('"inputSchema"'));
      assert.equal(request.thinking, false);
      return JSON.stringify(decision);
    },
  }, createRegistry());

  assert.deepEqual(
    await selector.select("What time is it in Melbourne?"),
    decision,
  );
});

test("preserves an explicit no-tool decision", async () => {
  const decision = { action: "none", reason: "A greeting needs no tool" };
  const selector = new ToolSelector({
    async generate() { return JSON.stringify(decision); },
  }, createRegistry());

  assert.deepEqual(await selector.select("Hello"), decision);
});

test("rejects malformed decisions and unknown tools", async () => {
  const valid = {
    action: "tool",
    name: "current_time",
    input: {},
    reason: "Needs current time",
  };
  const responses = [
    "not JSON",
    "null",
    "[]",
    "42",
    "{}",
    JSON.stringify({ ...valid, name: "unknown_tool" }),
    JSON.stringify({ ...valid, input: null }),
    JSON.stringify({ ...valid, input: [] }),
    JSON.stringify({ ...valid, input: "UTC" }),
    JSON.stringify({ ...valid, reason: " " }),
    JSON.stringify({ ...valid, action: "execute" }),
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ ...valid, action: "none" }),
    JSON.stringify({ action: "none" }),
    JSON.stringify({ action: "tool", name: "current_time", input: {} }),
  ];

  for (const response of responses) {
    const selector = new ToolSelector({
      async generate() { return response; },
    }, createRegistry());
    assert.equal((await selector.select("What time is it?")).action, "invalid", response);
  }
});

test("propagates model failures so callers can handle them", async () => {
  const failure = new Error("Model unavailable");
  const selector = new ToolSelector({
    async generate() { throw failure; },
  }, createRegistry());

  await assert.rejects(selector.select("What time is it?"), failure);
});
