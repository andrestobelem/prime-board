#!/usr/bin/env bun
// Inicia una instancia aislada de prime-board para otro repositorio.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const PRIME_BOARD_ROOT = resolve(import.meta.dir, "..");

function usage(): never {
  console.log(`Usage: bun scripts/prime-board-project.ts [options]

Start an isolated prime-board instance for a project repository.

Options:
  --project PATH  Project repository (default: current directory)
  --port PORT     HTTP port (default: 3333)
  --db PATH       SQLite database path (default: ~/.prime-board/projects/<project>.db)
  --print-env     Print shell exports without starting the server
  --help          Show this help
`);
  process.exit(0);
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    project: { type: "string" },
    port: { type: "string" },
    db: { type: "string" },
    "print-env": { type: "boolean" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help) usage();

const projectPath = resolve(values.project ?? process.cwd());
const projectCheck = Bun.spawnSync(["git", "-C", projectPath, "rev-parse", "--show-toplevel"]);
if (projectCheck.exitCode !== 0) {
  throw new Error(`Project is not a Git repository: ${projectPath}`);
}
const projectRoot = projectCheck.stdout.toString().trim();
const port = values.port ?? process.env.PRIME_BOARD_PORT ?? "3333";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error(`Invalid port: ${port}`);
}
const projectSlug =
  basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") || "project";
const projectHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 8);
const databasePath = resolve(
  values.db ??
    process.env.PRIME_BOARD_DB ??
    join(homedir(), ".prime-board", "projects", `${projectSlug}-${projectHash}.db`),
);
const url = `http://localhost:${port}`;
const environment = {
  ...process.env,
  PRIME_BOARD_REPO: projectRoot,
  PRIME_BOARD_DB: databasePath,
  PRIME_BOARD_PORT: port,
};

if (values["print-env"]) {
  console.log(`export PRIME_BOARD_ROOT=${shellQuote(PRIME_BOARD_ROOT)}`);
  console.log(`export PRIME_BOARD_REPO=${shellQuote(projectRoot)}`);
  console.log(`export PRIME_BOARD_DB=${shellQuote(databasePath)}`);
  console.log(`export PRIME_BOARD_PORT=${shellQuote(port)}`);
  console.log(`export PRIME_BOARD_URL=${shellQuote(url)}`);
  process.exit(0);
}

console.error(`prime-board project: ${projectRoot}`);
console.error(`prime-board replica: ${join(projectRoot, ".prime-board")}`);
console.error(`prime-board database: ${databasePath}`);
console.error(`prime-board URL: ${url}`);
console.error("Save the admin API key printed by the first server start.");

const server = Bun.spawn([process.execPath, "run", "--cwd", "apps/server", "start"], {
  cwd: PRIME_BOARD_ROOT,
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await server.exited);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
