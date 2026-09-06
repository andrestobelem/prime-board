#!/usr/bin/env bun
// Archiva Documents existentes antes de instalar el retiro de la funcionalidad.
// Uso:
//   bun run --cwd apps/server archive:documents --out /ruta/externa/documents.json
//   bun run --cwd apps/server archive:documents --from-repo /ruta/repo --out /ruta/externa/documents.json
// El destino no debe estar dentro del repositorio ni de `.prime-board`.
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { archiveDocumentRows, archiveDocumentSnapshot } from "../export/documents-archive.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string" },
    "from-repo": { type: "string" },
    help: { type: "boolean" },
  },
});

const usage =
  "Usage: bun run --cwd apps/server archive:documents --out <external-file> [--from-repo <repo>]";

function repositoryRoot(): string {
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
  const path = git.stdout.toString().trim();
  return git.exitCode === 0 && path ? path : process.cwd();
}

if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (!values.out) throw new Error(usage);

if (values["from-repo"]) {
  const sourceRoot = values["from-repo"];
  const snapshot = join(sourceRoot, ".prime-board", "meta", "documents.json");
  if (!existsSync(snapshot)) throw new Error(`Documents snapshot not found: ${snapshot}`);
  const result = archiveDocumentSnapshot(snapshot, values.out, "replica", sourceRoot);
  console.log(
    `Archived ${result.sourceCount} retired Documents from the replica to ${result.path}`,
  );
  console.log(`Manifest: count=${result.count} sha256=${result.sha256}`);
  process.exit(0);
}

const config = loadConfig();
const currentRepositoryRoot = repositoryRoot();
if (config.persistenceBackend === "postgres") {
  if (!config.postgresUrl) {
    throw new Error("PRIME_BOARD_POSTGRES_URL is required when PRIME_BOARD_PERSISTENCE=postgres");
  }
  const sql = new Bun.SQL({ url: config.postgresUrl });
  try {
    const table = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'documents'
      ) AS exists
    `;
    if (!table[0]?.exists) {
      throw new Error(
        "Active Documents table was not found; archive the database before running its retirement migration",
      );
    }
    const rows = await sql.unsafe<Record<string, unknown>[]>("SELECT * FROM documents ORDER BY id");
    const result = archiveDocumentRows(rows, values.out, "postgres", currentRepositoryRoot);
    console.log(
      `Archived ${result.sourceCount} retired Documents from PostgreSQL to ${result.path}`,
    );
    console.log(`Manifest: count=${result.count} sha256=${result.sha256}`);
  } finally {
    await sql.close({ timeout: 5 });
  }
  process.exit(0);
}

const db = new Database(config.dbPath, { create: false, strict: true });
try {
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents' LIMIT 1")
    .get() as { name?: string } | null;
  if (!table) {
    throw new Error(
      "Active Documents table was not found; archive the database before running its retirement migration",
    );
  }
  const rows = db.query("SELECT * FROM documents ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
  const result = archiveDocumentRows(rows, values.out, "sqlite", currentRepositoryRoot);
  console.log(`Archived ${result.sourceCount} retired Documents from SQLite to ${result.path}`);
  console.log(`Manifest: count=${result.count} sha256=${result.sha256}`);
} finally {
  db.close();
}
