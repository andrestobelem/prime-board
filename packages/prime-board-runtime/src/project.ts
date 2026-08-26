import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

export interface GitWorktreeInspection {
  projectPath: string;
  projectRoot: string | null;
  insideWorktree: boolean | null;
  bareRepository: boolean | null;
  coreBare: boolean | null;
  error: string | null;
}

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function clearGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("GIT_")) delete clean[key];
  }
  return clean;
}

function runGit(projectPath: string, args: string[]): GitCommandResult {
  const result = Bun.spawnSync(["git", "-C", projectPath, ...args], {
    env: clearGitEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function parseGitBoolean(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Reads the worktree state without changing Git configuration or worktree records.
 * `core.bare` lives in the shared repository config, so a value of true is unsafe
 * even when Git still reports the linked checkout as a worktree.
 */
export function inspectGitWorktree(projectPath: string): GitWorktreeInspection {
  const resolvedPath = resolve(projectPath);
  const rootResult = runGit(resolvedPath, ["rev-parse", "--show-toplevel"]);
  const insideResult = runGit(resolvedPath, ["rev-parse", "--is-inside-work-tree"]);
  const bareResult = runGit(resolvedPath, ["rev-parse", "--is-bare-repository"]);
  const coreBareResult = runGit(resolvedPath, [
    "config",
    "--local",
    "--bool",
    "--get",
    "core.bare",
  ]);
  let projectRoot: string | null = null;
  if (rootResult.exitCode === 0 && rootResult.stdout) {
    try {
      projectRoot = realpathSync(rootResult.stdout);
    } catch {
      projectRoot = resolve(rootResult.stdout);
    }
  }
  const commandError = [rootResult, insideResult, bareResult].find(
    (result) => result.exitCode !== 0,
  )?.stderr;
  return {
    projectPath: resolvedPath,
    projectRoot,
    insideWorktree: parseGitBoolean(insideResult.stdout),
    bareRepository: parseGitBoolean(bareResult.stdout),
    coreBare: parseGitBoolean(coreBareResult.stdout),
    error: commandError || null,
  };
}

/**
 * Resolves a project root only when the checkout is a usable non-bare worktree.
 * This guard is read-only. Callers must report and repair Git configuration
 * outside the launcher when it fails.
 */
export function assertNonBareGitWorktree(projectPath: string): string {
  const inspection = inspectGitWorktree(projectPath);
  const projectRoot = inspection.projectRoot;
  const unsafe =
    projectRoot === null ||
    inspection.insideWorktree !== true ||
    inspection.bareRepository === true ||
    inspection.coreBare === true;
  if (unsafe) {
    const details = [
      `path=${inspection.projectPath}`,
      `core.bare=${inspection.coreBare === null ? "unset" : String(inspection.coreBare)}`,
      `is-bare-repository=${inspection.bareRepository === null ? "unknown" : String(inspection.bareRepository)}`,
      `is-inside-work-tree=${inspection.insideWorktree === null ? "unknown" : String(inspection.insideWorktree)}`,
      inspection.error,
    ].filter(Boolean);
    throw new Error(`Git checkout must be a usable non-bare worktree (${details.join(", ")})`);
  }
  return projectRoot;
}

export interface ProjectInstanceIdentity {
  projectRoot: string;
  projectSlug: string;
  projectHash: string;
  databasePath: string;
  databaseLockPath: string;
  databasePhysicalLockPath: string;
  databaseInodeLockPath: string | null;
  lockPath: string;
  metadataPath: string;
}

export function deriveProjectIdentity(
  projectRoot: string,
  homeDirectory = homedir(),
  databasePathOverride?: string,
): ProjectInstanceIdentity {
  const root = resolve(projectRoot);
  const projectSlug =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-") || "project";
  const projectHash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const projectStateRoot = join(resolve(homeDirectory), ".prime-board", "projects");
  const projectKey = `${projectSlug}-${projectHash}`;
  const databasePath = stableDatabasePath(
    databasePathOverride ?? join(projectStateRoot, `${projectKey}.db`),
  );
  const lockPath = join(projectStateRoot, `${projectKey}.lock`);

  return {
    projectRoot: root,
    projectSlug,
    projectHash,
    databasePath,
    databaseLockPath: databaseReservationPath(databasePath, homeDirectory),
    databasePhysicalLockPath: databasePhysicalReservationPath(databasePath, homeDirectory),
    databaseInodeLockPath: databaseInodeReservationPath(databasePath, homeDirectory),
    lockPath,
    metadataPath: join(lockPath, "instance.json"),
  };
}

export interface InstanceRecord {
  version: 1;
  projectRoot: string;
  databasePath: string;
  port: number;
  /** PID del server después de transferir la propiedad desde el launcher. */
  pid: number;
  /** PID del launcher que creó la reserva. */
  launcherPid?: number;
  /** PID explícito del server para lectores de metadata anterior. */
  serverPid?: number;
  /** PID del líder del grupo cuando el server está separado. */
  processGroupId?: number;
  /** Impide que un server tardío sobrescriba una instancia nueva. */
  instanceId?: string;
  host?: string;
  startedAt: string;
}

export interface DatabaseReservationRecord {
  version: 1;
  projectRoot: string;
  databasePath: string;
  /** PID del server después de transferir la propiedad desde el launcher. */
  pid: number;
  /** PID del launcher que creó la reserva. */
  launcherPid?: number;
  /** PID explícito del server para lectores de metadata anterior. */
  serverPid?: number;
  /** PID del líder del grupo cuando el server está separado. */
  processGroupId?: number;
  /** Impide que un server tardío sobrescriba una reserva nueva. */
  instanceId?: string;
  reservedAt: string;
}

export interface ProcessOwnership {
  pid: number;
  processGroupId?: number;
}

/**
 * Keeps the database path as a stable filesystem alias.
 *
 * Following any symlink would change the path when a missing parent or target
 * is created. The physical reservation below handles existing hardlinks while
 * this alias remains stable for the complete launcher lifecycle.
 */
export function stableDatabasePath(databasePath: string): string {
  return resolve(databasePath);
}

function databaseReservationKey(databasePath: string): string {
  return stableDatabasePath(databasePath);
}

function databasePhysicalReservationKey(databasePath: string): string {
  let current = resolve(databasePath);
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      if (!lstatSync(current).isSymbolicLink()) return current;
      current = resolve(dirname(current), readlinkSync(current));
    } catch {
      return current;
    }
  }
  return current;
}

function databaseInodeReservationKey(databasePath: string): string | null {
  try {
    const stats = statSync(databasePath);
    return stats.isFile() ? `${stats.dev}:${stats.ino}` : null;
  } catch {
    return null;
  }
}

export function databaseReservationPath(databasePath: string, homeDirectory = homedir()): string {
  const key = createHash("sha256")
    .update(`alias:${databaseReservationKey(databasePath)}`)
    .digest("hex")
    .slice(0, 16);
  return join(resolve(homeDirectory), ".prime-board", "databases", `${key}.lock`);
}

/** Stable target-path lock. It works before a dangling symlink target exists. */
export function databasePhysicalReservationPath(
  databasePath: string,
  homeDirectory = homedir(),
): string {
  const key = databasePhysicalReservationKey(databasePath);
  const hash = createHash("sha256").update(`target:${key}`).digest("hex").slice(0, 16);
  return join(resolve(homeDirectory), ".prime-board", "databases", `${hash}.lock`);
}

/** Inode lock. It makes existing hardlink aliases share the same reservation. */
export function databaseInodeReservationPath(
  databasePath: string,
  homeDirectory = homedir(),
): string | null {
  const key = databaseInodeReservationKey(databasePath);
  if (!key) return null;
  const hash = createHash("sha256").update(`inode:${key}`).digest("hex").slice(0, 16);
  return join(resolve(homeDirectory), ".prime-board", "databases", `${hash}.lock`);
}

export function databaseReservationPaths(
  databasePath: string,
  homeDirectory = homedir(),
): string[] {
  return [
    databaseReservationPath(databasePath, homeDirectory),
    databasePhysicalReservationPath(databasePath, homeDirectory),
    databaseInodeReservationPath(databasePath, homeDirectory),
  ].filter((path): path is string => Boolean(path));
}

export type InstanceState = "running" | "stale" | "not-running";

export interface InstanceStatus {
  state: InstanceState;
  record: InstanceRecord | null;
}

export type ProcessProbe = (pid: number) => boolean;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupIsAlive(processGroupId: number): boolean {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    // Un server separado posee su grupo de procesos. Esto detecta el server
    // después de que SIGKILL termina el launcher que creó la reserva.
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function processOwnerIsAlive(
  record: Pick<InstanceRecord, "pid" | "serverPid" | "processGroupId">,
  probe: ProcessProbe,
): boolean {
  const ownerPid = record.serverPid ?? record.pid;
  return (
    probe(ownerPid) ||
    (record.processGroupId !== undefined && processGroupIsAlive(record.processGroupId))
  );
}

function readInstanceRecord(identity: ProjectInstanceIdentity): InstanceRecord | null {
  if (!existsSync(identity.metadataPath)) return null;
  try {
    return JSON.parse(readFileSync(identity.metadataPath, "utf8")) as InstanceRecord;
  } catch {
    return null;
  }
}

let atomicWriteCounter = 0;

function writeJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${atomicWriteCounter++}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function classifyInstance(
  identity: ProjectInstanceIdentity,
  probe: ProcessProbe = processIsAlive,
): InstanceStatus {
  if (!existsSync(identity.lockPath)) return { state: "not-running", record: null };
  const record = readInstanceRecord(identity);
  if (
    !record ||
    record.version !== 1 ||
    record.projectRoot !== identity.projectRoot ||
    !Number.isInteger(record.pid) ||
    !processOwnerIsAlive(record, probe)
  ) {
    return { state: "stale", record };
  }
  return { state: "running", record };
}

interface InstanceHealthMetadata {
  status: "ok";
  pid: number;
  projectRoot: string;
  databasePath: string;
  instanceId?: string;
  processGroupId?: number;
}

function isInstanceHealthMetadata(value: unknown): value is InstanceHealthMetadata {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.status === "ok" &&
    Number.isInteger(record.pid) &&
    typeof record.projectRoot === "string" &&
    typeof record.databasePath === "string" &&
    (record.instanceId === undefined || typeof record.instanceId === "string") &&
    (record.processGroupId === undefined || Number.isInteger(record.processGroupId))
  );
}

function hostForHealthUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function readInstanceHealth(
  record: InstanceRecord,
): Promise<InstanceHealthMetadata | "healthy" | null> {
  const host = hostForHealthUrl(record.host ?? "127.0.0.1");
  const token = record.instanceId ? `&instance=${encodeURIComponent(record.instanceId)}` : "";
  try {
    const response = await fetch(`http://${host}:${record.port}/health?details=1${token}`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (isInstanceHealthMetadata(value)) return value;
    if (
      record.instanceId === undefined &&
      typeof value === "object" &&
      value !== null &&
      (value as Record<string, unknown>).status === "ok"
    ) {
      // Los servers anteriores no exponen detalles de identidad. Mantiene ocupado
      // su puerto saludable para no arriesgar un segundo escritor sobre la DB.
      return "healthy";
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Repara un registro huérfano cuando su server todavía está saludable.
 *
 * La metadata de PID es la ruta rápida. Health es la alternativa segura ante
 * carreras durante el handoff después de spawn y metadata de launchers viejos.
 */
export async function resolveInstanceStatus(
  identity: ProjectInstanceIdentity,
): Promise<InstanceStatus> {
  const status = classifyInstance(identity);
  if (status.state !== "stale" || !status.record) return status;
  const health = await readInstanceHealth(status.record);
  if (health === "healthy") return { state: "running", record: status.record };
  if (
    !health ||
    health.projectRoot !== identity.projectRoot ||
    health.databasePath !== identity.databasePath ||
    (status.record.instanceId !== undefined && health.instanceId !== status.record.instanceId)
  ) {
    return status;
  }

  const owner: ProcessOwnership = {
    pid: health.pid,
    processGroupId: health.processGroupId ?? health.pid,
  };
  try {
    // Publica primero el owner del proyecto. Un launcher nuevo no debe tomar
    // la reserva de DB mientras el hijo completa el handoff.
    promoteInstanceOwner(identity, owner, status.record.instanceId);
    // Reserva la DB después. Si un launcher concurrente gana la carrera, esta
    // reparación no debe sobrescribir su metadata.
    promoteDatabaseReservationOwner(identity, owner, status.record.instanceId);
  } catch {
    // Es más seguro tratar un server coincidente y saludable como activo que
    // iniciar un segundo escritor. La siguiente llamada puede terminar el handoff.
  }
  return {
    state: "running",
    record: {
      ...status.record,
      pid: owner.pid,
      launcherPid: status.record.launcherPid ?? status.record.pid,
      serverPid: owner.pid,
      processGroupId: owner.processGroupId,
    },
  };
}

export function removeInstanceLock(identity: ProjectInstanceIdentity): void {
  rmSync(identity.lockPath, { recursive: true, force: true });
}

export function retireInstanceLock(identity: ProjectInstanceIdentity): void {
  const quarantinePath = `${identity.lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(identity.lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
}

export function acquireInstanceLock(
  identity: ProjectInstanceIdentity,
  record: InstanceRecord,
): () => void {
  mkdirSync(dirname(identity.lockPath), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(identity.lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Project instance already running: ${identity.projectRoot}`);
    }
    throw error;
  }
  try {
    writeFileSync(identity.metadataPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    removeInstanceLock(identity);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    removeInstanceLock(identity);
  };
}

function ensureInstanceOwnerRecord(
  record: InstanceRecord | null,
  instanceId: string | undefined,
): InstanceRecord {
  if (!record || record.version !== 1 || !Number.isInteger(record.pid)) {
    throw new Error("Project instance metadata is incomplete");
  }
  if (
    (instanceId !== undefined && record.instanceId !== instanceId) ||
    (instanceId === undefined && record.instanceId !== undefined)
  ) {
    throw new Error("Project instance metadata belongs to another launcher");
  }
  return record;
}

/**
 * Transfiere el lock del proyecto desde el launcher a su server hijo.
 *
 * El reemplazo es atómico. Un lector de estado ve al launcher o al server,
 * nunca un registro escrito de forma parcial.
 */
export function promoteInstanceOwner(
  identity: ProjectInstanceIdentity,
  owner: ProcessOwnership,
  instanceId?: string,
): void {
  const record = ensureInstanceOwnerRecord(readInstanceRecord(identity), instanceId);
  writeJsonAtomically(identity.metadataPath, {
    ...record,
    pid: owner.pid,
    launcherPid: record.launcherPid ?? record.pid,
    serverPid: owner.pid,
    ...(owner.processGroupId === undefined ? {} : { processGroupId: owner.processGroupId }),
  });
}

function databaseReservationRecordPath(path: string): string {
  return join(path, "reservation.json");
}

function databaseReservationPathsForIdentity(identity: ProjectInstanceIdentity): string[] {
  return [
    identity.databaseLockPath,
    identity.databasePhysicalLockPath,
    identity.databaseInodeLockPath,
  ]
    .filter((path): path is string => Boolean(path))
    .sort();
}

/** Transfiere cada reserva de DB existente al server hijo. */
export function promoteDatabaseReservationOwner(
  identity: ProjectInstanceIdentity,
  owner: ProcessOwnership,
  instanceId?: string,
): void {
  let found = false;
  for (const path of databaseReservationPathsForIdentity(identity)) {
    const metadataPath = databaseReservationRecordPath(path);
    if (!existsSync(metadataPath)) continue;
    const existing = readDatabaseReservation(path);
    if (existing === null || existing === "invalid") {
      throw new Error(`Database reservation is incomplete: ${identity.databasePath}`);
    }
    if (
      (instanceId !== undefined && existing.instanceId !== instanceId) ||
      (instanceId === undefined && existing.instanceId !== undefined)
    ) {
      throw new Error("Database reservation belongs to another launcher");
    }
    found = true;
    writeJsonAtomically(metadataPath, {
      ...existing,
      pid: owner.pid,
      launcherPid: existing.launcherPid ?? existing.pid,
      serverPid: owner.pid,
      ...(owner.processGroupId === undefined ? {} : { processGroupId: owner.processGroupId }),
    });
  }
  if (!found) throw new Error(`Database reservation is missing: ${identity.databasePath}`);
}

function readDatabaseReservation(path: string): DatabaseReservationRecord | "invalid" | null {
  const metadataPath = join(path, "reservation.json");
  if (!existsSync(metadataPath)) return null;
  try {
    const record = JSON.parse(
      readFileSync(metadataPath, "utf8"),
    ) as Partial<DatabaseReservationRecord>;
    if (
      record.version !== 1 ||
      typeof record.projectRoot !== "string" ||
      typeof record.databasePath !== "string" ||
      !Number.isInteger(record.pid) ||
      typeof record.reservedAt !== "string"
    ) {
      return "invalid";
    }
    return record as DatabaseReservationRecord;
  } catch {
    return "invalid";
  }
}

function retireDatabaseReservation(path: string): void {
  const quarantinePath = `${path}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
}

export function acquireDatabaseReservation(
  identity: ProjectInstanceIdentity,
  record: DatabaseReservationRecord,
  probe: ProcessProbe = processIsAlive,
): () => void {
  const paths = databaseReservationPathsForIdentity(identity);
  for (const path of paths) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < paths.length + 1; attempt += 1) {
    const created: string[] = [];
    try {
      for (const path of paths) {
        mkdirSync(path, { mode: 0o700 });
        created.push(path);
        writeFileSync(join(path, "reservation.json"), `${JSON.stringify(record, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const path of [...paths].reverse()) rmSync(path, { recursive: true, force: true });
      };
    } catch (error) {
      for (const path of [...created].reverse()) rmSync(path, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const conflict = paths.find((path) => existsSync(path));
      if (!conflict) continue;
      const existing = readDatabaseReservation(conflict);
      if (existing === null || existing === "invalid") {
        throw new Error(`Database reservation is incomplete: ${identity.databasePath}`);
      }
      if (processOwnerIsAlive(existing, probe)) {
        throw new Error(`Database is already reserved: ${identity.databasePath}`);
      }
      retireDatabaseReservation(conflict);
    }
  }
  throw new Error(`Database reservation is busy: ${identity.databasePath}`);
}
export type PortProbe = (port: number) => Promise<boolean>;

async function portIsAvailable(port: number): Promise<boolean> {
  return await new Promise((resolveAvailability) => {
    const server = createServer();
    server.once("error", () => resolveAvailability(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolveAvailability(true));
    });
  });
}

export async function chooseAvailablePort(
  preferredPort: number,
  explicit: boolean,
  probe: PortProbe = portIsAvailable,
): Promise<number> {
  if (await probe(preferredPort)) return preferredPort;
  if (explicit) throw new Error(`Port ${preferredPort} is already in use`);
  for (let port = preferredPort + 1; port <= 65535; port += 1) {
    if (await probe(port)) return port;
  }
  throw new Error(`No available port found after ${preferredPort}`);
}

export interface PortReservation {
  port: number;
  release: () => void;
}

interface PortReservationRecord {
  version: 1;
  port: number;
  pid: number;
  reservedAt: string;
}

function portReservationPath(homeDirectory: string, port: number): string {
  return join(resolve(homeDirectory), ".prime-board", "ports", `${port}.lock`);
}

function readPortReservation(path: string): PortReservationRecord | "invalid" | null {
  const metadataPath = join(path, "reservation.json");
  if (!existsSync(metadataPath)) return null;
  try {
    const record = JSON.parse(readFileSync(metadataPath, "utf8")) as PortReservationRecord;
    if (record.version !== 1 || !Number.isInteger(record.pid) || record.port <= 0) {
      return "invalid";
    }
    return record;
  } catch {
    return "invalid";
  }
}

function retirePortReservation(path: string): void {
  const quarantinePath = `${path}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
}

function acquirePortReservation(homeDirectory: string, port: number): (() => void) | null {
  const path = portReservationPath(homeDirectory, port);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      const record: PortReservationRecord = {
        version: 1,
        port,
        pid: process.pid,
        reservedAt: new Date().toISOString(),
      };
      writeFileSync(join(path, "reservation.json"), `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      const record = readPortReservation(path);
      // A newly-created directory can be observed before its metadata is written.
      // Keep malformed or incomplete reservations occupied instead of stealing them.
      if (record === null || record === "invalid") return null;
      if (processIsAlive(record.pid)) return null;
      retirePortReservation(path);
    }
  }
  return null;
}

/**
 * Atomically reserves a loopback port for the launcher startup window.
 * The reservation stays held until the child server exits or startup fails.
 */
export async function reserveAvailablePort(
  preferredPort: number,
  explicit: boolean,
  homeDirectory = homedir(),
  probe: PortProbe = portIsAvailable,
): Promise<PortReservation> {
  for (let port = preferredPort; port <= 65535; port += 1) {
    const release = acquirePortReservation(homeDirectory, port);
    if (!release) {
      if (explicit) throw new Error(`Port ${preferredPort} is already in use`);
      continue;
    }
    let available = false;
    try {
      available = await probe(port);
    } catch (error) {
      release();
      throw error;
    }
    if (available) return { port, release };
    release();
    if (explicit) throw new Error(`Port ${preferredPort} is already in use`);
  }
  throw new Error(`No available port found after ${preferredPort}`);
}
