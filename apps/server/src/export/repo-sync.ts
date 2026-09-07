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
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  complete(): void;
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
  private closed = false;

  constructor(
    readonly lock: CanonicalEventLogLease,
    readonly retiredDocuments: RetiredDocumentsReservation,
  ) {}

  markReady(): void {
    if (this.closed) throw new Error("Repo sync lease is already closed");
    this.ready = true;
  }

  complete(): void {
    if (this.closed) return;
    if (!this.ready) {
      this.abort();
      throw new Error("Cannot complete a RepoSync lease before sync succeeds");
    }
    try {
      // Conserva el lock canónico durante la comprobación final y unlink.
      this.lock.run(() => this.retiredDocuments.retire());
    } finally {
      this.closed = true;
      this.lock.release();
    }
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.retiredDocuments.release();
    } finally {
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
    lease.lock.run(() => {
      appendActivityEvents(db, root, eventPipeline.eventLog, (eventIds) =>
        eventPipeline.recordPendingEventIds(eventIds),
      );
      // Append, Git commit, projection and export are all inside the same
      // lease. El committer predeterminado reutiliza el lease explícito en
      // vez de intentar adquirir el lock de archivo otra vez.
      eventPipeline.commit(undefined, lease.lock);
      eventPipeline.project();
      exporter(lease.retiredDocuments);
    });
    lease.markReady();
  };
  const sync = (
    exporter: (documents: RetiredDocumentsReservation) => void,
    lease?: RepoSyncLease,
  ): void => {
    const current = lease ? leaseFor(lease, root) : reserve();
    try {
      runSync(current, exporter);
      if (!lease) current.complete();
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
