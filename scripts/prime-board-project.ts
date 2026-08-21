#!/usr/bin/env bun
// Inicia una instancia aislada de prime-board para otro repositorio.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  acquireInstanceLock,
  chooseAvailablePort,
  classifyInstance,
  deriveProjectIdentity,
  retireInstanceLock,
  type InstanceRecord,
  type InstanceStatus,
  type ProjectInstanceIdentity,
} from "./prime-board-project-lib.ts";

const PRIME_BOARD_ROOT = resolve(import.meta.dir, "..");

function usage(): never {
  console.log(`Usage: bun scripts/prime-board-project.ts [options]

Start an isolated prime-board instance for a project repository.

Options:
  --project PATH  Project repository (default: current directory)
  --port PORT     HTTP port (default: 3333; moves to the next free port when implicit)
  --db PATH       SQLite database path (default: ~/.prime-board/projects/<project>.db)
  --status        Show the instance state without starting a server
  --print-env     Print shell exports without starting the server
  --help          Show this help
`);
  process.exit(0);
}

function parsePort(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error(`Invalid port: ${raw ?? ""}`);
  }
  return Number(raw);
}

function gitProjectRoot(projectPath: string): string {
  const projectCheck = Bun.spawnSync(["git", "-C", projectPath, "rev-parse", "--show-toplevel"]);
  if (projectCheck.exitCode !== 0) {
    throw new Error(`Project is not a Git repository: ${projectPath}`);
  }
  return realpathSync(projectCheck.stdout.toString().trim());
}

function inheritedProjectMatches(projectRoot: string): boolean {
  const inheritedRoot = process.env.PRIME_BOARD_REPO;
  if (!inheritedRoot) return false;
  try {
    return realpathSync(inheritedRoot) === projectRoot;
  } catch {
    return false;
  }
}

function describeStatus(identity: ProjectInstanceIdentity, status: InstanceStatus): void {
  const record = status.record;
  const details = record
    ? ` port=${record.port} pid=${record.pid} db=${record.databasePath}`
    : ` db=${identity.databasePath}`;
  console.log(`${status.state} project=${identity.projectRoot}${details}`);
}

function statusExitCode(status: InstanceStatus): number {
  if (status.state === "running") return 0;
  if (status.state === "not-running") return 1;
  return 2;
}

function assertDatabaseCompatibility(
  identity: ProjectInstanceIdentity,
  status: InstanceStatus,
): void {
  if (
    status.record &&
    status.record.projectRoot === identity.projectRoot &&
    status.record.databasePath !== identity.databasePath
  ) {
    throw new Error(
      `Project instance already uses database ${status.record.databasePath}; ` +
        `refusing to start with ${identity.databasePath}`,
    );
  }
}

function printEnvironment(
  identity: ProjectInstanceIdentity,
  projectRoot: string,
  port: number,
): void {
  const url = `http://127.0.0.1:${port}`;
  console.log(`export PRIME_BOARD_ROOT=${shellQuote(PRIME_BOARD_ROOT)}`);
  console.log(`export PRIME_BOARD_REPO=${shellQuote(projectRoot)}`);
  console.log(`export PRIME_BOARD_DB=${shellQuote(identity.databasePath)}`);
  console.log(`export PRIME_BOARD_PORT=${shellQuote(String(port))}`);
  console.log(`export PRIME_BOARD_URL=${shellQuote(url)}`);
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    project: { type: "string" },
    port: { type: "string" },
    db: { type: "string" },
    status: { type: "boolean" },
    "print-env": { type: "boolean" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help) usage();

const projectPath = resolve(values.project ?? process.cwd());
const projectRoot = gitProjectRoot(projectPath);
const inheritedConfigMatches = inheritedProjectMatches(projectRoot);
const databaseOverride =
  values.db ?? (inheritedConfigMatches ? process.env.PRIME_BOARD_DB : undefined);
const identity = deriveProjectIdentity(projectRoot, homedir(), databaseOverride);
const inheritedPort = inheritedConfigMatches ? process.env.PRIME_BOARD_PORT : undefined;
const requestedPort = parsePort(values.port ?? inheritedPort ?? "3333");
const portIsExplicit = values.port !== undefined || inheritedPort !== undefined;
const status = classifyInstance(identity);
assertDatabaseCompatibility(identity, status);

if (values.status) {
  describeStatus(identity, status);
  process.exit(statusExitCode(status));
}

if (values["print-env"]) {
  if (status.state === "running" && status.record) {
    printEnvironment(identity, projectRoot, status.record.port);
    process.exit(0);
  }
  if (status.state === "stale") {
    describeStatus(identity, status);
    process.exit(statusExitCode(status));
  }
  const port = await chooseAvailablePort(requestedPort, portIsExplicit);
  printEnvironment(identity, projectRoot, port);
  process.exit(0);
}

if (status.state === "running" && status.record) {
  console.error(
    `prime-board already running for ${projectRoot} at http://127.0.0.1:${status.record.port}`,
  );
  process.exit(0);
}
if (status.state === "stale") retireInstanceLock(identity);

const port = await chooseAvailablePort(requestedPort, portIsExplicit);
const instanceRecord: InstanceRecord = {
  version: 1,
  projectRoot,
  databasePath: identity.databasePath,
  port,
  pid: process.pid,
  startedAt: new Date().toISOString(),
};
let releaseLock: (() => void) | null = null;
try {
  releaseLock = acquireInstanceLock(identity, instanceRecord);
} catch (error) {
  const concurrent = classifyInstance(identity);
  if (concurrent.state === "running" && concurrent.record) {
    console.error(
      `prime-board already running for ${projectRoot} at http://127.0.0.1:${concurrent.record.port}`,
    );
    process.exit(0);
  }
  throw error;
}

console.error(`prime-board project: ${projectRoot}`);
console.error(`prime-board replica: ${resolve(projectRoot, ".prime-board")}`);
console.error(`prime-board database: ${identity.databasePath}`);
console.error(`prime-board URL: http://127.0.0.1:${port}`);
if (process.env.PRIME_BOARD_AUTH_MODE === "local") {
  console.error("Local auth mode is active; no API key is required.");
} else {
  console.error("Save the admin API key printed by the first server start.");
}

const environment = {
  ...process.env,
  PRIME_BOARD_REPO: projectRoot,
  PRIME_BOARD_DB: identity.databasePath,
  PRIME_BOARD_PORT: String(port),
  PRIME_BOARD_HOST: "127.0.0.1",
  PRIME_BOARD_PERSISTENCE: "sqlite",
};
let server: ReturnType<typeof Bun.spawn> | null = null;
const forwardSignal = (signal: "SIGINT" | "SIGTERM") => server?.kill(signal);
const onSigint = () => forwardSignal("SIGINT");
const onSigterm = () => forwardSignal("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

let exitCode = 1;
try {
  server = Bun.spawn([process.execPath, "run", "--cwd", "apps/server", "start"], {
    cwd: PRIME_BOARD_ROOT,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await server.exited;
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  releaseLock?.();
}
process.exit(exitCode);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
