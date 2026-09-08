import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
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
  /** Captures/restores the append bytes for an aborted mutation when supported. */
  snapshot?(): unknown;
  restore?(snapshot: unknown): void;
}

export interface CanonicalEventLogLease {
  /** Root cuyo lock del event log canónico posee este lease. */
  readonly rootDir: string;
  /** Ejecuta una operación síncrona mientras este lease está retenido. */
  run<T>(operation: () => T): T;
  /** Libera el lease. Se puede llamar más de una vez. */
  release(): void;
}

export interface GitCommitInput {
  readonly rootDir: string;
  readonly eventIds: readonly string[];
  /** Lease existente cuando el commit forma parte de una sección mayor. */
  readonly lock?: CanonicalEventLogLease;
}

/** Compensates a published event commit while its canonical lease is held. */
export type GitCommitRollback = () => void;

/** Seam para hacer durable el append antes de proyectarlo. */
export type GitCommitter = (input: GitCommitInput) => unknown;

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

// El lease puede abarcar un resolver GraphQL async. AsyncLocalStorage mantiene
// reentrantes las llamadas síncronas anidadas (committer y tests existentes) sin
// permitir que otro request del proceso tome prestado el lease por accidente.
interface CanonicalLockContextEntry {
  readonly isActive: () => boolean;
}

const canonicalLockContext = new AsyncLocalStorage<
  ReadonlyMap<string, CanonicalLockContextEntry>
>();

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

  /** Captures the event-log bytes before a mutation starts appending. */
  captureEventLog(): unknown {
    return this.eventLog.snapshot?.();
  }

  /**
   * Discards only the append made by an aborted mutation. Pending IDs from a
   * previous failed commit remain available for a later retry.
   */
  restoreEventLog(snapshot: unknown): void {
    if (snapshot === undefined || !this.eventLog.restore) return;
    this.eventLog.restore(snapshot);
    const present = new Set(this.eventLog.read().map((event) => event.eventId));
    for (const eventId of this.pendingEventIds) {
      if (!present.has(eventId)) this.pendingEventIds.delete(eventId);
    }
  }

  /** Hace commit solo de eventos nuevos después de que el append terminó. */
  commit(
    eventIds: readonly string[] = [...this.pendingEventIds],
    lock?: CanonicalEventLogLease,
  ): GitCommitRollback | undefined {
    this.recordPendingEventIds(eventIds);
    const pending = [...this.pendingEventIds];
    if (pending.length === 0) return undefined;
    const committed = this.commitGit({ rootDir: this.rootDir, eventIds: pending, lock });
    const rollback = typeof committed === "function" ? (committed as GitCommitRollback) : undefined;
    const present = new Set(this.eventLog.read().map((event) => event.eventId));
    for (const eventId of pending) {
      if (present.has(eventId)) this.pendingEventIds.delete(eventId);
    }
    return rollback;
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
  return ({ eventIds, lock }) => {
    if (eventIds.length === 0 || !existsSync(join(rootDir, ".git"))) return;
    if (lock && lock.rootDir !== rootDir) {
      throw new Error("Canonical event-log lease belongs to a different repository");
    }
    const commit = () => {
      assertEventLogIndexIsClean(rootDir);
      const delta = validateEventLogDelta(rootDir, eventIds);
      if (delta.eventIds.size === 0) return undefined;
      return commitEventLogSnapshot(rootDir, delta.content);
    };
    if (lock) return lock.run(commit);
    return withCanonicalEventLogLock(rootDir, commit);
  };
}

/**
 * Hace commit de bytes validados mediante un índice alternativo. El índice
 * real y el working tree quedan intactos, así un append concurrente no entra
 * en este commit mediante `git add`.
 */
function commitEventLogSnapshot(rootDir: string, content: string): GitCommitRollback {
  const originalIndexEntry = readEventLogIndexEntry(rootDir);
  const tempDir = mkdtempSync(join(tmpdir(), "prime-board-event-index-"));
  const tempIndex = join(tempDir, "index");
  const env = { GIT_INDEX_FILE: tempIndex };
  let refreshIndex = false;
  let published = false;
  let commit: string | undefined;
  let parent: string | undefined;
  try {
    assertEventLogSnapshotUnchanged(rootDir, content);
    parent = readGitHead(rootDir);
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
    commit = createGitCommit(rootDir, tree, parent);
    // Mantiene el lock del índice Git durante la comparación final, la
    // actualización de la referencia y la sincronización. Un `git add`
    // concurrente se conserva o falla antes de mover HEAD; no se reemplaza
    // entre la comparación y la actualización.
    const indexPath = resolveGitIndexPath(rootDir);
    withRealGitIndexLock(rootDir, indexPath, () => {
      refreshIndex = readEventLogIndexEntry(rootDir) === originalIndexEntry;
      // The expected old ref makes a concurrent commit fail closed instead of
      // creating a child commit that could drop its event-log changes.
      runGit(rootDir, [
        "update-ref",
        "-m",
        "chore(events): append canonical issue events",
        "HEAD",
        commit!,
        parent ?? "",
      ]);
      if (refreshIndex) updateRealEventLogIndex(rootDir, indexPath, blob);
    });
    published = true;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  let undone = false;
  return () => {
    if (undone || !published || !commit) return;
    const indexPath = resolveGitIndexPath(rootDir);
    withRealGitIndexLock(rootDir, indexPath, () => {
      if (readGitHead(rootDir) !== commit) {
        throw new Error("Cannot compensate canonical event commit after HEAD changed");
      }
      // The expected old ref makes compensation fail closed instead of
      // moving another writer's commit backwards.
      runGit(rootDir, ["update-ref", "HEAD", parent ?? "", commit!]);
      if (refreshIndex) restoreRealEventLogIndex(rootDir, indexPath, originalIndexEntry);
    });
    undone = true;
  };
}

/**
 * Serializa el append y el commit del Log entre writers del mismo repo.
 *
 * El lock vive junto al índice del worktree, no en el checkout, para que dos
 * worktrees del mismo repositorio no compartan accidentalmente el estado de
 * coordinación. Las llamadas anidadas usan AsyncLocalStorage o el lease
 * explícito; otro request del proceso no puede tomarlo prestado.
 */
function noOpCanonicalEventLogLease(rootDir: string): CanonicalEventLogLease {
  return {
    rootDir,
    run: <T>(operation: () => T): T => operation(),
    release: () => undefined,
  };
}

function createCanonicalEventLogLease(
  rootDir: string,
  lockPath: string,
  lockFd: number,
): CanonicalEventLogLease {
  let released = false;
  const contextEntry: CanonicalLockContextEntry = {
    isActive: () => !released,
  };
  return {
    rootDir,
    run<T>(operation: () => T): T {
      if (released) throw new Error("Canonical event-log lease is already released");
      const current = canonicalLockContext.getStore();
      if (current?.get(lockPath)?.isActive()) return operation();
      const next = new Map(current ?? []);
      next.set(lockPath, contextEntry);
      return canonicalLockContext.run(next, operation);
    },
    release() {
      if (released) return;
      released = true;
      closeSync(lockFd);
      unlinkIfPresent(lockPath);
    },
  };
}

/**
 * Adquiere un lease sin esperar. Los callers síncronos fallan cerrado cuando
 * otro writer posee el lock; el dispatcher HTTP usa la variante asíncrona.
 */
export function acquireCanonicalEventLogLease(rootDir: string): CanonicalEventLogLease {
  if (!existsSync(join(rootDir, ".git"))) return noOpCanonicalEventLogLease(rootDir);

  const indexPath = resolveGitIndexPath(rootDir);
  const lockPath = `${indexPath}.prime-board-event-log.lock`;
  const lockFd = acquireCanonicalEventLogLock(lockPath);
  return createCanonicalEventLogLease(rootDir, lockPath, lockFd);
}

/** Espera un lease sin bloquear el event loop del proceso HTTP. */
export async function acquireCanonicalEventLogLeaseAsync(
  rootDir: string,
): Promise<CanonicalEventLogLease> {
  if (!existsSync(join(rootDir, ".git"))) return noOpCanonicalEventLogLease(rootDir);

  const indexPath = resolveGitIndexPath(rootDir);
  const lockPath = `${indexPath}.prime-board-event-log.lock`;
  const deadline = Date.now() + CANONICAL_LOCK_WAIT_MS;
  while (true) {
    const lockFd = tryAcquireCanonicalEventLogLock(lockPath);
    if (lockFd !== undefined) return createCanonicalEventLogLease(rootDir, lockPath, lockFd);
    if (Date.now() >= deadline) {
      const owner = readCanonicalLockOwner(lockPath);
      if (owner === undefined) throw new Error("Cannot lock canonical event log: lock disappeared");
      throw new Error(`Cannot lock canonical event log: writer ${owner} did not release the lock`);
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, CANONICAL_LOCK_POLL_MS));
  }
}

/**
 * Serializa operaciones del Log entre writers del mismo repo.
 *
 * RepoSync usa `acquireCanonicalEventLogLease` cuando debe conservar el lock
 * durante una mutación completa. Esta forma corta sigue siendo útil para una
 * sección crítica síncrona y conserva la reentrada de sus callers existentes.
 */
export function withCanonicalEventLogLock<T>(rootDir: string, operation: () => T): T {
  if (!existsSync(join(rootDir, ".git"))) return operation();
  const indexPath = resolveGitIndexPath(rootDir);
  const lockPath = `${indexPath}.prime-board-event-log.lock`;
  if (canonicalLockContext.getStore()?.get(lockPath)?.isActive()) return operation();
  const lease = acquireCanonicalEventLogLeaseBlocking(rootDir, lockPath);
  try {
    return lease.run(operation);
  } finally {
    lease.release();
  }
}

const CANONICAL_LOCK_WAIT_MS = 30_000;
const CANONICAL_LOCK_POLL_MS = 10;
const CANONICAL_LOCK_RECOVERY_SUFFIX = ".recovery";

/** Adquiere el lock con una creación atómica que también escribe el PID dueño. */
function acquireCanonicalEventLogLock(lockPath: string): number {
  const lockFd = tryAcquireCanonicalEventLogLock(lockPath);
  if (lockFd !== undefined) return lockFd;
  const owner = readCanonicalLockOwner(lockPath);
  if (owner === process.pid) {
    throw new Error(
      "Cannot lock canonical event log: this process already holds the lock; reuse its lease",
    );
  }
  if (owner === undefined) throw new Error("Cannot lock canonical event log: lock disappeared");
  throw new Error(`Cannot lock canonical event log: writer ${owner} did not release the lock`);
}

/** Intenta una reserva sin esperar ni bloquear el event loop. */
function tryAcquireCanonicalEventLogLock(lockPath: string): number | undefined {
  const recoveryPath = `${lockPath}${CANONICAL_LOCK_RECOVERY_SUFFIX}`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (waitForCanonicalLockRecovery(recoveryPath)) {
      // A stale recovery marker was removed. Retry immediately; a live marker
      // remains and tells the caller to wait before trying again.
      if (existsSync(recoveryPath)) return undefined;
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
        // link(2) falla de forma atómica si otro writer posee el lock; rename
        // reemplazaría el lock de ese writer en POSIX.
        linkSync(temporaryPath, lockPath);
        created = true;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
      } finally {
        unlinkIfPresent(temporaryPath);
      }
      if (created) {
        try {
          return openSync(lockPath, constants.O_RDONLY);
        } catch (error) {
          if (!isFileMissingError(error)) throw error;
        }
      }
    } finally {
      if (temporaryFd !== undefined) closeSync(temporaryFd);
      unlinkIfPresent(temporaryPath);
    }

    const owner = readCanonicalLockOwner(lockPath);
    if (owner === undefined) continue;
    if (!isProcessAlive(owner) && tryReclaimCanonicalEventLogLock(lockPath, owner)) continue;
    return undefined;
  }
  return undefined;
}

/** Reserva síncrona para los callers heredados que no pueden hacer await. */
function acquireCanonicalEventLogLeaseBlocking(
  rootDir: string,
  lockPath: string,
): CanonicalEventLogLease {
  const deadline = Date.now() + CANONICAL_LOCK_WAIT_MS;
  while (true) {
    const lockFd = tryAcquireCanonicalEventLogLock(lockPath);
    if (lockFd !== undefined) return createCanonicalEventLogLease(rootDir, lockPath, lockFd);
    const owner = readCanonicalLockOwner(lockPath);
    if (owner === process.pid) {
      throw new Error(
        "Cannot lock canonical event log: this process already holds the lock; reuse its lease",
      );
    }
    if (Date.now() >= deadline) {
      if (owner === undefined) throw new Error("Cannot lock canonical event log: lock disappeared");
      throw new Error(`Cannot lock canonical event log: writer ${owner} did not release the lock`);
    }
    waitForCanonicalLock();
  }
}

/**
 * Recupera un lock obsoleto sin permitir que dos recolectores borren
 * generaciones distintas de la misma ruta. El marker de recuperación es una
 * reserva atómica y exclusiva. También bloquea a otros recolectores.
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
      // El marker de recuperación impide que otro recolector cambie la ruta
      // entre esta comprobación de identidad y el rename atómico.
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
  const temporaryPath = `${recoveryPath}.creating.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    // Publish the marker only after its owner metadata is complete. A waiter
    // can therefore never observe a half-written recovery claim.
    mkdirSync(temporaryPath, 0o700);
    writeFileSync(join(temporaryPath, "owner"), `pid=${process.pid}\n`, {
      mode: 0o600,
    });
    try {
      renameSync(temporaryPath, recoveryPath);
      return true;
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (isFileExistsError(error) || code === "ENOTEMPTY") return false;
      throw error;
    }
  } finally {
    rmSync(temporaryPath, { recursive: true, force: true });
  }
}

/** Waits for a live recovery claim or atomically removes a stale one. */
function waitForCanonicalLockRecovery(recoveryPath: string): boolean {
  if (!existsSync(recoveryPath)) return false;

  let owner: number | undefined;
  try {
    owner = readCanonicalRecoveryOwner(recoveryPath);
  } catch (error) {
    // A recovery owner is published by rename(2), but the claimant removes
    // that directory as soon as it finishes. Treat that short race as a live
    // recovery instead of surfacing a transient "owner metadata is missing".
    if (!existsSync(recoveryPath)) return true;
    throw error;
  }
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

function restoreRealEventLogIndex(
  rootDir: string,
  indexPath: string,
  originalEntry: string | undefined,
): void {
  const tempDir = mkdtempSync(join(tmpdir(), "prime-board-restore-index-"));
  const tempIndex = join(tempDir, "index");
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    if (existsSync(indexPath)) {
      copyFileSync(indexPath, tempIndex);
    } else {
      const parent = readGitHead(rootDir);
      runGit(rootDir, ["read-tree", parent ?? "--empty"], env);
    }
    if (originalEntry) {
      const [mode, object] = originalEntry.trim().split(/\s+/u);
      if (!mode || !object) throw new Error("Invalid original event-log index entry");
      runGit(
        rootDir,
        ["update-index", "--add", "--cacheinfo", `${mode},${object},${EVENT_LOG_RELATIVE_PATH}`],
        env,
      );
    } else {
      runGit(rootDir, ["update-index", "--force-remove", "--", EVENT_LOG_RELATIVE_PATH], env);
    }
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
 * Devuelve los bytes validados para que una operación Git posterior no lea
 * de nuevo un working tree cambiado y capture un append ajeno.
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
