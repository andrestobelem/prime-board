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
import { exportBoard, exportIssue } from "./exporter.ts";
import { appendActivityEvents } from "./activity-stream.ts";
import {
  createGitCommitter,
  IssueEventPipeline,
  withCanonicalEventLogLock,
  type IssueEventPipelineOptions,
} from "./issue-event-pipeline.ts";

export { appendActivityEvents, activityToDomainEvent } from "./activity-stream.ts";
export {
  createGitCommitter,
  IssueEventPipeline,
  type CanonicalEventLog,
  type GitCommitInput,
  type GitCommitter,
  type IssueEventCheckpointStore,
  type IssueEventPipelineOptions,
  type IssueEventProjector,
} from "./issue-event-pipeline.ts";

export interface RepoSyncOptions extends IssueEventPipelineOptions {
  /** Pipeline precargado para tests y adapters de runtime. */
  readonly eventPipeline?: IssueEventPipeline;
}

export interface RepoSync {
  /**
   * Regenera el repo completo (cambios de metadata, borrados).
   * Los fallos se propagan al caller para que la mutación no informe éxito
   * cuando el append, Git, projector o export falla.
   */
  sync(): void;
  /** Camino caliente: reescribe solo el issue afectado (AT-166). */
  syncIssue(issueId: string): void;
  readonly root: string;
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
  const sync = (exporter: () => void): void => {
    // Append y commit forman una sola sección crítica. Si dos procesos
    // anexan antes de tomar el lock, uno puede confundir el evento válido del
    // otro con una mutación inesperada.
    withCanonicalEventLogLock(root, () => {
      appendActivityEvents(db, root, eventPipeline.eventLog, (eventIds) =>
        eventPipeline.recordPendingEventIds(eventIds),
      );
      eventPipeline.commit();
    });
    // El evento queda durable antes de tocar cualquier proyección.
    eventPipeline.project();
    exporter();
  };
  return {
    root,
    sync() {
      sync(() => exportBoard(db, root));
    },
    syncIssue(issueId: string) {
      // Un repo vacío o histórico sin metadata todavía no es una réplica
      // reconstruible: inicializarlo con el export completo deja también la
      // identidad y el alcance del Workspace.
      sync(() => {
        const metadata = join(root, ".prime-board", "meta", "export.json");
        const retiredDocuments = join(root, ".prime-board", "meta", "documents.json");
        if (
          !existsSync(metadata) ||
          existsSync(retiredDocuments) ||
          !exportIssue(db, root, issueId)
        )
          exportBoard(db, root);
      });
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
