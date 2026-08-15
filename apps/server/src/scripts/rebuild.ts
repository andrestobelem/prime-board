#!/usr/bin/env bun
// Reconstruye la DB desde el repo (AT-157). Uso:
//   bun run rebuild [--from <dir>]
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { rebuildFromRepo } from "../export/importer.ts";

const { values } = parseArgs({ args: process.argv.slice(2), options: { from: { type: "string" } } });

function repoRoot(): string {
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
  const path = git.stdout.toString().trim();
  return git.exitCode === 0 && path ? path : process.cwd();
}

const config = loadConfig();
const db = openDatabase(config.dbPath);
const result = rebuildFromRepo(db, values.from ?? repoRoot());

console.log(`Rebuilt ${result.issues} issues, ${result.comments} comments and ${result.events} events`);
console.log(`${result.preservedKeys} API keys re-linked (credentials never live in the repo)`);
console.log(`database: ${config.dbPath}`);
