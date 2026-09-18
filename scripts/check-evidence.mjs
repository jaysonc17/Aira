import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ModelRegistry } from "../src/models/model-registry.ts";
import { LlmToolResultEvaluator } from "../src/tools/tool-result-evaluator.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { abortable, createDeadline } from "../src/cancellation.ts";
import { toolEvidenceCases } from "../evaluations/tool-evidence.mjs";

export async function checkEvidence(model, cases, report = console.log, signal) {
  const results = [];
  for (const item of cases) {
    signal?.throwIfAborted();
    const registry = new ToolRegistry();
    for (const definition of item.tools) {
      registry.register({ definition, async execute() { throw new Error("Evaluation cases must never execute tools"); } });
    }
    report(`Checking ${item.id} (expected ${item.expected})...`);
    const started = performance.now();
    const deadline = createDeadline(120_000, signal);
    let actual;
    let reason;
    try {
      const decision = await abortable(() => new LlmToolResultEvaluator(model, registry).evaluate(item.prompt, [], item.context, deadline.signal), deadline.signal);
      actual = decision.action;
      reason = decision.reason;
    } catch (error) {
      signal?.throwIfAborted();
      actual = deadline.signal.aborted ? "timeout" : "error";
      reason = error instanceof Error ? error.message : "Evaluation failed";
    } finally {
      deadline.dispose();
    }
    const result = { id: item.id, expected: item.expected, actual, passed: actual === item.expected, durationMs: performance.now() - started, reason };
    results.push(result);
    report(JSON.stringify(result));
  }
  return results;
}

async function sourceFingerprints() {
  const paths = [
    "../src/tools/tool-result-evaluator.ts",
    "../src/models/model-registry.ts",
    "../src/models/local-model.ts",
    "../evaluations/tool-evidence.mjs",
    "./check-evidence.mjs",
  ];
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path, createHash("sha256").update(await readFile(new URL(path, import.meta.url))).digest("hex"),
  ])));
}

export async function saveEvidenceReport(report, directory = ".cache/evaluations") {
  await mkdir(directory, { recursive: true });
  const filename = `evidence-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`;
  const path = join(directory, filename);
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return path;
}

async function main() {
  const { values, positionals } = parseArgs({ options: { report: { type: "boolean", default: false } }, allowPositionals: true });
  const [role = "fast", caseId, ...extra] = positionals;
  if (!["fast", "reasoning"].includes(role) || extra.length || (caseId && !toolEvidenceCases.some(({ id }) => id === caseId))) {
    throw new Error(`Usage: npm run check:evidence -- [fast|reasoning] [${toolEvidenceCases.map(({ id }) => id).join("|")}] [--report]`);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("Evidence check cancelled", "AbortError"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    console.log(`Evidence checks using ${role}; synthetic cases, no tool execution.`);
    const cases = toolEvidenceCases.filter(({ id }) => !caseId || id === caseId);
    const startedAt = new Date().toISOString();
    const fingerprints = values.report ? await sourceFingerprints() : undefined;
    const results = await checkEvidence(new ModelRegistry().get(role), cases, console.log, controller.signal);
    const passed = results.filter((result) => result.passed).length;
    const errors = results.filter(({ actual }) => actual === "error" || actual === "timeout").length;
    const mismatches = results.length - passed - errors;
    console.log(`${passed} passed; ${mismatches} incorrect or invalid decisions; ${errors} request errors/timeouts (${results.length} cases). This small suite is a regression check, not a general reliability score.`);
    if (values.report) {
      const path = await saveEvidenceReport({
        schemaVersion: 1,
        startedAt,
        completedAt: new Date().toISOString(),
        role,
        thinking: false,
        fingerprints,
        cases,
        results,
        summary: { passed, mismatches, errors, total: results.length },
      });
      console.log(`Report saved: ${path}`);
    }
    if (passed !== results.length) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
