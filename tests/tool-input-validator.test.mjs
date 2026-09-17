import assert from "node:assert/strict";
import test from "node:test";
import { ToolInputValidator } from "../src/tools/tool-input-validator.ts";

const definition = {
  name: "example",
  description: "Validation fixture",
  inputSchema: {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1 },
      mode: { type: "string", enum: ["brief", "full"], default: "brief" },
      options: {
        type: "object",
        properties: { labels: { type: "array", items: { type: "string" } } },
        required: ["labels"],
        additionalProperties: false,
      },
    },
    required: ["count"],
    additionalProperties: false,
  },
};

test("validates nested input without filling defaults or changing arguments", () => {
  const validator = new ToolInputValidator();
  const input = { count: 2, options: { labels: ["example"] } };
  const before = structuredClone(input);
  assert.equal(validator.validate(definition, input), null);
  assert.deepEqual(input, before);
});

test("rejects missing fields, incorrect types, extra fields and nested violations", () => {
  const validator = new ToolInputValidator();
  for (const input of [
    {}, { count: "2" }, { count: 0 }, { count: 1.5 },
    { count: 2, extra: true }, { count: 2, mode: "unknown" },
    { count: 2, options: {} }, { count: 2, options: { labels: [42] } },
  ]) {
    const before = structuredClone(input);
    assert.equal(typeof validator.validate(definition, input), "string");
    assert.deepEqual(input, before);
  }
});

test("invalid, unsupported and asynchronous schemas throw", () => {
  const validator = new ToolInputValidator();
  for (const inputSchema of [
    { type: "not-a-type" },
    { type: "object", unknownKeyword: true },
    { type: "object", $async: true },
  ]) {
    assert.throws(() => validator.validate({ ...definition, inputSchema }, {}));
  }
});

test("MCP header metadata does not weaken argument type validation", () => {
  const validator = new ToolInputValidator();
  const tool = { ...definition, inputSchema: {
    type: "object",
    properties: { owner: { type: "string", "x-mcp-header": "Owner" } },
    required: ["owner"],
  } };
  assert.equal(validator.validate(tool, { owner: "example" }), null);
  assert.equal(typeof validator.validate(tool, { owner: 42 }), "string");
});
