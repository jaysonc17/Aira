import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserTool,
  isBrowserCliAvailable,
} from "../src/tools/browser-tool.ts";
import { ToolInputValidator } from "../src/tools/tool-input-validator.ts";

function fakeRunner(calls, response = { stdout: "ok", stderr: "" }) {
  return async (args, signal) => {
    calls.push({ args, signal });
    return response;
  };
}

test("definition requires approval and exposes a per-command schema", () => {
  const tool = new BrowserTool();
  assert.equal(tool.definition.requiresApproval, true);
  const validator = new ToolInputValidator();
  assert.equal(
    validator.validate(tool.definition, { command: "open", url: "https://example.com" }),
    null,
  );
  assert.equal(typeof validator.validate(tool.definition, { command: "open" }), "string");
  assert.equal(typeof validator.validate(tool.definition, { command: "unknown" }), "string");
});

test("rejects missing required fields per command", () => {
  const validator = new ToolInputValidator();
  const definition = new BrowserTool().definition;
  for (const input of [
    { command: "dblclick" },
    { command: "type", selector: "#a" },
    { command: "fill", selector: "#a" },
    { command: "press" },
    { command: "hover" },
    { command: "select", selector: "#a" },
    { command: "get" },
    { command: "is" },
  ]) {
    assert.equal(
      typeof validator.validate(definition, input),
      "string",
      JSON.stringify(input),
    );
  }
});

test("open builds a URL argument and forwards headless", async () => {
  const calls = [];
  const tool = new BrowserTool("llm-browser", fakeRunner(calls));
  const result = await tool.execute({
    command: "open",
    url: "https://example.com",
    headless: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.output, "ok");
  assert.deepEqual(calls[0].args, ["open", "https://example.com", "--headless"]);
});

test("fill and type pass selector and text positionally", async () => {
  const calls = [];
  const tool = new BrowserTool("llm-browser", fakeRunner(calls));
  await tool.execute({ command: "fill", selector: "#email", text: "a@b.com" });
  await tool.execute({ command: "type", selector: "#notes", text: "hi" });
  assert.deepEqual(calls[0].args, ["fill", "#email", "a@b.com"]);
  assert.deepEqual(calls[1].args, ["type", "#notes", "hi"]);
});

test("select spreads multiple values", async () => {
  const calls = [];
  const tool = new BrowserTool("llm-browser", fakeRunner(calls));
  await tool.execute({ command: "select", selector: "#size", values: ["M", "L"] });
  assert.deepEqual(calls[0].args, ["select", "#size", "M", "L"]);
});

test("screenshot always forces --stdout regardless of input and never accepts a path", async () => {
  const calls = [];
  const tool = new BrowserTool("llm-browser", fakeRunner(calls));
  const result = await tool.execute({ command: "screenshot", full: true, format: "jpeg" });
  assert.deepEqual(calls[0].args, ["screenshot", "--full", "--format", "jpeg", "--stdout"]);
  assert.equal(result.success, true);

  const validator = new ToolInputValidator();
  assert.equal(
    typeof validator.validate(tool.definition, { command: "screenshot", path: "/etc/passwd" }),
    "string",
  );
});

test("a non-zero exit becomes a failed ToolResult using stderr, not a thrown error", async () => {
  const tool = new BrowserTool("llm-browser", async () => {
    const error = new Error("Command failed");
    error.stderr = "Element not found: #missing";
    throw error;
  });
  const result = await tool.execute({ command: "click", selector: "#missing" });
  assert.equal(result.success, false);
  assert.equal(result.error, "Element not found: #missing");
});

test("unsupported commands fail without invoking the process runner", async () => {
  const calls = [];
  const tool = new BrowserTool("llm-browser", fakeRunner(calls));
  const result = await tool.execute({ command: "eval", script: "1+1" });
  assert.equal(result.success, false);
  assert.equal(calls.length, 0);
});

test("the abort signal is forwarded to the process runner", async () => {
  const calls = [];
  const tool = new BrowserTool("llm-browser", fakeRunner(calls));
  const controller = new AbortController();
  await tool.execute({ command: "close" }, controller.signal);
  assert.equal(calls[0].signal, controller.signal);
});

test("isBrowserCliAvailable distinguishes a missing binary from an installed one", async () => {
  assert.equal(await isBrowserCliAvailable("node"), true);
  assert.equal(
    await isBrowserCliAvailable("definitely-not-a-real-browser-cli-xyz"),
    false,
  );
});
