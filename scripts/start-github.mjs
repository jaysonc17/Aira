import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Use an explicitly supplied token first, otherwise the existing gh login.
if (!process.env.AIRA_GITHUB_TOKEN) {
  const { stdout } = await promisify(execFile)("gh", ["auth", "token", "--hostname", "github.com"]);
  process.env.AIRA_GITHUB_TOKEN = stdout.trim();
}

await import("../src/index.ts");
