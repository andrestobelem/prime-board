#!/usr/bin/env bun
// Importa una captura JSON de Linear al formato versionado de prime-board.
// Uso: bun run import:linear --from export.json --out /ruta/repo --dry-run
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import { parseLinearExport, writeLinearExportToRepo } from "../export/linear-repo-export.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    from: { type: "string" },
    out: { type: "string" },
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
  "Usage: bun run import:linear --from <export.json> [--out <repo>] [--dry-run] [--apply] [--allow-losses] [--json]";
if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (!values.from) throw new Error(usage);
if (values.apply && !values.out)
  throw new Error("--apply requires --out so the target repo is explicit");

const source = parseLinearExport(JSON.parse(readFileSync(values.from, "utf8")));
const outDir = values.out ?? repoRoot();
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
