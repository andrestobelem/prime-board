#!/usr/bin/env bun
// Reemplaza el índice SQLite desde un export del repo (AT-157). Uso:
//   bun run rebuild [--from <dir>] [--allow-partial]
// Los exports team-scoped se rechazan salvo --allow-partial; nunca se fusionan.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { rebuildFromRepo } from "../export/importer.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    from: { type: "string" },
    "allow-partial": { type: "boolean" },
    "documents-archive": { type: "string" },
  },
});

function repoRoot(): string {
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
  const path = git.stdout.toString().trim();
  return git.exitCode === 0 && path ? path : process.cwd();
}

const config = loadConfig();
const sourceRoot = values.from ?? config.repoRoot ?? repoRoot();
const documentsArchivePath =
  values["documents-archive"] ?? process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
// `rebuildFromRepo` archiva la fuente antes del trabajo destructivo y la
// elimina solo después de que el rebuild termina correctamente.
const db = openDatabase(config.dbPath, {
  documentsArchivePath,
  repositoryRoot: config.repoRoot ?? undefined,
});
const result = rebuildFromRepo(db, sourceRoot, {
  allowPartial: values["allow-partial"] ?? false,
  documentsArchivePath,
});

console.log(
  `Rebuilt ${result.issues} issues, ${result.comments} comments and ${result.events} events`,
);
console.log(`${result.preservedKeys} API keys re-linked (credentials never live in the repo)`);
for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
console.log(`database: ${config.dbPath}`);
