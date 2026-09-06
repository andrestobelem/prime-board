import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
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
  /** Token privado de la adquisición que puede retirar este lease. */
  leaseToken?: string;
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
  /** Token privado de la adquisición que puede retirar este lease. */
  leaseToken?: string;
  reservedAt: string;
}

export interface ProcessOwnership {
  pid: number;
  processGroupId?: number;
}

/** Closure de release que expone el lease usado durante el handoff de ownership. */
export type LeaseRelease = (() => void) & {
  readonly leaseToken: string;
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalToken(value: unknown): value is string | undefined {
  return (
    value === undefined || (typeof value === "string" && value.length > 0 && value.trim() === value)
  );
}

function leaseTokenOrRandom(value: unknown): string {
  return isOptionalToken(value) && value !== undefined ? value : randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leaseIdentityMatches(
  current: { instanceId?: string; leaseToken?: string },
  expected: { instanceId?: string; leaseToken?: string },
): boolean {
  return current.instanceId === expected.instanceId && current.leaseToken === expected.leaseToken;
}

function isInstanceRecord(value: unknown): value is InstanceRecord {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.projectRoot === "string" &&
    typeof value.databasePath === "string" &&
    isPositiveInteger(value.port) &&
    isPositiveInteger(value.pid) &&
    isOptionalPositiveInteger(value.launcherPid) &&
    isOptionalPositiveInteger(value.serverPid) &&
    isOptionalPositiveInteger(value.processGroupId) &&
    isOptionalToken(value.instanceId) &&
    isOptionalToken(value.leaseToken) &&
    isOptionalString(value.host) &&
    typeof value.startedAt === "string"
  );
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

export type InstanceState = "running" | "stale" | "not-running" | "blocked";

export interface InstanceStatus {
  state: InstanceState;
  record: InstanceRecord | null;
}

export type ProcessProbe = (pid: number) => boolean;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM también prueba que el proceso existe. Tratarlo como muerto podría
    // permitir que otro launcher retire un owner activo que no puede inspeccionar.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupIsAlive(processGroupId: number): boolean {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    // Un server separado posee su grupo de procesos. Esto detecta el server
    // después de que SIGKILL termina el launcher que creó la reserva.
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processOwnerIsAlive(
  record: Pick<InstanceRecord, "pid" | "launcherPid" | "serverPid" | "processGroupId">,
  probe: ProcessProbe,
): boolean {
  for (const pid of [record.pid, record.serverPid, record.launcherPid]) {
    if (pid !== undefined && probe(pid)) return true;
  }
  return record.processGroupId !== undefined && processGroupIsAlive(record.processGroupId);
}

function readInstanceRecord(identity: ProjectInstanceIdentity): InstanceRecord | null {
  if (!existsSync(identity.metadataPath)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(identity.metadataPath, "utf8"));
    return isInstanceRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function writeJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
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

function ownershipMarkerPath(directory: string, token: string): string {
  const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 32);
  return join(directory, `.owner-${tokenHash}`);
}

function writeOwnershipMarker(directory: string, token: string): void {
  const markerPath = ownershipMarkerPath(directory, token);
  const temporaryPath = `${markerPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    linkSync(temporaryPath, markerPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function hasOwnershipMarker(directory: string, token: string): boolean {
  try {
    return readFileSync(ownershipMarkerPath(directory, token), "utf8").trim() === token;
  } catch {
    return false;
  }
}

function hasAnyOwnershipMarker(directory: string): boolean {
  try {
    return readdirSync(directory).some((name) => /^\.owner-[0-9a-f]{32}$/.test(name));
  } catch {
    return false;
  }
}

/**
 * Retira un lease nuevo por su marcador exclusivo. La transición serializa el
 * borrado completo para que un cleanup viejo no alcance una nueva adquisición.
 * Las reservas v1 sin marcador solo se pueden retirar mediante el flujo explícito
 * de recuperación stale; una release normal no usa coincidencias débiles.
 */
function removeOwnedLeaseDirectory(directory: string, token: string): boolean {
  if (!hasOwnershipMarker(directory, token)) return false;
  // La transición serializa el cleanup con cualquier nueva adquisición. Al
  // retirar el directorio completo también elimina temporales de una escritura
  // interrumpida, sin dejar un lock vacío que bloquee el siguiente owner.
  rmSync(directory, { recursive: true, force: true });
  return true;
}

/** Retira un lease legacy después de verificar su snapshot stale bajo transición. */
function removeStaleLeaseDirectory(directory: string): boolean {
  const quarantinePath = `${directory}.stale-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    renameSync(directory, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
  return true;
}

function ownershipTransitionPath(directory: string): string {
  return `${directory}.transition`;
}

function transitionOwner(path: string): { pid: number; token: string } | null {
  for (const candidate of [join(path, "owner.json"), path]) {
    try {
      const value = JSON.parse(readFileSync(candidate, "utf8")) as {
        pid?: unknown;
        token?: unknown;
      };
      if (
        typeof value.pid === "number" &&
        Number.isInteger(value.pid) &&
        value.pid > 0 &&
        typeof value.token === "string" &&
        value.token.length > 0
      ) {
        return { pid: value.pid, token: value.token };
      }
    } catch {
      // Un owner malformed se trata abajo como una transición ocupada.
    }
  }
  return null;
}

interface OwnershipTransition {
  release: () => void;
  recoveredStaleOwner: boolean;
}

function acquireOwnershipTransition(directory: string): OwnershipTransition | null {
  const path = ownershipTransitionPath(directory);
  const recoveryGatePath = `${path}.recovery`;
  const token = randomUUID();
  let recoveredStaleOwner = false;

  const publish = (temporaryPath: string): OwnershipTransition | null => {
    try {
      writeFileSync(temporaryPath, `${JSON.stringify({ pid: process.pid, token })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      linkSync(temporaryPath, path);
      let released = false;
      return {
        recoveredStaleOwner,
        release: () => {
          if (released) return;
          released = true;
          if (transitionOwner(path)?.token === token) {
            rmSync(path, { recursive: true, force: true });
          }
        },
      };
    } catch {
      return null;
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  };

  const publishRecoveryGate = (recoveryToken: string): boolean => {
    const temporaryPath = `${recoveryGatePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify({ pid: process.pid, token: recoveryToken })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      linkSync(temporaryPath, recoveryGatePath);
      return true;
    } catch {
      return false;
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Un gate stale se recupera con el mismo rename atómico que una transición
    // stale. Un gate malformed queda ocupado porque su owner es desconocido.
    if (existsSync(recoveryGatePath)) {
      const gateOwner = transitionOwner(recoveryGatePath);
      if (gateOwner === null || processIsAlive(gateOwner.pid)) return null;
      const gateQuarantinePath = `${recoveryGatePath}.stale-${process.pid}-${Date.now()}-${randomUUID()}`;
      try {
        renameSync(recoveryGatePath, gateQuarantinePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return null;
      }
      const quarantinedGateOwner = transitionOwner(gateQuarantinePath);
      if (quarantinedGateOwner !== null && processIsAlive(quarantinedGateOwner.pid)) {
        try {
          renameSync(gateQuarantinePath, recoveryGatePath);
        } catch {
          // No borres un gate que otro proceso haya publicado mientras tanto.
        }
        return null;
      }
      rmSync(gateQuarantinePath, { recursive: true, force: true });
      continue;
    }

    const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    const transition = publish(temporaryPath);
    if (transition) return transition;
    const owner = transitionOwner(path);
    if (owner === null || processIsAlive(owner.pid)) return null;
    if (existsSync(recoveryGatePath)) continue;

    const recoveryToken = randomUUID();
    if (!publishRecoveryGate(recoveryToken)) continue;
    let keepGate = false;
    try {
      // Lee de nuevo después de tomar el gate. Un reemplazo vivo indica que
      // la snapshot stale fue sustituida; nunca la muevas a quarantine.
      const current = transitionOwner(path);
      if (
        (current !== null && processIsAlive(current.pid)) ||
        (owner !== null && current?.token !== owner.token)
      ) {
        continue;
      }
      const quarantinePath = `${path}.stale-${process.pid}-${Date.now()}-${randomUUID()}`;
      try {
        renameSync(path, quarantinePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          recoveredStaleOwner = true;
          continue;
        }
        continue;
      }
      const quarantinedOwner = transitionOwner(quarantinePath);
      if (quarantinedOwner !== null && processIsAlive(quarantinedOwner.pid)) {
        try {
          renameSync(quarantinePath, path);
        } catch {
          // No borres un path que otro proceso haya publicado mientras tanto.
        }
        continue;
      }
      rmSync(quarantinePath, { recursive: true, force: true });
      recoveredStaleOwner = true;
      const replacement = publish(`${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`);
      if (!replacement) continue;
      keepGate = true;
      let released = false;
      return {
        recoveredStaleOwner: replacement.recoveredStaleOwner,
        release: () => {
          if (released) return;
          released = true;
          replacement.release();
          if (transitionOwner(recoveryGatePath)?.token === recoveryToken) {
            rmSync(recoveryGatePath, { recursive: true, force: true });
          }
        },
      };
    } finally {
      if (!keepGate && transitionOwner(recoveryGatePath)?.token === recoveryToken) {
        rmSync(recoveryGatePath, { recursive: true, force: true });
      }
    }
  }
  return null;
}
function withOwnershipTransition<T>(
  directory: string,
  action: () => T,
  onRecoveredTransition?: (directory: string) => void,
): T | undefined {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const transition = acquireOwnershipTransition(directory);
    if (!transition) {
      if (!existsSync(dirname(directory))) return undefined;
      Atomics.wait(waitBuffer, 0, 0, 5);
      continue;
    }
    if (transition.recoveredStaleOwner) onRecoveredTransition?.(directory);
    try {
      return action();
    } finally {
      transition.release();
    }
  }
  return undefined;
}

function withOwnershipTransitions<T>(
  directories: string[],
  action: () => T,
  onRecoveredTransition?: (directory: string) => void,
): T | undefined {
  const [directory, ...rest] = directories;
  if (!directory) return action();
  return withOwnershipTransition(
    directory,
    () => withOwnershipTransitions(rest, action, onRecoveredTransition),
    onRecoveredTransition,
  );
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
  leaseToken?: string;
  processGroupId?: number;
}

function isInstanceHealthMetadata(value: unknown): value is InstanceHealthMetadata {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.status === "ok" &&
    isPositiveInteger(record.pid) &&
    typeof record.projectRoot === "string" &&
    typeof record.databasePath === "string" &&
    (record.instanceId === undefined || isOptionalToken(record.instanceId)) &&
    (record.leaseToken === undefined || isOptionalToken(record.leaseToken)) &&
    (record.processGroupId === undefined || isPositiveInteger(record.processGroupId))
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
  if (
    status.state === "running" &&
    status.record?.serverPid !== undefined &&
    !databaseReservationsMatchInstance(identity, status.record, processIsAlive)
  ) {
    return { state: "blocked", record: status.record };
  }
  if (status.state !== "stale" || !status.record) return status;
  const health = await readInstanceHealth(status.record);
  if (health === "healthy") return { state: "running", record: status.record };
  if (
    !health ||
    health.projectRoot !== identity.projectRoot ||
    health.databasePath !== identity.databasePath ||
    health.instanceId !== status.record.instanceId ||
    health.leaseToken !== status.record.leaseToken
  ) {
    return status;
  }

  const owner: ProcessOwnership = {
    pid: health.pid,
    processGroupId: health.processGroupId ?? health.pid,
  };
  const promotedRecord: InstanceRecord = {
    ...status.record,
    pid: owner.pid,
    launcherPid: status.record.launcherPid ?? status.record.pid,
    serverPid: owner.pid,
    processGroupId: owner.processGroupId,
  };
  try {
    // Publica primero el owner del proyecto. Un launcher nuevo no debe tomar
    // la reserva de DB mientras el hijo completa el handoff.
    promoteInstanceOwner(identity, owner, status.record.instanceId, status.record.leaseToken);
    // Reserva la DB después. Si un launcher concurrente gana la carrera, esta
    // reparación no debe sobrescribir su metadata.
    const databaseLeaseToken = currentDatabaseLeaseToken(identity);
    if (databaseLeaseToken === null) throw new Error("Database reservation lease is inconsistent");
    promoteDatabaseReservationOwner(identity, owner, status.record.instanceId, databaseLeaseToken);
  } catch {
    // Health confirma un server activo, pero una reserva sin promoción completa
    // no permite iniciar acciones ni un segundo escritor.
    return { state: "blocked", record: promotedRecord };
  }
  return { state: "running", record: promotedRecord };
}

function instanceRecordBelongsTo(
  current: InstanceRecord | null,
  expected: InstanceRecord,
): boolean {
  if (
    !current ||
    current.version !== 1 ||
    current.projectRoot !== expected.projectRoot ||
    current.databasePath !== expected.databasePath
  ) {
    return false;
  }
  if (expected.leaseToken !== undefined) {
    if (current.leaseToken !== expected.leaseToken) return false;
  } else if (current.leaseToken !== undefined) {
    return false;
  }
  if (current.instanceId !== expected.instanceId) return false;
  return (
    current.port === expected.port &&
    current.host === expected.host &&
    current.pid === expected.pid &&
    current.startedAt === expected.startedAt
  );
}

function removeOwnedInstanceLock(
  identity: ProjectInstanceIdentity,
  expected: Pick<
    InstanceRecord,
    "projectRoot" | "databasePath" | "port" | "host" | "instanceId" | "leaseToken" | "startedAt"
  >,
): boolean {
  const leaseToken = expected.leaseToken;
  if (!leaseToken) return false;
  return (
    withOwnershipTransition(identity.lockPath, () => {
      const current = readInstanceRecord(identity);
      if (
        current !== null &&
        (current.projectRoot !== expected.projectRoot ||
          current.databasePath !== expected.databasePath ||
          current.port !== expected.port ||
          current.host !== expected.host ||
          current.startedAt !== expected.startedAt ||
          !leaseIdentityMatches(current, expected))
      ) {
        return false;
      }
      return removeOwnedLeaseDirectory(identity.lockPath, leaseToken);
    }) ?? false
  );
}

export function removeInstanceLock(
  identity: ProjectInstanceIdentity,
  expected?: InstanceRecord,
): void {
  // Una eliminación sin token no puede demostrar qué adquisición creó el lock.
  // Usa retireInstanceLock para limpiar una entrada stale mediante su estado.
  if (!expected?.leaseToken) return;
  removeOwnedInstanceLock(identity, expected);
}

export function retireInstanceLock(
  identity: ProjectInstanceIdentity,
  expected?: InstanceRecord,
): void {
  if (!expected) {
    // Sin un record esperado, metadata faltante o malformed no prueba que el
    // lock sea stale. Déjalo ocupado en vez de borrarlo tras recuperar una
    // transición interrumpida.
    let recoveredTransition = false;
    withOwnershipTransition(
      identity.lockPath,
      () => {
        const current = readInstanceRecord(identity);
        if (current === null) {
          // Una transición stale puede dejar el lock sin metadata. No retires
          // metadata malformed ni una escritura que no demuestre un crash.
          if (!recoveredTransition || existsSync(identity.metadataPath)) return;
          removeStaleLeaseDirectory(identity.lockPath);
          return;
        }
        if (processOwnerIsAlive(current, processIsAlive)) return;
        removeStaleLeaseDirectory(identity.lockPath);
      },
      () => {
        recoveredTransition = true;
      },
    );
    return;
  }
  const leaseToken = expected.leaseToken;
  if (leaseToken) {
    let recoveredTransition = false;
    const retired = withOwnershipTransition(
      identity.lockPath,
      () => {
        const current = readInstanceRecord(identity);
        if (current === null) {
          // Una transición stale puede dejar el lock sin metadata. La ausencia
          // de metadata debe ser real y el owner observado debe estar muerto.
          if (
            !recoveredTransition ||
            existsSync(identity.metadataPath) ||
            processOwnerIsAlive(expected, processIsAlive) ||
            !hasOwnershipMarker(identity.lockPath, leaseToken)
          ) {
            return false;
          }
        } else if (
          !instanceRecordBelongsTo(current, expected) ||
          processOwnerIsAlive(current, processIsAlive)
        ) {
          return false;
        }
        return removeOwnedLeaseDirectory(identity.lockPath, leaseToken);
      },
      () => {
        recoveredTransition = true;
      },
    );
    // Si falta el marker o pertenece a otro lease, no uses metadata como
    // fallback. El caller no puede probar que adquirió este lock.
    if (!retired) return;
    return;
  }
  // Las instalaciones legacy no tienen marker. Recupera solo el snapshot stale
  // que observó el caller; una adquisición nueva cambia el token o el timestamp.
  withOwnershipTransition(identity.lockPath, () => {
    const current = readInstanceRecord(identity);
    if (
      current === null ||
      !instanceRecordBelongsTo(current, expected) ||
      processOwnerIsAlive(current, processIsAlive)
    ) {
      return;
    }
    removeStaleLeaseDirectory(identity.lockPath);
  });
}
export function acquireInstanceLock(
  identity: ProjectInstanceIdentity,
  record: InstanceRecord,
): LeaseRelease {
  const leaseToken = leaseTokenOrRandom(record.leaseToken);
  const ownedRecord: InstanceRecord = { ...record, leaseToken };
  mkdirSync(dirname(identity.lockPath), { recursive: true, mode: 0o700 });
  try {
    let recoveredTransition = false;
    const initialized = withOwnershipTransition(
      identity.lockPath,
      () => {
        if (
          recoveredTransition &&
          !existsSync(identity.metadataPath) &&
          !hasAnyOwnershipMarker(identity.lockPath)
        ) {
          rmSync(identity.lockPath, { recursive: true, force: true });
        }
        mkdirSync(identity.lockPath, { mode: 0o700 });
        writeOwnershipMarker(identity.lockPath, leaseToken);
        writeJsonAtomically(identity.metadataPath, ownedRecord);
        return true;
      },
      () => {
        recoveredTransition = true;
      },
    );
    if (!initialized) throw new Error("Project instance ownership transition is busy");
  } catch (error) {
    removeOwnedInstanceLock(identity, ownedRecord);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Project instance already running: ${identity.projectRoot}`, {
        cause: error,
      });
    }
    throw error;
  }
  let released = false;
  const release: LeaseRelease = Object.assign(
    () => {
      if (released) return;
      released = true;
      removeOwnedInstanceLock(identity, ownedRecord);
    },
    { leaseToken },
  );
  return release;
}

function ensureInstanceOwnerRecord(
  identity: ProjectInstanceIdentity,
  record: InstanceRecord | null,
  instanceId: string | undefined,
  leaseToken: string | undefined,
): InstanceRecord {
  if (!record || record.version !== 1 || !Number.isInteger(record.pid)) {
    throw new Error("Project instance metadata is incomplete");
  }
  if (
    record.projectRoot !== identity.projectRoot ||
    record.databasePath !== identity.databasePath
  ) {
    throw new Error("Project instance metadata belongs to another project");
  }
  if (
    (instanceId !== undefined && record.instanceId !== instanceId) ||
    (instanceId === undefined && record.instanceId !== undefined) ||
    record.leaseToken !== leaseToken
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
  leaseToken?: string,
): void {
  if (!isPositiveInteger(owner.pid)) throw new Error("Project owner PID is invalid");
  const promoted = withOwnershipTransition(identity.lockPath, () => {
    const record = ensureInstanceOwnerRecord(
      identity,
      readInstanceRecord(identity),
      instanceId,
      leaseToken,
    );
    writeJsonAtomically(identity.metadataPath, {
      ...record,
      pid: owner.pid,
      launcherPid: record.launcherPid ?? record.pid,
      serverPid: owner.pid,
      ...(owner.processGroupId === undefined ? {} : { processGroupId: owner.processGroupId }),
    });
    return true;
  });
  if (!promoted) throw new Error("Project instance ownership transition is busy");
}

function databaseReservationRecordPath(path: string): string {
  return join(path, "reservation.json");
}

function currentDatabaseLeaseToken(identity: ProjectInstanceIdentity): string | undefined | null {
  let token: string | undefined;
  let sawRecord = false;
  let sawLegacyRecord = false;
  for (const path of databaseReservationPathsForIdentity(identity)) {
    const record = readDatabaseReservation(path);
    if (record === null || record === "invalid") return null;
    sawRecord = true;
    if (record.leaseToken === undefined) {
      if (token !== undefined) return null;
      sawLegacyRecord = true;
      continue;
    }
    if (sawLegacyRecord || (token !== undefined && token !== record.leaseToken)) return null;
    token = record.leaseToken;
  }
  return sawRecord ? token : null;
}

export function databaseReservationPathsForIdentity(identity: ProjectInstanceIdentity): string[] {
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
  leaseToken?: string,
): void {
  if (!isPositiveInteger(owner.pid)) throw new Error("Database owner PID is invalid");
  const paths = databaseReservationPathsForIdentity(identity);
  const promoted = withOwnershipTransitions(paths, () => {
    if (paths.some((path) => !existsSync(databaseReservationRecordPath(path)))) {
      throw new Error(`Database reservation is missing: ${identity.databasePath}`);
    }
    for (const path of paths) {
      const metadataPath = databaseReservationRecordPath(path);
      const existing = readDatabaseReservation(path);
      if (existing === null || existing === "invalid") {
        throw new Error(`Database reservation is incomplete: ${identity.databasePath}`);
      }
      if (
        existing.projectRoot !== identity.projectRoot ||
        existing.databasePath !== identity.databasePath
      ) {
        throw new Error("Database reservation belongs to another project");
      }
      if (
        (instanceId !== undefined && existing.instanceId !== instanceId) ||
        (instanceId === undefined && existing.instanceId !== undefined) ||
        existing.leaseToken !== leaseToken
      ) {
        throw new Error("Database reservation belongs to another launcher");
      }
      writeJsonAtomically(metadataPath, {
        ...existing,
        pid: owner.pid,
        launcherPid: existing.launcherPid ?? existing.pid,
        serverPid: owner.pid,
        ...(owner.processGroupId === undefined ? {} : { processGroupId: owner.processGroupId }),
      });
    }
    return true;
  });
  if (!promoted) throw new Error("Database reservation ownership transition is busy");
}

function isDatabaseReservationRecord(value: unknown): value is DatabaseReservationRecord {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.projectRoot === "string" &&
    typeof value.databasePath === "string" &&
    isPositiveInteger(value.pid) &&
    isOptionalPositiveInteger(value.launcherPid) &&
    isOptionalPositiveInteger(value.serverPid) &&
    isOptionalPositiveInteger(value.processGroupId) &&
    isOptionalToken(value.instanceId) &&
    isOptionalToken(value.leaseToken) &&
    typeof value.reservedAt === "string"
  );
}

function readDatabaseReservation(path: string): DatabaseReservationRecord | "invalid" | null {
  const metadataPath = join(path, "reservation.json");
  if (!existsSync(metadataPath)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
    return isDatabaseReservationRecord(value) ? value : "invalid";
  } catch {
    return "invalid";
  }
}

function databaseReservationsMatchInstance(
  identity: ProjectInstanceIdentity,
  instance: InstanceRecord,
  probe: ProcessProbe,
): boolean {
  const paths = [identity.databaseLockPath, identity.databasePhysicalLockPath];
  // Los launchers anteriores no creaban la reserva de inode cuando la DB aún
  // no existía. Valídala si está presente, pero no conviertas esa ventana de
  // migración en un bloqueo permanente de un server saludable.
  if (identity.databaseInodeLockPath && existsSync(identity.databaseInodeLockPath)) {
    paths.push(identity.databaseInodeLockPath);
  }
  const reservations = paths.map((path) => readDatabaseReservation(path));
  let databaseLeaseToken: string | undefined;
  let sawLegacyReservation = false;
  for (const reservation of reservations) {
    if (
      reservation === null ||
      reservation === "invalid" ||
      reservation.projectRoot !== identity.projectRoot ||
      reservation.databasePath !== identity.databasePath ||
      reservation.instanceId !== instance.instanceId ||
      !processOwnerIsAlive(reservation, probe)
    ) {
      return false;
    }
    // El lease token de la reserva DB es distinto del token del lock de la
    // instancia. Solo exige que todas las reservas DB compartan su token.
    if (reservation.leaseToken === undefined) {
      if (databaseLeaseToken !== undefined) return false;
      sawLegacyReservation = true;
    } else {
      if (sawLegacyReservation) return false;
      if (databaseLeaseToken !== undefined && databaseLeaseToken !== reservation.leaseToken) {
        return false;
      }
      databaseLeaseToken = reservation.leaseToken;
    }
  }
  return true;
}

function retireIncompleteDatabaseReservation(path: string, recoveredTransition: boolean): boolean {
  return (
    withOwnershipTransition(path, () => {
      const current = readDatabaseReservation(path);
      if (current === "invalid" || current !== null) return false;
      // Un marcador solo demuestra que una adquisición empezó. No demuestra que
      // su owner terminó. La transición stale es la única prueba de un crash.
      if (!recoveredTransition) return false;
      rmSync(path, { recursive: true, force: true });
      return true;
    }) ?? false
  );
}

function removeOwnedDatabaseReservation(
  path: string,
  expected: Pick<
    DatabaseReservationRecord,
    "projectRoot" | "databasePath" | "instanceId" | "leaseToken" | "reservedAt"
  >,
): boolean {
  const leaseToken = expected.leaseToken;
  if (!leaseToken) return false;
  return (
    withOwnershipTransition(path, () => {
      const current = readDatabaseReservation(path);
      if (
        current !== null &&
        current !== "invalid" &&
        (current.projectRoot !== expected.projectRoot ||
          current.databasePath !== expected.databasePath ||
          current.reservedAt !== expected.reservedAt ||
          !leaseIdentityMatches(current, expected))
      ) {
        return false;
      }
      // Las adquisiciones actuales siempre publican un marcador privado. Si no
      // coincide, no existe una prueba de que esta llamada haya creado el lease.
      return removeOwnedLeaseDirectory(path, leaseToken);
    }) ?? false
  );
}

function databaseReservationSnapshotMatches(
  current: DatabaseReservationRecord | "invalid" | null,
  expected: DatabaseReservationRecord,
): current is DatabaseReservationRecord {
  return (
    current !== null &&
    current !== "invalid" &&
    current.version === 1 &&
    current.projectRoot === expected.projectRoot &&
    current.databasePath === expected.databasePath &&
    current.pid === expected.pid &&
    current.instanceId === expected.instanceId &&
    current.leaseToken === expected.leaseToken &&
    current.reservedAt === expected.reservedAt
  );
}

function retireDatabaseReservation(
  path: string,
  expected?: DatabaseReservationRecord,
  probe: ProcessProbe = processIsAlive,
): void {
  withOwnershipTransition(path, () => {
    const current = readDatabaseReservation(path);
    // Vuelve a comprobar el estado vivo mientras sostienes la transición. El
    // owner pudo promoverse después de la primera observación stale.
    if (current !== null && current !== "invalid" && processOwnerIsAlive(current, probe)) {
      return;
    }
    // Si la metadata desapareció durante una escritura, conserva el lock si el
    // owner que observamos todavía vive. El marcador no prueba que haya muerto.
    if (
      (current === null || current === "invalid") &&
      expected &&
      processOwnerIsAlive(expected, probe)
    ) {
      return;
    }
    if (!expected) return;
    if (expected.leaseToken !== undefined) {
      if (current === "invalid") return;
      if (
        current !== null &&
        (current.projectRoot !== expected.projectRoot ||
          current.databasePath !== expected.databasePath ||
          current.reservedAt !== expected.reservedAt ||
          !leaseIdentityMatches(current, expected))
      ) {
        return;
      }
      // Ya sostenemos esta transición. No vuelvas a adquirirla desde el
      // reaper: el owner de la transición actual es este proceso.
      if (removeOwnedLeaseDirectory(path, expected.leaseToken)) return;
      // Este caller no puede recuperar un marker faltante o de otro lease,
      // aunque algunos campos de metadata coincidan.
      return;
    }
    // Las reservas v1 sin token no tienen marker. Solo se pueden recuperar si
    // el snapshot completo sigue igual dentro de la transición.
    if (databaseReservationSnapshotMatches(current, expected)) {
      removeStaleLeaseDirectory(path);
    }
  });
}

export function acquireDatabaseReservation(
  identity: ProjectInstanceIdentity,
  record: DatabaseReservationRecord,
  probe: ProcessProbe = processIsAlive,
): LeaseRelease {
  const paths = databaseReservationPathsForIdentity(identity);
  const leaseToken = leaseTokenOrRandom(record.leaseToken);
  const ownedRecord: DatabaseReservationRecord = { ...record, leaseToken };
  for (const path of paths) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < paths.length + 1; attempt += 1) {
    const recoveredTransitions = new Set<string>();
    const created: string[] = [];
    try {
      const initialized = withOwnershipTransitions(
        paths,
        () => {
          for (const path of paths) {
            // Si recuperamos la transición stale de una escritura incompleta,
            // podemos retirar el directorio bajo la misma transición antes de
            // publicar la reserva nueva. No arrastres la prueba a otro intento.
            if (recoveredTransitions.has(path) && readDatabaseReservation(path) === null) {
              rmSync(path, { recursive: true, force: true });
            }
            mkdirSync(path, { mode: 0o700 });
            created.push(path);
            writeOwnershipMarker(path, leaseToken);
            writeJsonAtomically(join(path, "reservation.json"), ownedRecord);
          }
          return true;
        },
        (directory) => recoveredTransitions.add(directory),
      );
      if (!initialized) throw new Error("Database reservation ownership transition is busy");
      let released = false;
      const release: LeaseRelease = Object.assign(
        () => {
          if (released) return;
          released = true;
          // Cada reserva se elimina solo si todavía pertenece a esta adquisición.
          // Un launcher anterior no debe borrar una reserva que ya tomó otro proceso.
          for (const path of [...paths].reverse()) {
            removeOwnedDatabaseReservation(path, ownedRecord);
          }
        },
        { leaseToken },
      );
      return release;
    } catch (error) {
      for (const path of [...created].reverse()) {
        // No se puede limpiar un path cuyo token ya no se puede verificar.
        removeOwnedDatabaseReservation(path, ownedRecord);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const conflict = paths.find((path) => existsSync(path));
      if (!conflict) continue;
      const existing = readDatabaseReservation(conflict);
      if (existing === null || existing === "invalid") {
        if (retireIncompleteDatabaseReservation(conflict, recoveredTransitions.has(conflict))) {
          continue;
        }
        throw new Error(`Database reservation is incomplete: ${identity.databasePath}`);
      }
      if (processOwnerIsAlive(existing, probe)) {
        throw new Error(`Database is already reserved: ${identity.databasePath}`);
      }
      retireDatabaseReservation(conflict, existing, probe);
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
  /** Token privado que usan el release y el handoff de esta reserva. */
  leaseToken: string;
  /** Ruta de metadata que usa el child para reclamar el puerto durante el handoff. */
  metadataPath: string;
  promoteOwner: (owner: ProcessOwnership) => void;
  release: () => void;
}

interface PortReservationRecord {
  version: 1;
  port: number;
  /** PID del server después de transferir la propiedad desde el launcher. */
  pid: number;
  /** PID del launcher que creó la reserva. */
  launcherPid?: number;
  /** PID explícito del server para detectar un launcher huérfano. */
  serverPid?: number;
  /** PID del líder del grupo cuando el server está separado. */
  processGroupId?: number;
  /** Identidad de la instancia que usa esta reserva. */
  instanceId?: string;
  /** Token privado de la adquisición que puede retirar este lease. */
  leaseToken?: string;
  reservedAt: string;
}

function portReservationPath(homeDirectory: string, port: number): string {
  return join(resolve(homeDirectory), ".prime-board", "ports", `${port}.lock`);
}

function isPortReservationRecord(value: unknown): value is PortReservationRecord {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    isPositiveInteger(value.port) &&
    isPositiveInteger(value.pid) &&
    isOptionalPositiveInteger(value.launcherPid) &&
    isOptionalPositiveInteger(value.serverPid) &&
    isOptionalPositiveInteger(value.processGroupId) &&
    isOptionalToken(value.instanceId) &&
    isOptionalToken(value.leaseToken) &&
    typeof value.reservedAt === "string"
  );
}

function readPortReservation(path: string): PortReservationRecord | "invalid" | null {
  const metadataPath = join(path, "reservation.json");
  if (!existsSync(metadataPath)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
    return isPortReservationRecord(value) ? value : "invalid";
  } catch {
    return "invalid";
  }
}

function retireIncompletePortReservation(path: string, recoveredTransition: boolean): boolean {
  return (
    withOwnershipTransition(path, () => {
      const current = readPortReservation(path);
      if (current === "invalid" || current !== null) return false;
      // Un marcador solo demuestra que una adquisición empezó. No demuestra que
      // su owner terminó. La transición stale es la única prueba de un crash.
      if (!recoveredTransition) return false;
      rmSync(path, { recursive: true, force: true });
      return true;
    }) ?? false
  );
}

function portReservationBelongsTo(
  current: PortReservationRecord | "invalid" | null,
  expected: PortReservationRecord,
): current is PortReservationRecord {
  if (
    current === null ||
    current === "invalid" ||
    current.version !== 1 ||
    current.port !== expected.port
  ) {
    return false;
  }
  if (expected.leaseToken === undefined && current.leaseToken !== undefined) return false;
  if (expected.instanceId !== undefined && current.instanceId !== expected.instanceId) {
    return false;
  }
  if (expected.instanceId === undefined && current.instanceId !== undefined) return false;
  if (expected.leaseToken !== undefined && current.leaseToken !== expected.leaseToken) {
    return false;
  }
  if (expected.instanceId !== undefined || expected.leaseToken !== undefined) return true;
  return current.instanceId === undefined && current.reservedAt === expected.reservedAt;
}

function removeOwnedPortReservation(
  path: string,
  expected: Pick<PortReservationRecord, "port" | "instanceId" | "leaseToken" | "reservedAt">,
): boolean {
  const leaseToken = expected.leaseToken;
  if (!leaseToken) return false;
  return (
    withOwnershipTransition(path, () => {
      const current = readPortReservation(path);
      if (
        current !== null &&
        current !== "invalid" &&
        (current.port !== expected.port ||
          current.reservedAt !== expected.reservedAt ||
          !leaseIdentityMatches(current, expected))
      ) {
        return false;
      }
      // Las adquisiciones actuales siempre publican un marcador privado. Si no
      // coincide, no existe una prueba de que esta llamada haya creado el lease.
      return removeOwnedLeaseDirectory(path, leaseToken);
    }) ?? false
  );
}

function legacyPortReservationSnapshotMatches(
  current: PortReservationRecord | "invalid" | null,
  expected: PortReservationRecord,
): current is PortReservationRecord {
  return (
    current !== null &&
    current !== "invalid" &&
    current.version === 1 &&
    current.port === expected.port &&
    current.pid === expected.pid &&
    current.instanceId === expected.instanceId &&
    current.leaseToken === expected.leaseToken &&
    current.reservedAt === expected.reservedAt
  );
}

function retirePortReservation(
  path: string,
  expected?: PortReservationRecord,
  probe: ProcessProbe = processIsAlive,
): void {
  withOwnershipTransition(path, () => {
    const current = readPortReservation(path);
    // Vuelve a comprobar el estado vivo mientras sostienes la transición. El
    // owner pudo promoverse después de la primera observación stale.
    if (current !== null && current !== "invalid" && processOwnerIsAlive(current, probe)) {
      return;
    }
    // Si la metadata desapareció durante una escritura, conserva el lock si el
    // owner que observamos todavía vive. El marcador no prueba que haya muerto.
    if (
      (current === null || current === "invalid") &&
      expected &&
      processOwnerIsAlive(expected, probe)
    ) {
      return;
    }
    if (!expected) return;
    if (expected.leaseToken !== undefined) {
      if (current === "invalid") return;
      if (
        current !== null &&
        (current.port !== expected.port ||
          current.reservedAt !== expected.reservedAt ||
          !leaseIdentityMatches(current, expected))
      ) {
        return;
      }
      // Ya sostenemos esta transición. No vuelvas a adquirirla desde el
      // reaper: el owner de la transición actual es este proceso.
      if (removeOwnedLeaseDirectory(path, expected.leaseToken)) return;
      // Este caller no puede recuperar un marker faltante o de otro lease,
      // aunque algunos campos de metadata coincidan.
      return;
    }
    // Las reservas v1 sin token no tienen marker. Solo se pueden recuperar si
    // el snapshot completo sigue igual dentro de la transición.
    if (legacyPortReservationSnapshotMatches(current, expected)) {
      removeStaleLeaseDirectory(path);
    }
  });
}

function acquirePortReservation(
  homeDirectory: string,
  port: number,
  instanceId?: string,
): PortReservation | null {
  const path = portReservationPath(homeDirectory, port);
  const leaseToken = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let recoveredTransition = false;
    try {
      const record: PortReservationRecord = {
        version: 1,
        port,
        pid: process.pid,
        launcherPid: process.pid,
        ...(instanceId === undefined ? {} : { instanceId }),
        leaseToken,
        reservedAt: new Date().toISOString(),
      };
      const initialized = withOwnershipTransition(
        path,
        () => {
          mkdirSync(path, { mode: 0o700 });
          writeOwnershipMarker(path, leaseToken);
          writeJsonAtomically(join(path, "reservation.json"), record);
          return true;
        },
        () => {
          recoveredTransition = true;
        },
      );
      if (!initialized) throw new Error("Port reservation ownership transition is busy");
      let released = false;
      const release: PortReservation["release"] = () => {
        if (released) return;
        released = true;
        removeOwnedPortReservation(path, record);
      };
      const promoteOwner = (owner: ProcessOwnership) => {
        if (!isPositiveInteger(owner.pid)) throw new Error("Port owner PID is invalid");
        const promoted = withOwnershipTransition(path, () => {
          const current = readPortReservation(path);
          if (!portReservationBelongsTo(current, record)) {
            throw new Error("Port reservation belongs to another launcher");
          }
          writeJsonAtomically(join(path, "reservation.json"), {
            ...current,
            pid: owner.pid,
            launcherPid: current.launcherPid ?? current.pid,
            serverPid: owner.pid,
            ...(owner.processGroupId === undefined ? {} : { processGroupId: owner.processGroupId }),
          });
          return true;
        });
        if (!promoted) throw new Error("Port reservation ownership transition is busy");
      };
      return {
        port,
        leaseToken,
        metadataPath: join(path, "reservation.json"),
        promoteOwner,
        release,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // Sin token no se puede verificar el path. Déjalo ocupado en vez de
        // borrar una reserva creada por otro proceso.
        removeOwnedLeaseDirectory(path, leaseToken);
        throw error;
      }
      const record = readPortReservation(path);
      // Una reserva legacy con metadata malformed queda ocupada. Una reserva
      // nueva se puede recuperar cuando su marker o transición stale prueba que
      // su creator se detuvo durante la inicialización.
      if (record === null || record === "invalid") {
        if (retireIncompletePortReservation(path, recoveredTransition)) continue;
        return null;
      }
      if (processOwnerIsAlive(record, processIsAlive)) return null;
      retirePortReservation(path, record);
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
  instanceId?: string,
): Promise<PortReservation> {
  for (let port = preferredPort; port <= 65535; port += 1) {
    const reservation = acquirePortReservation(homeDirectory, port, instanceId);
    if (!reservation) {
      if (explicit) throw new Error(`Port ${preferredPort} is already in use`);
      continue;
    }
    let available = false;
    try {
      available = await probe(port);
    } catch (error) {
      reservation.release();
      throw error;
    }
    if (available) return reservation;
    reservation.release();
    if (explicit) throw new Error(`Port ${preferredPort} is already in use`);
  }
  throw new Error(`No available port found after ${preferredPort}`);
}
