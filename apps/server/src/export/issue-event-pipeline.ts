import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EVENT_LOG_RELATIVE_PATH,
  EventLogWriter,
  type AppendResult,
  type DomainEvent,
  type EventLogOptions,
  validateDomainEvent,
} from "./event-log.ts";
import type { ProjectorCheckpoint } from "./projector.ts";

/** Writer mínimo que necesita el bridge de Activity y el pipeline. */
export interface CanonicalEventLog {
  appendMany(eventInputs: readonly unknown[]): AppendResult[];
  read(): DomainEvent[];
  /** Remove a torn JSONL tail before the next append/retry when supported. */
  recover?(): void;
}

export interface GitCommitInput {
  readonly rootDir: string;
  readonly eventIds: readonly string[];
}

/** Seam para hacer durable el append antes de proyectarlo. */
export type GitCommitter = (input: GitCommitInput) => void;

/** Proyección SQLite de esta slice. No conoce el driver de la base. */
export interface IssueEventProjector {
  apply(event: DomainEvent): void;
}

/**
 * Checkpoint sync para el runtime SQLite. PostgreSQL usa su adapter async.
 * El pipeline usa memoria por defecto; el runtime productivo debe inyectar un
 * store durable antes de tratar el checkpoint como estado operativo.
 */
export interface IssueEventCheckpointStore {
  load(stream: string): ProjectorCheckpoint | undefined;
  save(checkpoint: ProjectorCheckpoint): void;
}

export interface IssueEventPipelineOptions extends EventLogOptions {
  readonly stream?: string;
  readonly eventLog?: CanonicalEventLog;
  readonly commitGit?: GitCommitter;
  readonly projector?: IssueEventProjector;
  readonly checkpointStore?: IssueEventCheckpointStore;
}

export interface IssueEventProjectionResult {
  readonly applied: number;
  readonly skipped: number;
  readonly checkpoint: ProjectorCheckpoint | undefined;
}

const DEFAULT_STREAM = "issues";

function checkpointFor(stream: string, event: DomainEvent): ProjectorCheckpoint {
  return { stream, eventId: event.eventId, occurredAt: event.occurredAt };
}

function isAfterCheckpoint(event: DomainEvent, checkpoint: ProjectorCheckpoint): boolean {
  const eventTime = Date.parse(event.occurredAt);
  const checkpointTime = Date.parse(checkpoint.occurredAt);
  return (
    eventTime > checkpointTime ||
    (eventTime === checkpointTime &&
      (event.occurredAt > checkpoint.occurredAt ||
        (event.occurredAt === checkpoint.occurredAt && event.eventId > checkpoint.eventId)))
  );
}

function validateStream(stream: string): void {
  if (!stream.trim() || /[\r\n]/u.test(stream)) {
    throw new Error("Issue event stream must be a non-empty safe string");
  }
}

function validateCheckpoint(checkpoint: ProjectorCheckpoint, stream: string): void {
  if (
    checkpoint.stream !== stream ||
    !checkpoint.stream.trim() ||
    !checkpoint.eventId.trim() ||
    /[\r\n]/u.test(checkpoint.stream) ||
    /[\r\n]/u.test(checkpoint.eventId) ||
    !Number.isFinite(Date.parse(checkpoint.occurredAt))
  ) {
    throw new Error("Issue event checkpoint is invalid");
  }
}

class MemoryCheckpointStore implements IssueEventCheckpointStore {
  private checkpoint: ProjectorCheckpoint | undefined;

  load(_stream: string): ProjectorCheckpoint | undefined {
    return this.checkpoint;
  }

  save(checkpoint: ProjectorCheckpoint): void {
    this.checkpoint = checkpoint;
  }
}

const NOOP_PROJECTOR: IssueEventProjector = {
  apply: () => undefined,
};

const NOOP_COMMITTER: GitCommitter = () => undefined;

// A RepoSync call can hold this lock while the committer acquires it again.
// Keep that nested call in-process reentrant while the file lock coordinates
// writers from separate server processes.
const heldEventLogLocks = new Set<string>();

/**
 * Pipeline de una mutación SQLite: append durable, commit Git, projector y
 * checkpoint. El caller decide cuándo regenerar snapshots. Este es un seam de
 * runtime: por defecto usa un projector noop y un checkpoint en memoria; no
 * convierte al Repository Source en autoridad ni implementa el proyector PG.
 */
export class IssueEventPipeline {
  readonly eventLog: CanonicalEventLog;
  readonly rootDir: string;
  readonly stream: string;

  private readonly commitGit: GitCommitter;
  private readonly projector: IssueEventProjector;
  private readonly checkpointStore: IssueEventCheckpointStore;
  private readonly pendingEventIds = new Set<string>();
  private checkpoint: ProjectorCheckpoint | undefined;
  private checkpointLoaded = false;

  constructor(options: IssueEventPipelineOptions) {
    const stream = options.stream ?? DEFAULT_STREAM;
    validateStream(stream);
    this.rootDir = options.rootDir ?? process.cwd();
    this.stream = stream;
    this.eventLog =
      options.eventLog ?? new EventLogWriter({ rootDir: this.rootDir, filePath: options.filePath });
    this.commitGit = options.commitGit ?? NOOP_COMMITTER;
    this.projector = options.projector ?? NOOP_PROJECTOR;
    this.checkpointStore = options.checkpointStore ?? new MemoryCheckpointStore();
  }

  /** Agrega eventos validados e idempotentes al log canónico. */
  append(events: readonly DomainEvent[]): readonly AppendResult[] {
    this.eventLog.recover?.();
    const before = new Set(this.eventLog.read().map((event) => event.eventId));
    try {
      const results = this.eventLog.appendMany(events);
      // Keep idempotent IDs as candidates too: a prior process may have
      // appended them before its Git commit failed. The Git committer checks
      // which candidates are still in the working-tree delta.
      for (const result of results) this.pendingEventIds.add(result.eventId);
      return results;
    } catch (error) {
      const after = new Set(this.eventLog.read().map((event) => event.eventId));
      for (const event of events) {
        if (!before.has(event.eventId) && after.has(event.eventId)) {
          this.pendingEventIds.add(event.eventId);
        }
      }
      throw error;
    }
  }

  /** Registra candidatos del bridge Activity antes de un append que puede fallar. */
  recordPendingEventIds(eventIds: readonly string[]): void {
    for (const eventId of eventIds) {
      if (eventId.trim()) this.pendingEventIds.add(eventId);
    }
  }

  /** Hace commit solo de eventos nuevos después de que el append terminó. */
  commit(eventIds: readonly string[] = [...this.pendingEventIds]): void {
    this.recordPendingEventIds(eventIds);
    const pending = [...this.pendingEventIds];
    if (pending.length === 0) return;
    this.commitGit({ rootDir: this.rootDir, eventIds: pending });
    const present = new Set(this.eventLog.read().map((event) => event.eventId));
    for (const eventId of pending) {
      if (present.has(eventId)) this.pendingEventIds.delete(eventId);
    }
  }

  /**
   * Proyecta desde el último checkpoint. Un error de apply o save deja el
   * checkpoint anterior intacto para que el mismo evento se pueda reintentar.
   */
  project(): IssueEventProjectionResult {
    // El log canónico también contiene eventos de metadata. Este pipeline
    // solo es dueño del stream de Issues y nunca debe aplicar otros agregados.
    const events = this.eventLog.read().filter((event) => event.aggregate === "issue");
    let checkpoint = this.checkpoint;
    if (!this.checkpointLoaded) {
      const loaded = this.checkpointStore.load(this.stream);
      if (loaded) validateCheckpoint(loaded, this.stream);
      checkpoint = loaded;
      this.checkpoint = loaded;
      this.checkpointLoaded = true;
    }

    let applied = 0;
    let skipped = 0;
    for (const event of events) {
      if (checkpoint && !isAfterCheckpoint(event, checkpoint)) {
        skipped += 1;
        continue;
      }
      this.projector.apply(event);
      const next = checkpointFor(this.stream, event);
      // Save primero: si falla, no se mueve el cursor en memoria.
      this.checkpointStore.save(next);
      checkpoint = next;
      this.checkpoint = next;
      applied += 1;
    }
    return { applied, skipped, checkpoint };
  }

  getCheckpoint(): ProjectorCheckpoint | undefined {
    return this.checkpoint;
  }
}

/**
 * Adapter opcional para repos Git reales. Un root que no es un repositorio se
 * trata como fixture de tests y no requiere commit.
 */
export function createGitCommitter(rootDir: string): GitCommitter {
  return ({ eventIds }) => {
    if (eventIds.length === 0 || !existsSync(join(rootDir, ".git"))) return;
    withCanonicalEventLogLock(rootDir, () => {
      assertEventLogIndexIsClean(rootDir);
      const delta = validateEventLogDelta(rootDir, eventIds);
      if (delta.eventIds.size === 0) return;
      commitEventLogSnapshot(rootDir, delta.content);
    });
  };
}

/**
 * Commit the validated bytes through an alternate index. The real index and
 * the working tree stay untouched, so a concurrent append cannot be swept
 * into this commit by `git add`.
 */
function commitEventLogSnapshot(rootDir: string, content: string): void {
  const originalIndexEntry = readEventLogIndexEntry(rootDir);
  const tempDir = mkdtempSync(join(tmpdir(), "prime-board-event-index-"));
  const tempIndex = join(tempDir, "index");
  const env = { GIT_INDEX_FILE: tempIndex };
  try {
    assertEventLogSnapshotUnchanged(rootDir, content);
    const parent = readGitHead(rootDir);
    runGit(rootDir, ["read-tree", parent ?? "--empty"], env);
    const blob = hashEventLog(rootDir, content);
    runGit(
      rootDir,
      ["update-index", "--add", "--cacheinfo", `100644,${blob},${EVENT_LOG_RELATIVE_PATH}`],
      env,
    );
    // Reject a concurrent append or commit before creating the commit tree.
    assertEventLogSnapshotUnchanged(rootDir, content);
    if (readGitHead(rootDir) !== parent) {
      throw new Error("Git HEAD changed during canonical event commit");
    }
    const tree = runGitOutput(rootDir, ["write-tree"], env).trim();
    const commit = createGitCommit(rootDir, tree, parent);
    // Mantiene el lock del índice Git durante la comparación final, la
    // actualización de la referencia y la sincronización. Un `git add`
    // concurrente se conserva o falla antes de mover HEAD; no se reemplaza
    // entre la comparación y la actualización.
    const indexPath = resolveGitIndexPath(rootDir);
    withRealGitIndexLock(rootDir, indexPath, () => {
      const refreshIndex = readEventLogIndexEntry(rootDir) === originalIndexEntry;
      // The expected old ref makes a concurrent commit fail closed instead of
      // creating a child commit that could drop its event-log changes.
      runGit(rootDir, [
        "update-ref",
        "-m",
        "chore(events): append canonical issue events",
        "HEAD",
        commit,
        parent ?? "",
      ]);
      if (refreshIndex) updateRealEventLogIndex(rootDir, indexPath, blob);
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Serializa el append y el commit del Log entre writers del mismo repo.
 *
 * El lock vive junto al índice del worktree, no en el checkout, para que dos
 * worktrees del mismo repositorio no compartan accidentalmente el estado de
 * coordinación. Es reentrante dentro de un proceso porque `RepoSync` lo toma
 * alrededor de append+commit y el committer lo toma como defensa adicional.
 */
export function withCanonicalEventLogLock<T>(rootDir: string, operation: () => T): T {
  if (!existsSync(join(rootDir, ".git"))) return operation();

  const lockPath = `${resolveGitIndexPath(rootDir)}.prime-board-event-log.lock`;
  if (heldEventLogLocks.has(lockPath)) return operation();

  const lockFd = acquireCanonicalEventLogLock(lockPath);
  heldEventLogLocks.add(lockPath);
  try {
    return operation();
  } finally {
    heldEventLogLocks.delete(lockPath);
    closeSync(lockFd);
    unlinkIfPresent(lockPath);
  }
}

const CANONICAL_LOCK_WAIT_MS = 30_000;
const CANONICAL_LOCK_POLL_MS = 10;
const CANONICAL_LOCK_RECOVERY_SUFFIX = ".recovery";

/** Adquiere el lock con una creación atómica que también escribe el PID dueño. */
function acquireCanonicalEventLogLock(lockPath: string): number {
  const deadline = Date.now() + CANONICAL_LOCK_WAIT_MS;
  const recoveryPath = `${lockPath}${CANONICAL_LOCK_RECOVERY_SUFFIX}`;
  while (true) {
    if (waitForCanonicalLockRecovery(recoveryPath)) {
      waitForCanonicalLock();
      continue;
    }

    const temporaryPath = `${lockPath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}`;
    let temporaryFd: number | undefined;
    try {
      temporaryFd = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeSync(temporaryFd, `pid=${process.pid}\n`, undefined, "utf8");
      closeSync(temporaryFd);
      temporaryFd = undefined;
      let created = false;
      try {
        // link(2) fails atomically when another writer owns the lock; rename
        // would replace that writer's lock on POSIX.
        linkSync(temporaryPath, lockPath);
        created = true;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
      } finally {
        unlinkIfPresent(temporaryPath);
      }
      if (created) return openSync(lockPath, constants.O_RDONLY);
    } finally {
      if (temporaryFd !== undefined) closeSync(temporaryFd);
      unlinkIfPresent(temporaryPath);
    }

    const owner = readCanonicalLockOwner(lockPath);
    if (owner === undefined) {
      // The owner can release the lock between link(2) and this read.
      continue;
    }
    if (!isProcessAlive(owner) && tryReclaimCanonicalEventLogLock(lockPath, owner)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Cannot lock canonical event log: writer ${owner} did not release the lock`);
    }
    waitForCanonicalLock();
  }
}

/**
 * Reclaims a stale lock without letting two reapers delete different
 * generations of the same path. The recovery marker is an atomic, exclusive
 * claim. It also blocks later reapers until the first one finishes.
 */
function tryReclaimCanonicalEventLogLock(lockPath: string, expectedOwner: number): boolean {
  const recoveryPath = `${lockPath}${CANONICAL_LOCK_RECOVERY_SUFFIX}`;
  if (!tryCreateCanonicalRecoveryMarker(recoveryPath)) return false;

  try {
    const currentOwner = readCanonicalLockOwner(lockPath);
    if (currentOwner === undefined) return true;
    if (currentOwner !== expectedOwner || isProcessAlive(currentOwner)) return false;

    const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}`;
    try {
      // The recovery marker prevents another reaper from changing the path
      // between this identity check and the atomic rename.
      renameSync(lockPath, stalePath);
    } catch (error) {
      if (isFileMissingError(error)) return true;
      throw error;
    }
    rmSync(stalePath, { force: true });
    return true;
  } finally {
    rmSync(recoveryPath, { recursive: true, force: true });
  }
}

function tryCreateCanonicalRecoveryMarker(recoveryPath: string): boolean {
  try {
    mkdirSync(recoveryPath, 0o700);
    writeFileSync(join(recoveryPath, "owner"), `pid=${process.pid}\n`, {
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if (isFileExistsError(error)) return false;
    rmSync(recoveryPath, { recursive: true, force: true });
    throw error;
  }
}

/** Waits for a live recovery claim or atomically removes a stale one. */
function waitForCanonicalLockRecovery(recoveryPath: string): boolean {
  if (!existsSync(recoveryPath)) return false;

  const owner = readCanonicalRecoveryOwner(recoveryPath);
  if (owner !== undefined && isProcessAlive(owner)) return true;

  const stalePath = `${recoveryPath}.stale.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    // Only one waiter can rename this generation. A later generation has a
    // different path and is never removed by this cleanup.
    renameSync(recoveryPath, stalePath);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
    return true;
  }
  rmSync(stalePath, { recursive: true, force: true });
  return true;
}

function readCanonicalRecoveryOwner(recoveryPath: string): number | undefined {
  let content: string;
  try {
    content = readFileSync(join(recoveryPath, "owner"), "utf8").trim();
  } catch (error) {
    if (isFileMissingError(error)) {
      throw new Error("Cannot recover canonical event log lock: owner metadata is missing");
    }
    throw error;
  }
  const match = /^pid=(\d+)$/u.exec(content);
  if (!match) {
    throw new Error("Cannot recover canonical event log lock: owner metadata is invalid");
  }
  return Number(match[1]);
}

function readCanonicalLockOwner(lockPath: string): number | undefined {
  let content: string;
  try {
    content = readFileSync(lockPath, "utf8").trim();
  } catch (error) {
    if (isFileMissingError(error)) return undefined;
    throw error;
  }
  const match = /^pid=(\d+)$/u.exec(content);
  if (!match) {
    throw new Error("Cannot lock canonical event log: lock owner metadata is invalid");
  }
  return Number(match[1]);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeFsError(error, "ESRCH");
  }
}

function isFileExistsError(error: unknown): boolean {
  return isNodeFsError(error, "EEXIST");
}

function isFileMissingError(error: unknown): boolean {
  return isNodeFsError(error, "ENOENT");
}

function isNodeFsError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
  }
}

function waitForCanonicalLock(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CANONICAL_LOCK_POLL_MS);
}

function resolveGitIndexPath(rootDir: string): string {
  const indexPath = runGitOutput(rootDir, ["rev-parse", "--git-path", "index"]).trim();
  if (!indexPath) throw new Error("Git returned an empty index path");
  return resolve(rootDir, indexPath);
}

/** Ejecuta una operación con el lock exclusivo del índice Git real. */
function withRealGitIndexLock<T>(rootDir: string, indexPath: string, operation: () => T): T {
  const lockPath = `${indexPath}.lock`;
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    throw new Error(`Cannot lock Git index: ${String(error)}`);
  }

  try {
    return operation();
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (!(
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }
}

/** Actualiza solo la entrada del event log en una copia del índice real. */
function updateRealEventLogIndex(rootDir: string, indexPath: string, blob: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "prime-board-real-index-"));
  const tempIndex = join(tempDir, "index");
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    if (existsSync(indexPath)) {
      copyFileSync(indexPath, tempIndex);
    } else {
      const parent = readGitHead(rootDir);
      runGit(rootDir, ["read-tree", parent ?? "--empty"], env);
    }
    runGit(
      rootDir,
      ["update-index", "--add", "--cacheinfo", `100644,${blob},${EVENT_LOG_RELATIVE_PATH}`],
      env,
    );
    renameSync(tempIndex, indexPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertEventLogSnapshotUnchanged(rootDir: string, content: string): void {
  const path = join(rootDir, EVENT_LOG_RELATIVE_PATH);
  if (readFileSync(path, "utf8") !== content) {
    throw new Error("Canonical event log changed during validation");
  }
}

function hashEventLog(rootDir: string, content: string): string {
  const result = spawnSync("git", ["-C", rootDir, "hash-object", "-w", "--stdin"], {
    encoding: "utf8",
    input: content,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Cannot hash canonical event log");
  }
  const blob = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(blob)) throw new Error("Git returned an invalid event log blob");
  return blob;
}

function readGitHead(rootDir: string): string | undefined {
  const result = spawnSync("git", ["-C", rootDir, "rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 128) return undefined;
  throw new Error(result.stderr.trim() || "Cannot inspect Git HEAD");
}

function runGitOutput(
  rootDir: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
): string {
  const result = spawnSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: environment ? { ...process.env, ...environment } : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
  }
  return result.stdout;
}

function createGitCommit(rootDir: string, tree: string, parent: string | undefined): string {
  const args = ["-C", rootDir, "commit-tree", tree];
  if (parent) args.push("-p", parent);
  args.push("-F", "-");
  const result = spawnSync("git", args, {
    encoding: "utf8",
    input: "chore(events): append canonical issue events\n",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Cannot create canonical event commit");
  }
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("Git returned an invalid event commit");
  return commit;
}

function readEventLogIndexEntry(rootDir: string): string | undefined {
  const result = spawnSync(
    "git",
    ["-C", rootDir, "ls-files", "--stage", "--", EVENT_LOG_RELATIVE_PATH],
    {
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Cannot inspect Git index");
  }
  const entry = result.stdout.trim();
  return entry || undefined;
}

function assertEventLogIndexIsClean(rootDir: string): void {
  const status = spawnSync(
    "git",
    ["-C", rootDir, "diff", "--cached", "--quiet", "--", EVENT_LOG_RELATIVE_PATH],
    { encoding: "utf8" },
  );
  if (status.error) throw status.error;
  if (status.status === 1) {
    throw new Error("Canonical event log already has staged changes");
  }
  if (status.status !== 0) {
    throw new Error(status.stderr.trim() || "Cannot inspect staged canonical event log");
  }
}

interface EventLogDelta {
  readonly content: string;
  readonly eventIds: ReadonlySet<string>;
}

/**
 * Verify that the working-tree change is an append of only expected events.
 * The validated bytes are returned so a later Git operation cannot reread a
 * concurrently changed working tree and capture an unrelated append.
 */
function validateEventLogDelta(
  rootDir: string,
  expectedEventIds: readonly string[],
): EventLogDelta {
  const path = join(rootDir, EVENT_LOG_RELATIVE_PATH);
  if (!existsSync(path)) throw new Error("Canonical event log is missing");
  const current = readFileSync(path, "utf8");
  const base = readHeadEventLog(rootDir);
  if (base && !current.startsWith(base)) {
    throw new Error("Canonical event log changed outside an append-only delta");
  }
  if (base && !base.endsWith("\n") && current.length > base.length) {
    throw new Error("Canonical event log base is not newline-terminated");
  }
  const delta = base ? current.slice(base.length) : current;
  if (delta.length === 0) return { content: current, eventIds: new Set() };
  const expected = new Set(expectedEventIds);
  const changed = new Set<string>();
  const lines = delta.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (!line) throw new Error("Canonical event log contains an empty appended line");
    let event: DomainEvent;
    try {
      event = validateDomainEvent(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`Canonical event log contains an invalid appended line: ${String(error)}`);
    }
    if (!expected.has(event.eventId)) {
      throw new Error(`Canonical event log contains an unexpected event: ${event.eventId}`);
    }
    changed.add(event.eventId);
  }
  return { content: current, eventIds: changed };
}

function readHeadEventLog(rootDir: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "prime-board-head-event-log-"));
  const outputPath = join(tempDir, "events.jsonl");
  let outputFd: number | undefined;
  try {
    outputFd = openSync(
      outputPath,
      constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY,
      0o600,
    );
    const result = spawnSync("git", ["-C", rootDir, "show", `HEAD:${EVENT_LOG_RELATIVE_PATH}`], {
      encoding: "utf8",
      stdio: ["ignore", outputFd, "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status === 0) return readFileSync(outputPath, "utf8");
    if (result.status === 128) return "";
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr || "Cannot read HEAD event log");
  } finally {
    if (outputFd !== undefined) closeSync(outputFd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runGit(rootDir: string, args: readonly string[], environment?: NodeJS.ProcessEnv): void {
  const result = spawnSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: environment ? { ...process.env, ...environment } : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
  }
}
