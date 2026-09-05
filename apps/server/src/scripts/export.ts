#!/usr/bin/env bun
// Exporta la DB operativa al repo (AT-156). Uso:
//   bun run export [--out <dir>] [--team KEY]
// --team genera un export parcial cuyo alcance queda en meta/export.json.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";
import { exportPostgresBoard } from "../export/postgres-export.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string" },
    team: { type: "string" },
    "documents-archive": { type: "string" },
  },
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
const outDir = values.out ?? repoRoot();
const options = {
  teamKey: values.team ?? null,
  documentsArchivePath: values["documents-archive"] ?? process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE,
};
if (config.persistenceBackend === "postgres") {
  if (!config.postgresUrl)
    throw new Error("PRIME_BOARD_POSTGRES_URL is required for PostgreSQL export");
  const sql = new Bun.SQL({ url: config.postgresUrl });
  const persistence = createPostgresPersistence(sql);
  try {
    const result = await exportPostgresBoard(persistence, outDir, options);
    console.log(`Exported ${result.issues} issues and ${result.events} events`);
    console.log(`${result.files} files written to ${outDir}/.prime-board/`);
  } finally {
    await persistence.close();
  }
} else {
  const db = openDatabase(config.dbPath, {
    documentsArchivePath: options.documentsArchivePath,
  });
  try {
    const result = exportBoard(db, outDir, options);
    console.log(`Exported ${result.issues} issues and ${result.events} events`);
    console.log(`${result.files} files written to ${outDir}/.prime-board/`);
  } finally {
    db.close();
  }
}
