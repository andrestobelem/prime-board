#!/usr/bin/env bun
// Reemplaza el índice SQLite desde un export del repo (AT-157). Uso:
//   bun run rebuild [--from <dir>] [--allow-partial]
// Los exports team-scoped se rechazan salvo --allow-partial; nunca se fusionan.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { preflightRetiredDocuments, rebuildFromRepo } from "../export/importer.ts";

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
const sourceRoot = values.from ?? repoRoot();
const documentsArchivePath =
  values["documents-archive"] ?? process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
// Inspect and archive the source before opening the operational DB. This keeps
// an old documents.json from reaching a destructive rebuild by accident.
preflightRetiredDocuments(sourceRoot, documentsArchivePath);
const db = openDatabase(config.dbPath, { documentsArchivePath });
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
