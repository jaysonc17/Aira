import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolDefinition, ToolInput, ToolResult } from "./tool.js";

const execFile = promisify(execFileCallback);

export type WebSearchProcessRunner = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;

async function runWebSearchProcess(
  binary: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return execFile(binary, args as string[], {
    signal,
    maxBuffer: 10 * 1024 * 1024,
  });
}

const ENGINES = [
  "google",
  "bing",
  "duckduckgo",
  "ddg",
  "reddit",
  "hn",
  "github",
] as const;

const DESCRIPTION = `
Search a known engine or site (google, bing, duckduckgo/ddg, reddit, hn,
github) and return its results in one call, via the llm-browser CLI.
Prefer this over "browser" for a plain research lookup — it opens the
engine's query URL and returns the results directly, without a separate
"open" plus "snapshot" round trip. It is read-only: no human approval is
required, and it shares the same persistent browser session as
"browser" (a prior "close" ends it; a later "browser" call can reuse
the page this leaves open).

Use "json" to get a consistent array of {title, url, snippet} instead of
a snapshot (google, bing, duckduckgo, ddg only). If it comes back empty,
that usually means a captcha/consent wall — rerun without "json" to see
the page. Use "pages" (1-5, requires "json"; google and bing only) to
merge multiple result pages into one deduped array instead of paginating
by hand.

For a site not in this list, or for anything needing interaction (filling
a form, clicking a result, adding to cart), use "browser" instead —
"open" the site, "snapshot" to find element refs, and go from there.
`.trim();

export class WebSearchTool implements Tool {
  constructor(
    private readonly binary = "llm-browser",
    private readonly run: WebSearchProcessRunner = (args, signal) =>
      runWebSearchProcess(binary, args, signal),
  ) {}

  readonly definition: ToolDefinition = {
    name: "web_search",
    description: DESCRIPTION,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ENGINES },
        query: { type: "string", minLength: 1 },
        json: { type: "boolean" },
        pages: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["engine", "query"],
      additionalProperties: false,
    },
  };

  async execute(input: ToolInput, signal?: AbortSignal): Promise<ToolResult> {
    const args = ["search", String(input.engine), String(input.query)];
    if (input.json === true) args.push("--json");
    if (input.pages !== undefined) args.push("--pages", String(input.pages));

    try {
      const { stdout } = await this.run(args, signal);
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

function describeProcessError(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = "stderr" in error ? String((error as any).stderr) : "";
    if (stderr.trim()) return stderr.trim();
    if ("message" in error) return String((error as any).message);
  }
  return "Web search command failed";
}
