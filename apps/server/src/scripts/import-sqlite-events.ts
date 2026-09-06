#!/usr/bin/env bun
// Importa una copia consistente de SQLite al Log canónico.
// Uso: bun run import:sqlite-events --from <db.sqlite> --out <repo> [--dry-run]
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { importSqliteHistory } from "../export/sqlite-history-import.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    from: { type: "string" },
    db: { type: "string" },
    out: { type: "string" },
    "workspace-id": { type: "string" },
    "batch-size": { type: "string" },
    "dry-run": { type: "boolean" },
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
  "Usage: bun run import:sqlite-events --from <db.sqlite> [--out <repo>] [--workspace-id ID] [--batch-size N] [--dry-run] [--json]";
if (values.help) {
  console.log(usage);
  process.exit(0);
}
const sourcePath = values.from ?? values.db;
if (!sourcePath) throw new Error(usage);
let batchSize: number | undefined;
if (values["batch-size"] !== undefined) {
  batchSize = Number(values["batch-size"]);
  if (!Number.isInteger(batchSize)) throw new Error("--batch-size must be an integer");
}

const source = new Database(sourcePath, { readonly: true, strict: true });
try {
  const result = importSqliteHistory({
    db: source,
    rootDir: values.out ?? repoRoot(),
    workspaceId: values["workspace-id"],
    batchSize,
    dryRun: values["dry-run"] ?? false,
  });
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const mode = result.dryRun ? "Dry-run" : "Imported";
    console.log(
      `${mode} ${result.emitted} events from ${result.scanned} SQLite rows (${result.written} written, ${result.duplicates} duplicates)`,
    );
    console.log(
      `${result.orphaned} orphaned, ${result.outOfScope} out-of-scope, ${result.ambiguous} ambiguous, ${result.rejected} rejected, ${result.excluded} excluded`,
    );
    if (result.warnings.length > 0) {
      for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
    }
  }
} finally {
  source.close();
}
