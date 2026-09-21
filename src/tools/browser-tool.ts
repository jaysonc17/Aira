import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolDefinition, ToolInput, ToolResult } from "./tool.js";

const execFile = promisify(execFileCallback);

export type BrowserProcessRunner = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;

async function runBrowserProcess(
  binary: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return execFile(binary, args as string[], {
    signal,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Distinguishes "binary not on PATH" from any other startup failure so a
 * misbehaving install doesn't get silently skipped from registration.
 */
export async function isBrowserCliAvailable(
  binary = "llm-browser",
): Promise<boolean> {
  try {
    await execFile(binary, ["--version"]);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    return true;
  }
}

const COMMAND_SCHEMAS: Record<string, Record<string, unknown>> = {
  open: {
    properties: {
      command: { const: "open" },
      url: { type: "string", minLength: 1 },
      headless: { type: "boolean" },
    },
    required: ["command", "url"],
    additionalProperties: false,
  },
  close: {
    properties: { command: { const: "close" } },
    required: ["command"],
    additionalProperties: false,
  },
  back: {
    properties: { command: { const: "back" } },
    required: ["command"],
    additionalProperties: false,
  },
  forward: {
    properties: { command: { const: "forward" } },
    required: ["command"],
    additionalProperties: false,
  },
  reload: {
    properties: {
      command: { const: "reload" },
      ignoreCache: { type: "boolean" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  click: {
    properties: {
      command: { const: "click" },
      selector: { type: "string", minLength: 1 },
      text: { type: "string", minLength: 1 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  dblclick: {
    properties: {
      command: { const: "dblclick" },
      selector: { type: "string", minLength: 1 },
    },
    required: ["command", "selector"],
    additionalProperties: false,
  },
  type: {
    properties: {
      command: { const: "type" },
      selector: { type: "string", minLength: 1 },
      text: { type: "string" },
    },
    required: ["command", "selector", "text"],
    additionalProperties: false,
  },
  fill: {
    properties: {
      command: { const: "fill" },
      selector: { type: "string", minLength: 1 },
      text: { type: "string" },
    },
    required: ["command", "selector", "text"],
    additionalProperties: false,
  },
  press: {
    properties: {
      command: { const: "press" },
      key: { type: "string", minLength: 1 },
      selector: { type: "string", minLength: 1 },
    },
    required: ["command", "key"],
    additionalProperties: false,
  },
  hover: {
    properties: {
      command: { const: "hover" },
      selector: { type: "string", minLength: 1 },
    },
    required: ["command", "selector"],
    additionalProperties: false,
  },
  focus: {
    properties: {
      command: { const: "focus" },
      selector: { type: "string", minLength: 1 },
    },
    required: ["command", "selector"],
    additionalProperties: false,
  },
  select: {
    properties: {
      command: { const: "select" },
      selector: { type: "string", minLength: 1 },
      values: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
    },
    required: ["command", "selector", "values"],
    additionalProperties: false,
  },
  scroll: {
    properties: {
      command: { const: "scroll" },
      direction: {
        type: "string",
        enum: ["up", "down", "left", "right", "top", "bottom"],
      },
      px: { type: "integer", minimum: 1 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  scrollintoview: {
    properties: {
      command: { const: "scrollintoview" },
      selector: { type: "string", minLength: 1 },
    },
    required: ["command", "selector"],
    additionalProperties: false,
  },
  wait: {
    properties: {
      command: { const: "wait" },
      selector: { type: "string", minLength: 1 },
      ms: { type: "integer", minimum: 0 },
      text: { type: "string", minLength: 1 },
      url: { type: "string", minLength: 1 },
      timeoutSeconds: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  get: {
    properties: {
      command: { const: "get" },
      target: {
        type: "string",
        enum: [
          "text",
          "html",
          "value",
          "attr",
          "title",
          "url",
          "count",
          "box",
          "styles",
        ],
      },
      selector: { type: "string", minLength: 1 },
      attr: { type: "string", minLength: 1 },
    },
    required: ["command", "target"],
    additionalProperties: false,
  },
  is: {
    properties: {
      command: { const: "is" },
      target: {
        type: "string",
        enum: ["visible", "enabled", "checked", "online"],
      },
      selector: { type: "string", minLength: 1 },
    },
    required: ["command", "target"],
    additionalProperties: false,
  },
  extract: {
    properties: {
      command: { const: "extract" },
      text: { type: "boolean" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  read: {
    properties: {
      command: { const: "read" },
      target: { type: "string", minLength: 1 },
      markdown: { type: "boolean" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  snapshot: {
    properties: {
      command: { const: "snapshot" },
      interactive: { type: "boolean" },
      compact: { type: "boolean" },
      depth: { type: "integer", minimum: 0 },
      selector: { type: "string", minLength: 1 },
      json: { type: "boolean" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  screenshot: {
    properties: {
      command: { const: "screenshot" },
      full: { type: "boolean" },
      format: { type: "string", enum: ["png", "jpeg", "webp"] },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

const DESCRIPTION = `
Drive a real, persistent browser session (SeleniumBase CDP) via the
llm-browser CLI. The session and page state persist across calls within
and across turns until "close" is used. Actions have real-world effects:
submitting forms, clicking checkout/purchase controls, and similar
state-changing actions cannot be undone by this tool.

Prefer read-only commands (get, extract, snapshot, read, is) to gather
information. Treat click, fill, type, select, and press as consequential:
only use them for the specific action described in your reasoning, never
speculatively. Each call requires separate human approval.

Supported commands: open, close, back, forward, reload, click, dblclick,
type, fill, press, hover, focus, select, scroll, scrollintoview, wait,
get, is, extract, read, snapshot, screenshot. Use "snapshot" first to
discover @eN element references or CSS selectors before interacting.
`.trim();

export class BrowserTool implements Tool {
  constructor(
    private readonly binary = "llm-browser",
    private readonly run: BrowserProcessRunner = (args, signal) =>
      runBrowserProcess(binary, args, signal),
  ) {}

  readonly definition: ToolDefinition = {
    name: "browser",
    description: DESCRIPTION,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      oneOf: Object.values(COMMAND_SCHEMAS),
    },
  };

  async execute(input: ToolInput, signal?: AbortSignal): Promise<ToolResult> {
    const command = input.command;
    if (typeof command !== "string" || !(command in COMMAND_SCHEMAS)) {
      return {
        success: false,
        output: null,
        error: `Unsupported browser command: ${String(command)}`,
      };
    }

    const args = buildArgs(command, input);

    try {
      const { stdout } = await this.run(
        [...args, ...(command === "screenshot" ? ["--stdout"] : [])],
        signal,
      );
      return { success: true, output: stdout.trim() };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: describeProcessError(error),
      };
    }
  }
}

function buildArgs(command: string, input: ToolInput): string[] {
  switch (command) {
    case "open": {
      const args = ["open", String(input.url)];
      if (input.headless === true) args.push("--headless");
      return args;
    }
    case "close":
    case "back":
    case "forward":
      return [command];
    case "reload": {
      const args = ["reload"];
      if (input.ignoreCache === true) args.push("--ignore-cache");
      return args;
    }
    case "click": {
      const args = ["click"];
      if (typeof input.selector === "string") args.push(input.selector);
      if (typeof input.text === "string") args.push("--text", input.text);
      return args;
    }
    case "dblclick":
    case "hover":
    case "focus":
    case "scrollintoview":
      return [command, String(input.selector)];
    case "type":
    case "fill":
      return [command, String(input.selector), String(input.text)];
    case "press": {
      const args = ["press", String(input.key)];
      if (typeof input.selector === "string")
        args.push("--selector", input.selector);
      return args;
    }
    case "select": {
      const values = Array.isArray(input.values)
        ? input.values.map(String)
        : [];
      return ["select", String(input.selector), ...values];
    }
    case "scroll": {
      const args = ["scroll"];
      if (input.px !== undefined) {
        args.push(String(input.direction ?? "down"), String(input.px));
      } else if (typeof input.direction === "string") {
        args.push(input.direction);
      }
      return args;
    }
    case "wait": {
      const args = ["wait"];
      if (typeof input.selector === "string") args.push(input.selector);
      if (input.ms !== undefined) args.push("--ms", String(input.ms));
      if (typeof input.text === "string") args.push("--text", input.text);
      if (typeof input.url === "string") args.push("--url", input.url);
      if (input.timeoutSeconds !== undefined)
        args.push("--timeout", String(input.timeoutSeconds));
      return args;
    }
    case "get": {
      const args = ["get", String(input.target)];
      if (typeof input.selector === "string") args.push(input.selector);
      if (typeof input.attr === "string") args.push(input.attr);
      return args;
    }
    case "is": {
      const args = ["is", String(input.target)];
      if (typeof input.selector === "string") args.push(input.selector);
      return args;
    }
    case "extract": {
      const args = ["extract"];
      if (input.text === true) args.push("--text");
      return args;
    }
    case "read": {
      const args = ["read"];
      if (typeof input.target === "string") args.push(input.target);
      if (input.markdown === true) args.push("--markdown");
      return args;
    }
    case "snapshot": {
      const args = ["snapshot"];
      if (input.interactive === true) args.push("--interactive");
      if (input.compact === true) args.push("--compact");
      if (input.depth !== undefined) args.push("--depth", String(input.depth));
      if (typeof input.selector === "string")
        args.push("--selector", input.selector);
      if (input.json === true) args.push("--json");
      return args;
    }
    case "screenshot": {
      const args = ["screenshot"];
      if (input.full === true) args.push("--full");
      if (typeof input.format === "string") args.push("--format", input.format);
      return args;
    }
    default:
      throw new Error(`Unsupported browser command: ${command}`);
  }
}

function describeProcessError(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = "stderr" in error ? String((error as any).stderr) : "";
    if (stderr.trim()) return stderr.trim();
    if ("message" in error) return String((error as any).message);
  }
  return "Browser command failed";
}
