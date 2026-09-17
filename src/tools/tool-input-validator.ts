import { Ajv } from "ajv";
import type { ToolDefinition, ToolInput } from "./tool.js";

export class ToolInputValidator {
  private readonly ajv = new Ajv({
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  }).addKeyword({
    // MCP transport metadata, not an input constraint.
    keyword: "x-mcp-header",
    schemaType: "string",
    valid: true,
  });

  validate(definition: ToolDefinition, input: ToolInput): string | null {
    const validate = this.prepare(definition);

    if (validate(input)) {
      return null;
    }

    return this.ajv.errorsText(validate.errors, {
      dataVar: "input",
    });
  }

  prepare(definition: ToolDefinition) {
    const validate = this.ajv.compile(definition.inputSchema);

    if ("$async" in validate && validate.$async) {
      throw new Error("Asynchronous tool input schemas are not supported");
    }

    return validate;
  }
}
