// Sincronización con el repo en cada escritura (AT-158, Fase 3).
//
// Cada mutación pasa por el bridge de Activity y deja el evento en el repo en
// el momento en que ocurre. En esta slice SQLite sigue siendo la autoridad
// operativa; el log canónico es una réplica durable que `rebuild` puede leer.
// El proyector y el checkpoint productivos se inyectan por RepoSyncOptions.
// Por defecto son noop y memoria: este módulo no implementa PostgreSQL ni
// convierte el bridge en una topología event-first.
//
// Los logs son append-only y `.gitattributes` los marca `merge=union`, así
// dos agentes que escriben en branches distintas mergean sin conflicto
// (verificado experimentalmente en la investigación de AT-153).
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  exportBoard,
  exportIssue,
  prepareRetiredDocuments,
  type RetiredDocumentsReservation,
} from "./exporter.ts";
import { appendActivityEvents } from "./activity-stream.ts";
import {
  acquireCanonicalEventLogLease,
  acquireCanonicalEventLogLeaseAsync,
  createGitCommitter,
  IssueEventPipeline,
  type CanonicalEventLogLease,
  type GitCommitRollback,
  type IssueEventPipelineOptions,
} from "./issue-event-pipeline.ts";

interface ReplicaFileSnapshot {
  readonly existed: boolean;
  readonly files: readonly {
    readonly relativePath: string;
    readonly contents: Buffer;
    readonly mode: number;
  }[];
}

function captureReplicaSnapshot(root: string): ReplicaFileSnapshot {
  const base = join(root, ".prime-board");
  if (!existsSync(base)) return { existed: false, files: [] };
  const files: {
    relativePath: string;
    contents: Buffer;
    mode: number;
  }[] = [];
  const walk = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = join(relativeDirectory, entry.name);
      const absolutePath = join(root, relativePath);
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const stat = statSync(absolutePath);
        files.push({
          relativePath,
          contents: readFileSync(absolutePath),
          mode: stat.mode & 0o777,
        });
      } else {
        throw new Error(`Repository replica contains unsupported entry: ${relativePath}`);
      }
    }
  };
  walk(base, ".prime-board");
  return { existed: true, files };
}

function fileMatchesSnapshot(root: string, file: ReplicaFileSnapshot["files"][number]): boolean {
  const path = join(root, file.relativePath);
  try {
    return statSync(path).isFile() && readFileSync(path).equals(file.contents);
  } catch {
    return false;
  }
}

/**
 * Restores only paths that still contain this mutation's bytes. This keeps a
 * replacement made by an uncooperating Documents writer instead of clobbering
 * it while rolling back the export.
 */
function restoreReplicaChanges(
  root: string,
  before: ReplicaFileSnapshot,
  after: ReplicaFileSnapshot,
): void {
  const beforeByPath = new Map(before.files.map((file) => [file.relativePath, file]));
  const afterByPath = new Map(after.files.map((file) => [file.relativePath, file]));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  for (const relativePath of paths) {
    const previous = beforeByPath.get(relativePath);
    const current = afterByPath.get(relativePath);
    const path = join(root, relativePath);
    if (current) {
      if (!fileMatchesSnapshot(root, current)) continue;
      if (previous) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, previous.contents, { mode: previous.mode });
      } else {
        unlinkSync(path);
      }
    } else if (previous && !existsSync(path)) {
      // The mutation retired a path. Restore it only while it remains absent;
      // a concurrent replacement must win.
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, previous.contents, { mode: previous.mode });
    }
  }
}

export { appendActivityEvents, activityToDomainEvent } from "./activity-stream.ts";
export {
  acquireCanonicalEventLogLease,
  acquireCanonicalEventLogLeaseAsync,
  createGitCommitter,
  IssueEventPipeline,
  type CanonicalEventLog,
  type CanonicalEventLogLease,
  type GitCommitInput,
  type GitCommitter,
  type IssueEventCheckpointStore,
  type IssueEventPipelineOptions,
  type IssueEventProjector,
} from "./issue-event-pipeline.ts";

export interface RepoSyncOptions extends IssueEventPipelineOptions {
  /** Pipeline precargado para tests y adapters de runtime. */
  readonly eventPipeline?: IssueEventPipeline;
  /** Archivo externo usado para validar y retirar Documents históricos. */
  readonly documentsArchivePath?: string;
}

/**
 * Reserva que mantiene el lock del repo durante una mutación.
 *
 * `complete()` solo es válido después de que `sync()` o `syncIssue()` terminó
 * el append, commit, proyección y export. `abort()` siempre conserva la
 * captura. La interfaz permite que el despacho GraphQL cierre la reserva solo
 * cuando el resolver también terminó con éxito.
 */
export interface RepoSyncLease {
  /** Prepares Documents and the event-log commit while the DB transaction is open. */
  complete(): void;
  /** Releases the repository lease after the caller commits its transaction. */
  release?(): void;
  abort(): void;
}

export interface RepoSync {
  /** Verifica y reserva Documents sin retirar su captura. */
  preflight(): RepoSyncLease | void;
  /** Variante no bloqueante para callers HTTP que esperan el lease. */
  preflightAsync?(): void | Promise<unknown>;
  /**
   * Regenera el repo completo (cambios de metadata, borrados).
   * Los fallos se propagan al caller para que la mutación no informe éxito.
   * Si se recibe una reserva, esta queda abierta para que el dispatcher la
   * complete después del resolver.
   */
  sync(lease?: RepoSyncLease): void;
  /** Camino caliente: reescribe solo el issue afectado (AT-166). */
  syncIssue(issueId: string, lease?: RepoSyncLease): void;
  readonly root: string;
}

class RepoSyncLeaseImpl implements RepoSyncLease {
  private ready = false;
  private completed = false;
  private transactionCommitted = false;
  private released = false;
  private commitEventLog: (() => GitCommitRollback | undefined) | undefined;
  private rollbackGit: GitCommitRollback | undefined;
  private restoreEventLog: (() => void) | undefined;
  private captureAfterRetire: (() => void) | undefined;

  constructor(
    readonly lock: CanonicalEventLogLease,
    readonly retiredDocuments: RetiredDocumentsReservation,
  ) {}

  setRollback(restore: () => void, captureAfterRetire?: () => void): void {
    if (this.released) throw new Error("Repo sync lease is already released");
    this.restoreEventLog = restore;
    this.captureAfterRetire = captureAfterRetire;
  }

  markReady(commitEventLog: () => GitCommitRollback | undefined): void {
    if (this.released) throw new Error("Repo sync lease is already released");
    this.commitEventLog = commitEventLog;
    this.ready = true;
  }

  complete(): void {
    if (this.released || this.completed) return;
    if (!this.ready || !this.commitEventLog) {
      this.abort();
      throw new Error("Cannot complete a RepoSync lease before sync succeeds");
    }
    try {
      // Retire Documents before publishing the event-log commit. If either
      // step fails, the DB transaction can still roll back without a Git event.
      this.lock.run(() => {
        this.retiredDocuments.retire();
        this.captureAfterRetire?.();
        this.rollbackGit = this.commitEventLog!();
      });
      this.completed = true;
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  release(): void {
    if (this.released) return;
    if (!this.completed) {
      this.abort();
      return;
    }
    this.transactionCommitted = true;
    this.released = true;
    this.lock.release();
  }

  abort(): void {
    if (this.released) return;
    try {
      if (!this.transactionCommitted) {
        // The caller still owns the lock, so compensation cannot race another
        // RepoSync writer in this process or worktree.
        try {
          this.lock.run(() => this.rollbackGit?.());
        } catch {
          // Preserve the original mutation error. A later sync can recover the
          // Git commit if compensation cannot move HEAD safely.
        }
        try {
          this.lock.run(() => this.restoreEventLog?.());
        } catch {
          // Preserve the original mutation error. A later sync can recover the
          // append if an injected event log does not support restoration.
        }
        try {
          this.retiredDocuments.rollback?.();
        } catch {
          // Preserve the original mutation error. The archive remains safe if
          // a concurrent replacement wins the compare-and-restore check.
        }
      }
      this.retiredDocuments.release();
    } finally {
      this.released = true;
      this.lock.release();
    }
  }
}

function leaseFor(value: RepoSyncLease | undefined, root: string): RepoSyncLeaseImpl {
  if (!(value instanceof RepoSyncLeaseImpl) || value.lock.rootDir !== root) {
    throw new Error("Repo sync lease belongs to a different repository");
  }
  return value;
}

export function createRepoSync(
  db: Database,
  root: string | null,
  options: RepoSyncOptions = {},
): RepoSync | null {
  if (!root) return null;
  if (!existsSync(root)) {
    console.error(`PRIME_BOARD_REPO points to a missing directory: ${root}`);
    return null;
  }
  ensureGitAttributes(root);
  const eventPipeline =
    options.eventPipeline ??
    new IssueEventPipeline({
      ...options,
      rootDir: root,
      commitGit: options.commitGit ?? createGitCommitter(root),
    });
  const archivePath = () =>
    options.documentsArchivePath ?? process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
  const reserveWithLock = (lock: CanonicalEventLogLease): RepoSyncLeaseImpl => {
    try {
      const retiredDocuments = prepareRetiredDocuments(db, root, archivePath());
      return new RepoSyncLeaseImpl(lock, retiredDocuments);
    } catch (error) {
      lock.release();
      throw error;
    }
  };
  const reserve = (): RepoSyncLeaseImpl => reserveWithLock(acquireCanonicalEventLogLease(root));
  const reserveAsync = async (): Promise<RepoSyncLeaseImpl> =>
    reserveWithLock(await acquireCanonicalEventLogLeaseAsync(root));
  const runSync = (
    lease: RepoSyncLeaseImpl,
    exporter: (documents: RetiredDocumentsReservation) => void,
  ): void => {
    const eventLogSnapshot = eventPipeline.captureEventLog();
    const replicaSnapshot = captureReplicaSnapshot(root);
    let replicaAfterSync = replicaSnapshot;
    lease.setRollback(
      () => {
        eventPipeline.restoreEventLog(eventLogSnapshot);
        restoreReplicaChanges(root, replicaSnapshot, replicaAfterSync);
      },
      () => {
        replicaAfterSync = captureReplicaSnapshot(root);
      },
    );
    try {
      lease.lock.run(() => {
        appendActivityEvents(db, root, eventPipeline.eventLog, (eventIds) =>
          eventPipeline.recordPendingEventIds(eventIds),
        );
        // Keep the append and projection inside the lease, but publish the Git
        // commit only from lease.complete(), after Documents validation and while
        // the caller's DB transaction is still open.
        eventPipeline.project();
        exporter(lease.retiredDocuments);
      });
      replicaAfterSync = captureReplicaSnapshot(root);
    } catch (error) {
      // Exporters can fail after creating only part of the replica. Record that
      // intermediate state so abort removes those paths without clobbering an
      // unrelated replacement.
      replicaAfterSync = captureReplicaSnapshot(root);
      throw error;
    }
    lease.markReady(() => eventPipeline.commit(undefined, lease.lock));
  };
  const sync = (
    exporter: (documents: RetiredDocumentsReservation) => void,
    lease?: RepoSyncLease,
  ): void => {
    const current = lease ? leaseFor(lease, root) : reserve();
    try {
      runSync(current, exporter);
      if (!lease) {
        current.complete();
        current.release();
      }
    } catch (error) {
      current.abort();
      throw error;
    }
  };
  return {
    root,
    preflight: reserve,
    preflightAsync: reserveAsync,
    sync(lease?: RepoSyncLease) {
      sync((documents) => exportBoard(db, root, { retiredDocuments: documents }), lease);
    },
    syncIssue(issueId: string, lease?: RepoSyncLease) {
      // Un repo vacío o histórico sin metadata todavía no es una réplica
      // reconstruible: inicializarlo con el export completo deja también la
      // identidad y el alcance del Workspace. Una captura retirada pendiente
      // también exige export completo para que el snapshot final sea coherente.
      sync((documents) => {
        const metadata = join(root, ".prime-board", "meta", "export.json");
        const retiredDocuments = join(root, ".prime-board", "meta", "documents.json");
        if (
          !existsSync(metadata) ||
          existsSync(retiredDocuments) ||
          !exportIssue(db, root, issueId, { retiredDocuments: documents })
        )
          exportBoard(db, root, { retiredDocuments: documents });
      }, lease);
    },
  };
}

const UNION_RULE = ".prime-board/log/*.jsonl merge=union";

/** Deja el driver `union` configurado: sin esto, dos appends dan conflicto. */
export function ensureGitAttributes(root: string): void {
  const path = join(root, ".gitattributes");
  const current = existsSync(path) ? require("node:fs").readFileSync(path, "utf8") : "";
  if (current.includes(UNION_RULE)) return;
  const header = "# Los logs de prime-board son append-only: se mergean por unión.\n";
  const next = current
    ? `${current.replace(/\n*$/, "\n")}\n${header}${UNION_RULE}\n`
    : `${header}${UNION_RULE}\n`;
  require("node:fs").writeFileSync(path, next);
}
