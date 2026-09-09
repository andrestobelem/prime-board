#!/usr/bin/env bun
// Importa una captura JSON de Linear al formato versionado de prime-board.
// Uso: bun run import:linear --from export.json --out /ruta/repo --dry-run
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import {
  parseLinearExport,
  validateLinearExportUuidIds,
  writeLinearExportToRepo,
} from "../export/linear-repo-export.ts";
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

function assertFreshOutput(outputRoot: string): void {
  if (existsSync(outputRoot) && !statSync(outputRoot).isDirectory())
    throw new Error(`Output must be a directory: ${outputRoot}`);
  if (existsSync(join(outputRoot, ".prime-board")))
    throw new Error(`Output already contains .prime-board: ${outputRoot}`);
}

/** Crea el staging junto al destino para que la publicación use el mismo filesystem. */
function createApplyStagingRoot(outputRoot: string): string {
  assertFreshOutput(outputRoot);
  const absoluteOutputRoot = resolve(outputRoot);
  const parent = dirname(absoluteOutputRoot);
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `.${basename(absoluteOutputRoot)}-linear-apply-`));
}

/** Publica solo un staging que ya pasó el rebuild y mantiene el destino sin mezclar. */
function publishApplyStaging(stagingRoot: string, outputRoot: string): void {
  assertFreshOutput(outputRoot);
  mkdirSync(outputRoot, { recursive: true });
  renameSync(join(stagingRoot, ".prime-board"), join(outputRoot, ".prime-board"));
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
const identityFindings = validateLinearExportUuidIds(source);
if (identityFindings.length > 0) {
  if (values.json)
    console.error(
      JSON.stringify({ error: "NON_UUID_SOURCE_IDS", findings: identityFindings }, null, 2),
    );
  else {
    console.error(`Linear export has ${identityFindings.length} non-UUID source id(s)`);
    for (const finding of identityFindings) console.error(`${finding.code}: ${finding.message}`);
  }
  process.exit(2);
}
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
    console.log(`${reconciliation.countMismatches.length} entity count mismatches`);
    for (const mismatch of reconciliation.countMismatches) console.log(`MISMATCH ${mismatch}`);
    console.log(`${reconciliation.contentMismatches.length} content mismatches`);
    for (const mismatch of reconciliation.contentMismatches) console.log(`CONTENT ${mismatch}`);
    for (const finding of reconciliation.conflicts)
      console.log(`CONFLICT ${finding.code}: ${finding.message}`);
  }
  if (!reconciliation.reconciled) process.exit(1);
  process.exit(0);
}
function runMergeImport(source: ReturnType<typeof parseLinearExport>, outputRoot: string): void {
  const applyStagingRoot = values.apply ? createApplyStagingRoot(outputRoot) : undefined;

  try {
    // Con --apply el merge se publica en un staging vecino. El destino queda
    // intacto hasta que SQLite termine de reconstruirse correctamente.
    const mergeOutputRoot = applyStagingRoot ?? outputRoot;
    const merged = mergeLinearExportWithRepo(source, values["merge-local"]!, mergeOutputRoot, {
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
    }
    const blocked =
      merged.conflicts.length > 0 || (merged.source.losses.length > 0 && !values["allow-losses"]);
    // El merge ya calculó todos sus conflictos y solo publicó un snapshot limpio.
    // Nunca abras el camino destructivo de rebuild mientras el plan esté bloqueado.
    if (blocked) {
      if (!values.json) console.log("Output not written because the merge has blocking findings");
      process.exitCode = 1;
      return;
    }
    if (values.apply) {
      const config = loadConfig();
      const db = openDatabase(config.dbPath);
      const rebuilt = rebuildFromRepo(db, mergeOutputRoot);
      // El destino se publica únicamente después del rebuild. Si el rebuild
      // falla, el finally elimina el staging y permite repetir la operación.
      publishApplyStaging(applyStagingRoot!, outputRoot);
      if (!values.json) console.log(`Output: ${outputRoot}/.prime-board/`);
      console.log(
        `Rebuilt ${rebuilt.issues} issues, ${rebuilt.comments} comments and ${rebuilt.events} events`,
      );
    } else if (!values.json) console.log(`Output: ${outputRoot}/.prime-board/`);
    process.exitCode = 0;
  } finally {
    if (applyStagingRoot) rmSync(applyStagingRoot, { recursive: true, force: true });
  }
}

if (values["merge-local"]) {
  if (!values.out) throw new Error("--merge-local requires --out as a fresh output directory");
  runMergeImport(source, values.out);
} else {
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
}
