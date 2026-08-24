#!/usr/bin/env bun
// Inicia una instancia aislada de prime-board para otro repositorio.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  resolveBootstrapIdentity,
  type BootstrapIdentity,
} from "../apps/server/src/db/bootstrap-config.ts";
import { assertNonBareGitWorktree } from "../packages/prime-board-runtime/src/project.ts";
import {
  acquireDatabaseReservation,
  acquireInstanceLock,
  chooseAvailablePort,
  databaseReservationPaths,
  deriveProjectIdentity,
  promoteDatabaseReservationOwner,
  promoteInstanceOwner,
  reserveAvailablePort,
  resolveInstanceStatus,
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
  --host HOST     HTTP bind host (default: 127.0.0.1; local auth forces loopback)
  --db PATH       SQLite database path (default: ~/.prime-board/projects/<project>.db)
  --web-dist PATH Static UI directory (default: apps/web/dist)
  --workspace-name NAME       Initial Workspace display name
  --workspace-url-key KEY     Initial Workspace URL key (lowercase slug)
  --team-name NAME            Initial Team display name
  --team-key KEY              Initial Team key (1-8 alphanumeric characters)
  --status        Show the instance state without starting a server
  --print-env     Print shell exports without starting the server
  --help          Show this help
`);
  process.exit(0);
}

function parseHost(raw: string | undefined): string {
  const host = raw ?? "127.0.0.1";
  if (!host || /\s/.test(host) || host.includes("/")) {
    throw new Error(`Invalid host: ${host}`);
  }
  return host;
}

function parsePort(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error(`Invalid port: ${raw ?? ""}`);
  }
  return Number(raw);
}

function gitProjectRoot(projectPath: string): string {
  return assertNonBareGitWorktree(projectPath);
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
    ? ` host=${record.host ?? "127.0.0.1"} port=${record.port} pid=${record.pid} db=${record.databasePath}`
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
  host: string,
  port: number,
  bootstrap: BootstrapIdentity,
  webDist?: string,
): void {
  const url = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
  console.log(`export PRIME_BOARD_ROOT=${shellQuote(PRIME_BOARD_ROOT)}`);
  console.log(`export PRIME_BOARD_REPO=${shellQuote(projectRoot)}`);
  console.log(`export PRIME_BOARD_DB=${shellQuote(identity.databasePath)}`);
  console.log(`export PRIME_BOARD_PORT=${shellQuote(String(port))}`);
  console.log(`export PRIME_BOARD_HOST=${shellQuote(host)}`);
  console.log(`export PRIME_BOARD_URL=${shellQuote(url)}`);
  if (webDist) console.log(`export PRIME_BOARD_WEB_DIST=${shellQuote(webDist)}`);
  console.log(`export PRIME_BOARD_WORKSPACE_NAME=${shellQuote(bootstrap.workspaceName)}`);
  console.log(`export PRIME_BOARD_WORKSPACE_URL_KEY=${shellQuote(bootstrap.workspaceUrlKey)}`);
  console.log(`export PRIME_BOARD_TEAM_NAME=${shellQuote(bootstrap.teamName)}`);
  console.log(`export PRIME_BOARD_TEAM_KEY=${shellQuote(bootstrap.teamKey)}`);
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    project: { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    db: { type: "string" },
    "web-dist": { type: "string" },
    "workspace-name": { type: "string" },
    "workspace-url-key": { type: "string" },
    "team-name": { type: "string" },
    "team-key": { type: "string" },
    status: { type: "boolean" },
    "print-env": { type: "boolean" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help) usage();

const bootstrap = resolveBootstrapIdentity({
  workspaceName: values["workspace-name"] ?? process.env.PRIME_BOARD_WORKSPACE_NAME,
  workspaceUrlKey: values["workspace-url-key"] ?? process.env.PRIME_BOARD_WORKSPACE_URL_KEY,
  teamName: values["team-name"] ?? process.env.PRIME_BOARD_TEAM_NAME,
  teamKey: values["team-key"] ?? process.env.PRIME_BOARD_TEAM_KEY,
});
const projectPath = resolve(values.project ?? process.cwd());
const projectRoot = gitProjectRoot(projectPath);
const inheritedConfigMatches = inheritedProjectMatches(projectRoot);
const databaseOverride =
  values.db ?? (inheritedConfigMatches ? process.env.PRIME_BOARD_DB : undefined);
const identity = deriveProjectIdentity(projectRoot, homedir(), databaseOverride);
const inheritedPort = inheritedConfigMatches ? process.env.PRIME_BOARD_PORT : undefined;
const host = parseHost(
  values.host ?? (inheritedConfigMatches ? process.env.PRIME_BOARD_HOST : undefined),
);
const webDist =
  values["web-dist"] ?? (inheritedConfigMatches ? process.env.PRIME_BOARD_WEB_DIST : undefined);
const requestedPort = parsePort(values.port ?? inheritedPort ?? "3333");
const portIsExplicit = values.port !== undefined || inheritedPort !== undefined;
const status = await resolveInstanceStatus(identity);
assertDatabaseCompatibility(identity, status);

if (values.status) {
  describeStatus(identity, status);
  process.exit(statusExitCode(status));
}

if (values["print-env"]) {
  if (status.state === "running" && status.record) {
    printEnvironment(identity, projectRoot, host, status.record.port, bootstrap, webDist);
    process.exit(0);
  }
  if (status.state === "stale") {
    describeStatus(identity, status);
    process.exit(statusExitCode(status));
  }
  const port = await chooseAvailablePort(requestedPort, portIsExplicit);
  printEnvironment(identity, projectRoot, host, port, bootstrap, webDist);
  process.exit(0);
}

if (status.state === "running" && status.record) {
  console.error(
    `prime-board already running for ${projectRoot} at http://${hostForUrl(status.record.host ?? host)}:${status.record.port}`,
  );
  process.exit(0);
}
if (status.state === "stale") retireInstanceLock(identity);

let server: ReturnType<typeof Bun.spawn> | null = null;
let receivedSignal: "SIGINT" | "SIGTERM" | null = null;
const onSignal = (signal: "SIGINT" | "SIGTERM") => {
  if (server) {
    server.kill(signal);
  } else {
    receivedSignal = signal;
  }
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

const portReservation = await reserveAvailablePort(requestedPort, portIsExplicit, homedir());
const port = portReservation.port;
const instanceId = randomUUID();
const instanceRecord: InstanceRecord = {
  version: 1,
  projectRoot,
  databasePath: identity.databasePath,
  port,
  pid: process.pid,
  launcherPid: process.pid,
  instanceId,
  host,
  startedAt: new Date().toISOString(),
};
let releaseDatabaseReservation: (() => void) | null = null;
let releaseLock: (() => void) | null = null;
try {
  releaseDatabaseReservation = acquireDatabaseReservation(identity, {
    version: 1,
    projectRoot,
    databasePath: identity.databasePath,
    pid: process.pid,
    launcherPid: process.pid,
    instanceId,
    reservedAt: instanceRecord.startedAt,
  });
  releaseLock = acquireInstanceLock(identity, instanceRecord);
} catch (error) {
  releaseDatabaseReservation?.();
  portReservation.release();
  const concurrent = await resolveInstanceStatus(identity);
  if (concurrent.state === "running" && concurrent.record) {
    console.error(
      `prime-board already running for ${projectRoot} at http://127.0.0.1:${concurrent.record.port}`,
    );
    process.exit(0);
  }
  throw error;
}

if (receivedSignal) {
  releaseLock?.();
  releaseDatabaseReservation?.();
  portReservation.release();
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  process.exit(receivedSignal === "SIGINT" ? 130 : 143);
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
  PRIME_BOARD_HOST: host,
  PRIME_BOARD_PERSISTENCE: "sqlite",
  ...(webDist ? { PRIME_BOARD_WEB_DIST: webDist } : {}),
  PRIME_BOARD_WORKSPACE_NAME: bootstrap.workspaceName,
  PRIME_BOARD_WORKSPACE_URL_KEY: bootstrap.workspaceUrlKey,
  PRIME_BOARD_TEAM_NAME: bootstrap.teamName,
  PRIME_BOARD_TEAM_KEY: bootstrap.teamKey,
  PRIME_BOARD_INSTANCE_ID: instanceId,
  PRIME_BOARD_INSTANCE_METADATA: identity.metadataPath,
  PRIME_BOARD_LAUNCHER_PID: String(process.pid),
  PRIME_BOARD_DATABASE_RESERVATION_METADATA: JSON.stringify(
    databaseReservationPaths(identity.databasePath, homedir()).map((path) =>
      join(path, "reservation.json"),
    ),
  ),
};
let exitCode = 1;
try {
  server = Bun.spawn([process.execPath, "run", "--cwd", "apps/server", "start"], {
    cwd: PRIME_BOARD_ROOT,
    env: environment,
    detached: true,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (server.pid === undefined) throw new Error("prime-board server did not expose a PID");
  const owner = { pid: server.pid, processGroupId: server.pid };
  promoteDatabaseReservationOwner(identity, owner, instanceId);
  promoteInstanceOwner(identity, owner, instanceId);
  await waitForHealth(host, port, server);
  console.error(`prime-board ready: http://${hostForUrl(host)}:${port}`);
  exitCode = await server.exited;
} catch (error) {
  if (server) {
    server.kill("SIGTERM");
    await Promise.race([
      server.exited,
      new Promise<number>((resolveExit) => setTimeout(() => resolveExit(1), 1_000)),
    ]);
  }
  throw error;
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  releaseLock?.();
  releaseDatabaseReservation?.();
  portReservation.release();
}
process.exit(exitCode);

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function healthUrl(host: string, port: number): string {
  return `http://${hostForUrl(host)}:${port}/health`;
}

async function waitForHealth(
  host: string,
  port: number,
  server: ReturnType<typeof Bun.spawn>,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();
  let exited = false;
  let exitCode: number | null = null;
  void server.exited.then((code) => {
    exited = true;
    exitCode = code;
  });
  while (Date.now() - startedAt <= timeoutMs) {
    if (exited) {
      throw new Error(`prime-board server exited before /health (code ${exitCode ?? "signal"})`);
    }
    try {
      const response = await fetch(healthUrl(host, port), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The server may still be applying migrations or bootstrap.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for ${healthUrl(host, port)}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
