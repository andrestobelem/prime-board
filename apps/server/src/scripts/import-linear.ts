#!/usr/bin/env bun
// Importa una captura JSON de Linear al formato versionado de prime-board.
// Uso: bun run import:linear --from export.json --out /ruta/repo --dry-run
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import { parseLinearExport, writeLinearExportToRepo } from "../export/linear-repo-export.ts";
import { reconcileLinearExport } from "../export/linear-reconcile.ts";
import { mergeLinearExportWithRepo } from "../export/linear-merge.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    from: { type: "string" },
    out: { type: "string" },
    "merge-local": { type: "string" },
    check: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    "allow-losses": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
});

function repoRoot(): string {
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
  const path = git.stdout.toString().trim();
  return git.exitCode === 0 && path ? path : process.cwd();
}

const usage =
  "Usage: bun run import:linear --from <export.json> [--out <repo>] [--check <repo>] [--merge-local <repo>] [--dry-run] [--apply] [--allow-losses] [--json]";
if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (!values.from) throw new Error(usage);
if (values.apply && !values.out)
  throw new Error("--apply requires --out so the target repo is explicit");

const source = parseLinearExport(JSON.parse(readFileSync(values.from, "utf8")));
if (values.check) {
  const reconciliation = reconcileLinearExport(source, values.check);
  if (values.json) console.log(JSON.stringify(reconciliation, null, 2));
  else {
    console.log(
      `${reconciliation.sourceIssues} source issues, ${reconciliation.targetIssues} target issues`,
    );
    console.log(
      `${reconciliation.pendingCreates.length} pending creates, ${reconciliation.pendingUpdates.length} pending updates`,
    );
    console.log(
      `${reconciliation.conflicts.length} conflicts, ${reconciliation.extraTargetIssues.length} extra target issues`,
    );
    for (const finding of reconciliation.conflicts)
      console.log(`CONFLICT ${finding.code}: ${finding.message}`);
  }
  if (!reconciliation.reconciled) process.exit(1);
  process.exit(0);
}
const outDir = values.out ?? repoRoot();
if (values["merge-local"]) {
  if (!values.out) throw new Error("--merge-local requires --out as a fresh output directory");
  const merged = mergeLinearExportWithRepo(source, values["merge-local"], values.out, {
    allowLosses: values["allow-losses"] ?? false,
  });
  const report = {
    issues: merged.source.issues,
    comments: merged.source.comments,
    events: merged.source.events,
    rekeyed: merged.rekeyed,
    matched: merged.matched,
    skipped: merged.skipped,
    conflicts: merged.conflicts,
    sourceConflicts: merged.source.conflicts,
    losses: merged.source.losses,
    warnings: merged.source.warnings,
  };
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `${merged.source.issues} Linear issues merged; ${Object.keys(merged.rekeyed).length} local issues rekeyed to ${"PRB"}`,
    );
    for (const finding of merged.conflicts)
      console.log(`CONFLICT ${finding.code}: ${finding.message}`);
    console.log(`Output: ${values.out}/.prime-board/`);
  }
  if (values.apply) {
    const config = loadConfig();
    const db = openDatabase(config.dbPath);
    const rebuilt = rebuildFromRepo(db, values.out);
    console.log(
      `Rebuilt ${rebuilt.issues} issues, ${rebuilt.comments} comments and ${rebuilt.events} events`,
    );
  }
  if (merged.conflicts.length > 0 || (merged.source.losses.length > 0 && !values["allow-losses"]))
    process.exit(1);
  process.exit(0);
}
const result = writeLinearExportToRepo(source, outDir, {
  dryRun: values["dry-run"] ?? false,
  allowLosses: values["allow-losses"] ?? false,
});
const report = {
  issues: result.issues,
  comments: result.comments,
  events: result.events,
  files: result.files,
  conflicts: result.conflicts,
  losses: result.losses,
  warnings: result.warnings,
};
if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${result.issues} issues, ${result.comments} comments, ${result.events} events`);
  console.log(
    `${result.conflicts.length} conflicts, ${result.losses.length} losses, ${result.warnings.length} warnings`,
  );
  if (result.conflicts.length)
    for (const finding of result.conflicts)
      console.log(`CONFLICT ${finding.code}: ${finding.message}`);
  if (result.losses.length)
    for (const finding of result.losses) console.log(`LOSS ${finding.code}: ${finding.message}`);
  if (!values["dry-run"]) console.log(`${result.files} files written to ${outDir}/.prime-board/`);
}
if (values.apply) {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const rebuilt = rebuildFromRepo(db, outDir);
  console.log(
    `Rebuilt ${rebuilt.issues} issues, ${rebuilt.comments} comments and ${rebuilt.events} events`,
  );
  console.log(`database: ${config.dbPath}`);
}
if (result.conflicts.length > 0 || (result.losses.length > 0 && !values["allow-losses"]))
  process.exit(1);
