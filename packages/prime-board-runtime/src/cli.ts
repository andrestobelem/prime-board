#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseRuntimeArgs, type RuntimeOptions } from "./options.ts";
import {
  acquireDatabaseReservation,
  acquireInstanceLock,
  chooseAvailablePort,
  classifyInstance,
  databaseReservationPaths,
  deriveProjectIdentity,
  promoteDatabaseReservationOwner,
  promoteInstanceOwner,
  reserveAvailablePort,
  resolveInstanceStatus,
  retireInstanceLock,
  type InstanceRecord,
  type ProjectInstanceIdentity,
} from "./project.ts";

const HEALTH_TIMEOUT_MS = 15_000;
const DEFAULT_PORT = 3333;
const DEFAULT_HOST = "127.0.0.1";
const HELP = `prime-board runtime

Usage: prime-board [options]

Options:
  --project PATH   Git project repository (default: current directory)
  --db PATH        SQLite database path (default: ~/.prime-board/projects/<project>.db)
  --port PORT      HTTP port (default: 3333; moves to the next free port when implicit)
  --host HOST      HTTP bind host (default: 127.0.0.1)
  --web-dist PATH  Static UI directory (default: packaged UI)
  --status         Show the instance state without starting a server
  --print-env      Print shell exports without starting the server
  --help           Show this help

Environment:
  PRIME_BOARD_AUTH_MODE=local  Loopback-only mode without an API key

The installed package requires Bun >= 1.3.14. Runtime data is stored outside this package.
`;

function gitProjectRoot(projectPath: string): string {
  const check = Bun.spawnSync(["git", "-C", projectPath, "rev-parse", "--show-toplevel"]);
  if (check.exitCode !== 0) throw new Error(`Project is not a Git repository: ${projectPath}`);
  const root = check.stdout.toString().trim();
  if (!root) throw new Error(`Git returned an empty project root: ${projectPath}`);
  return realpathSync(root);
}

function parsePort(value: string | undefined, fallback: number): number {
  const raw = value ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid port: ${raw}`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function healthUrl(host: string, port: number): string {
  return `http://${hostForUrl(host)}:${port}/health`;
}

function statusExitCode(state: ReturnType<typeof classifyInstance>["state"]): number {
  if (state === "running") return 0;
  if (state === "not-running") return 1;
  return 2;
}

function describeStatus(
  identity: ProjectInstanceIdentity,
  status: ReturnType<typeof classifyInstance>,
): void {
  const record = status.record;
  const details = record
    ? ` host=${record.host ?? DEFAULT_HOST} port=${record.port} pid=${record.pid} db=${record.databasePath}`
    : ` db=${identity.databasePath}`;
  console.log(`${status.state} project=${identity.projectRoot}${details}`);
}

function assertDatabaseCompatibility(
  identity: ProjectInstanceIdentity,
  status: ReturnType<typeof classifyInstance>,
): void {
  if (
    status.record &&
    status.record.projectRoot === identity.projectRoot &&
    status.record.databasePath !== identity.databasePath
  ) {
    throw new Error(
      `Project instance already uses database ${status.record.databasePath}; refusing to start with ${identity.databasePath}`,
    );
  }
}

function printEnvironment(
  identity: ProjectInstanceIdentity,
  projectRoot: string,
  host: string,
  port: number,
  webDist: string,
): void {
  console.log(`export PRIME_BOARD_REPO=${shellQuote(projectRoot)}`);
  console.log(`export PRIME_BOARD_DB=${shellQuote(identity.databasePath)}`);
  console.log(`export PRIME_BOARD_HOST=${shellQuote(host)}`);
  console.log(`export PRIME_BOARD_PORT=${shellQuote(String(port))}`);
  console.log(`export PRIME_BOARD_URL=${shellQuote(`http://${hostForUrl(host)}:${port}`)}`);
  console.log(`export PRIME_BOARD_WEB_DIST=${shellQuote(webDist)}`);
}

async function waitForHealth(
  host: string,
  port: number,
  child: ChildProcess | null,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  let exited = false;
  let exitCode: number | null = null;
  const onExit = (code: number | null) => {
    exited = true;
    exitCode = code;
  };
  child?.once("exit", onExit);
  try {
    while (Date.now() - startedAt <= timeoutMs) {
      if (exited)
        throw new Error(`prime-board server exited before /health (code ${exitCode ?? "signal"})`);
      try {
        const response = await fetch(healthUrl(host, port), {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return;
      } catch {
        // The server may still be applying SQLite migrations or bootstrap.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  } finally {
    child?.off("exit", onExit);
  }
  throw new Error(`Timed out waiting for ${healthUrl(host, port)}`);
}

function resolveProject(options: RuntimeOptions): string {
  const requested = options.projectRoot ?? options.repoRoot ?? process.cwd();
  return gitProjectRoot(resolve(requested));
}

function inheritedProjectMatches(projectRoot: string): boolean {
  const inheritedRoot = process.env.PRIME_BOARD_REPO;
  if (!inheritedRoot) return false;
  try {
    return gitProjectRoot(inheritedRoot) === projectRoot;
  } catch {
    return false;
  }
}

async function classifyAndDescribe(identity: ProjectInstanceIdentity): Promise<never> {
  const status = await resolveInstanceStatus(identity);
  describeStatus(identity, status);
  process.exit(statusExitCode(status.state));
}

const parsed = (() => {
  try {
    return parseRuntimeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
})();
if (parsed.help) {
  console.log(HELP);
  process.exit(0);
}

const projectRoot = resolveProject(parsed);
const home = homedir();
const identity = deriveProjectIdentity(projectRoot, home, parsed.dbPath);
const envPort = process.env.PRIME_BOARD_PORT;
const requestedPort = parsePort(
  parsed.port === undefined ? envPort : String(parsed.port),
  DEFAULT_PORT,
);
const portIsExplicit = parsed.port !== undefined || envPort !== undefined;
const requestedHost = parsed.host ?? process.env.PRIME_BOARD_HOST ?? DEFAULT_HOST;
const host = process.env.PRIME_BOARD_AUTH_MODE === "local" ? DEFAULT_HOST : requestedHost;
const webDist = parsed.webDist ?? process.env.PRIME_BOARD_WEB_DIST ?? join(import.meta.dir, "web");
const status = await resolveInstanceStatus(identity);
assertDatabaseCompatibility(identity, status);

if (parsed.status) await classifyAndDescribe(identity);
if (parsed.printEnv) {
  if (status.state === "running" && status.record) {
    printEnvironment(
      identity,
      projectRoot,
      status.record.host ?? host,
      status.record.port,
      webDist,
    );
    process.exit(0);
  }
  if (status.state === "stale") {
    describeStatus(identity, status);
    process.exit(statusExitCode(status.state));
  }
  const port = await chooseAvailablePort(requestedPort, portIsExplicit);
  printEnvironment(identity, projectRoot, host, port, webDist);
  process.exit(0);
}

if (status.state === "running" && status.record) {
  const runningHost = status.record.host ?? host;
  await waitForHealth(runningHost, status.record.port, null);
  console.log(`prime-board ready: http://${hostForUrl(runningHost)}:${status.record.port}`);
  process.exit(0);
}
if (status.state === "stale") retireInstanceLock(identity);

let server: ChildProcess | null = null;
let receivedSignal: NodeJS.Signals | null = null;
const onSignal = (signal: NodeJS.Signals) => {
  if (server) server.kill(signal);
  else receivedSignal = signal;
};
const onSigint = () => onSignal("SIGINT");
const onSigterm = () => onSignal("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

const portReservation = await reserveAvailablePort(requestedPort, portIsExplicit, home);
const instanceId = randomUUID();
const instanceRecord: InstanceRecord = {
  version: 1,
  projectRoot,
  databasePath: identity.databasePath,
  port: portReservation.port,
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
  if (receivedSignal) {
    process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
    process.exit();
  }

  const environment = {
    ...process.env,
    PRIME_BOARD_REPO: projectRoot,
    PRIME_BOARD_DB: identity.databasePath,
    PRIME_BOARD_PORT: String(portReservation.port),
    PRIME_BOARD_HOST: host,
    PRIME_BOARD_WEB_DIST: webDist,
    PRIME_BOARD_PERSISTENCE: "sqlite",
    PRIME_BOARD_INSTANCE_ID: instanceId,
    PRIME_BOARD_INSTANCE_METADATA: identity.metadataPath,
    PRIME_BOARD_LAUNCHER_PID: String(process.pid),
    PRIME_BOARD_DATABASE_RESERVATION_METADATA: JSON.stringify(
      databaseReservationPaths(identity.databasePath, home).map((path) =>
        join(path, "reservation.json"),
      ),
    ),
  };
  server = spawn(process.execPath, [join(import.meta.dir, "server.js")], {
    env: environment,
    detached: true,
    stdio: "inherit",
  });
  if (server.pid === undefined) throw new Error("prime-board server did not expose a PID");
  const owner = { pid: server.pid, processGroupId: server.pid };
  promoteDatabaseReservationOwner(identity, owner, instanceId);
  promoteInstanceOwner(identity, owner, instanceId);
  const serverExit = new Promise<number>((resolveExit) => {
    server?.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
  await waitForHealth(host, portReservation.port, server);
  console.log(`prime-board ready: http://${hostForUrl(host)}:${portReservation.port}`);
  process.exitCode = await serverExit;
} catch (error) {
  if (server && !server.killed) server.kill("SIGTERM");
  throw error;
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  releaseLock?.();
  releaseDatabaseReservation?.();
  portReservation.release();
}
