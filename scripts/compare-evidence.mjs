import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

function indexReport(report) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.cases) || !Array.isArray(report.results)) {
    throw new Error("Expected an evidence report with schemaVersion 1, cases, and results");
  }
  const cases = new Map();
  for (const item of report.cases) {
    if (!item || typeof item.id !== "string" || !item.id || cases.has(item.id) ||
        typeof item.prompt !== "string" || typeof item.context !== "string" || !Array.isArray(item.tools) ||
        !["sufficient", "continue", "blocked"].includes(item.expected)) {
      throw new Error("Invalid or duplicate evidence case");
    }
    cases.set(item.id, item);
  }
  const results = new Map();
  for (const result of report.results) {
    const item = cases.get(result?.id);
    if (!item || results.has(result.id) || result.expected !== item.expected ||
        !["sufficient", "continue", "blocked", "invalid", "error", "timeout"].includes(result.actual) ||
        result.passed !== (result.actual === item.expected) ||
        !Number.isFinite(result.durationMs) || result.durationMs < 0) {
      throw new Error("Invalid, inconsistent, or duplicate evidence result");
    }
    results.set(result.id, result);
  }
  if (!cases.size || cases.size !== results.size) throw new Error("Report must contain a result for every case");
  return { cases, results };
}

export function compareEvidence(before, after) {
  const baseline = indexReport(before);
  const candidate = indexReport(after);
  const rows = [];
  for (const id of new Set([...baseline.cases.keys(), ...candidate.cases.keys()])) {
    const oldCase = baseline.cases.get(id);
    const newCase = candidate.cases.get(id);
    const oldResult = baseline.results.get(id);
    const newResult = candidate.results.get(id);
    let change;
    if (!oldCase) change = "added";
    else if (!newCase) change = "removed";
    else if (!isDeepStrictEqual(oldCase, newCase)) change = "case_changed";
    else if (oldResult.passed && !newResult.passed) change = "regressed";
    else if (!oldResult.passed && newResult.passed) change = "improved";
    else change = newResult.passed ? "still_passes" : "still_fails";
    const comparable = oldCase && newCase && isDeepStrictEqual(oldCase, newCase);
    const requestsCompleted = comparable && ![oldResult.actual, newResult.actual].some((action) => ["error", "timeout"].includes(action));
    rows.push({ id, change, before: oldResult?.actual ?? null, after: newResult?.actual ?? null,
      durationDeltaMs: requestsCompleted ? newResult.durationMs - oldResult.durationMs : null });
  }
  return rows;
}

async function main() {
  const [beforePath, afterPath, ...extra] = process.argv.slice(2);
  if (!beforePath || !afterPath || extra.length) throw new Error("Usage: npm run compare:evidence -- baseline.json candidate.json");
  const [before, after] = await Promise.all([beforePath, afterPath].map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const rows = compareEvidence(before, after);
  console.log(`Roles: ${before.role ?? "unknown"} -> ${after.role ?? "unknown"}`);
  const changedSources = [...new Set([...Object.keys(before.fingerprints ?? {}), ...Object.keys(after.fingerprints ?? {})])]
    .filter((path) => before.fingerprints?.[path] !== after.fingerprints?.[path]);
  console.log(`Changed source fingerprints: ${changedSources.join(", ") || "none"}`);
  if (before.thinking !== after.thinking) console.log("Thinking setting changed.");
  console.table(rows);
  const counts = Object.fromEntries(["improved", "regressed", "still_passes", "still_fails", "added", "removed", "case_changed"].map((change) => [change, rows.filter((row) => row.change === change).length]));
  console.log(JSON.stringify(counts));
  console.log("Changed, added, and removed cases are excluded from improvement counts. Negative timing deltas mean faster; individual timings may include model loading. Reports compare effective evaluator decisions, not raw model accuracy.");
  if (counts.regressed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 2; });
}
