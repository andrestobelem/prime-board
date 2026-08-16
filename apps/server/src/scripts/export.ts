#!/usr/bin/env bun
// Exporta la DB operativa al repo (AT-156). Uso:
//   bun run export [--out <dir>] [--team KEY]
// --team genera un export parcial cuyo alcance queda en meta/export.json.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { out: { type: "string" }, team: { type: "string" } },
});

/**
 * Default: la raíz del repo, no el cwd — los scripts de workspace corren con
 * `--cwd apps/server` y exportarían dentro del paquete.
 */
function repoRoot(): string {
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
  const path = git.stdout.toString().trim();
  return git.exitCode === 0 && path ? path : process.cwd();
}

const config = loadConfig();
const db = openDatabase(config.dbPath);
const outDir = values.out ?? repoRoot();
const result = exportBoard(db, outDir, { teamKey: values.team ?? null });

console.log(`Exported ${result.issues} issues and ${result.events} events`);
console.log(`${result.files} files written to ${outDir}/.prime-board/`);
