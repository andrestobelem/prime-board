#!/usr/bin/env bun
// Ejecuta comprobaciones de seguridad antes de editar o lanzar tests paralelos.
import { parseArgs } from "node:util";
import { runPreflight } from "./prime-board-preflight-lib.ts";

function usage(): never {
  console.log(`Usage: bun scripts/prime-board-preflight.ts [options]

Run a read-only preflight for a Git worktree and parallel test resources.

Options:
  --repo PATH       Repository or worktree to inspect (default: current directory)
  --root PATH       Alias for --repo
  --branch NAME     Expected current branch
  --unit ID         Work unit, for example PRB-543
  --port PORT       Preferred test/server port
  --db PATH         Temporary database path
  --home PATH       Home directory containing .prime-board state
  --hook PATH       Pre-commit hook to audit (default: <repo>/.husky/pre-commit)
  --dry-run         Explicitly select the read-only report mode
  --strict          Treat warnings as failures
  --json            Print a machine-readable report
  --help            Show this help
`);
  process.exit(0);
}

function printText(report: Awaited<ReturnType<typeof runPreflight>>, dryRun: boolean): void {
  console.log(`Preflight ${report.passed ? "PASS" : "FAIL"} (${dryRun ? "dry-run" : "report"})`);
  console.log(`Repository: ${report.repoRoot ?? report.repoPath}`);
  if (report.branch) console.log(`Branch: ${report.branch}`);
  if (report.databasePath) console.log(`Database: ${report.databasePath}`);
  if (report.port !== null) console.log(`Port: ${report.port}`);
  for (const item of report.checks) {
    console.log(`[${item.status.toUpperCase()}] ${item.id}: ${item.message}`);
    for (const detail of item.details ?? []) console.log(`  - ${detail}`);
  }
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    repo: { type: "string" },
    root: { type: "string" },
    branch: { type: "string" },
    unit: { type: "string" },
    port: { type: "string" },
    db: { type: "string" },
    home: { type: "string" },
    hook: { type: "string" },
    "dry-run": { type: "boolean" },
    strict: { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help) usage();

let port: number | undefined;
if (values.port !== undefined) {
  if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) {
    console.error(`Invalid port: ${values.port}`);
    process.exit(2);
  }
  port = Number(values.port);
}

try {
  const report = await runPreflight({
    repoPath: values.root ?? values.repo,
    expectedBranch: values.branch,
    unit: values.unit,
    port,
    databasePath: values.db,
    homeDirectory: values.home,
    hookPath: values.hook,
    strict: values.strict,
  });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else printText(report, values["dry-run"] === true);
  process.exit(report.passed ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
