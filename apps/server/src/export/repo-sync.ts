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

function restoreReplicaSnapshot(root: string, snapshot: ReplicaFileSnapshot): void {
  const base = join(root, ".prime-board");
  rmSync(base, { recursive: true, force: true });
  if (!snapshot.existed) return;
  for (const file of snapshot.files) {
    const path = join(root, file.relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.contents, { mode: file.mode });
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
  private released = false;
  private commitEventLog: (() => void) | undefined;
  private restoreEventLog: (() => void) | undefined;

  constructor(
    readonly lock: CanonicalEventLogLease,
    readonly retiredDocuments: RetiredDocumentsReservation,
  ) {}

  setRollback(restore: () => void): void {
    if (this.released) throw new Error("Repo sync lease is already released");
    this.restoreEventLog = restore;
  }

  markReady(commitEventLog: () => void): void {
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
        this.commitEventLog!();
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
    this.released = true;
    this.lock.release();
  }

  abort(): void {
    if (this.released) return;
    try {
      if (!this.completed) {
        // The caller still owns the lock, so restoring the append cannot race
        // another RepoSync writer in this process or worktree.
        try {
          this.lock.run(() => this.restoreEventLog?.());
        } catch {
          // Preserve the original mutation error. A later sync can recover the
          // append if an injected event log does not support restoration.
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
    lease.setRollback(() => {
      restoreReplicaSnapshot(root, replicaSnapshot);
      eventPipeline.restoreEventLog(eventLogSnapshot);
    });
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
