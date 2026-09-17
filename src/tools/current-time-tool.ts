import type { Tool, ToolDefinition, ToolInput, ToolResult } from "./tool.js";

export class CurrentTimeTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "current_time",

    description: "Get the current time in UTC and an optional time zone.",

    inputSchema: {
      type: "object",
      properties: {
        timeZone: {
          type: "string",
          description:
            "Time zone such as Australia/Melbourne. Defaults to UTC.",
        },
      },
      additionalProperties: false,
    },
  };

  async execute(input: ToolInput): Promise<ToolResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {
        success: false,
        output: null,
        error: "Input must be an object",
      };
    }

    if (Object.keys(input).some((key) => key !== "timeZone")) {
      return {
        success: false,
        output: null,
        error: "Only timeZone is accepted",
      };
    }

    const timeZone = "timeZone" in input ? input.timeZone : "UTC";

    if (typeof timeZone !== "string" || !timeZone.trim()) {
      return {
        success: false,
        output: null,
        error: "timeZone must be a non-empty string",
      };
    }

    let formatter: Intl.DateTimeFormat;

    try {
      formatter = new Intl.DateTimeFormat("en-AU", {
        timeZone,
        dateStyle: "full",
        timeStyle: "long",
      });
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }

      return {
        success: false,
        output: null,
        error: `Invalid time zone: ${timeZone}`,
      };
    }

    const now = new Date();

    return {
      success: true,
      output: {
        iso: now.toISOString(),
        timeZone: formatter.resolvedOptions().timeZone,
        localTime: formatter.format(now),
      },
    };
  }
}
