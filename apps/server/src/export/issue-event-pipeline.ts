import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  EventLogWriter,
  type AppendResult,
  type DomainEvent,
  type EventLogOptions,
} from "./event-log.ts";
import type { ProjectorCheckpoint } from "./projector.ts";

/** Writer mínimo que necesita el bridge de Activity y el pipeline. */
export interface CanonicalEventLog {
  appendMany(eventInputs: readonly unknown[]): AppendResult[];
  read(): DomainEvent[];
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

/** Checkpoint sync para el runtime SQLite. PostgreSQL usa su adapter async. */
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

/**
 * Pipeline de una mutación SQLite: append durable, commit Git, projector y
 * checkpoint. El caller decide cuándo regenerar snapshots; esa operación debe
 * ocurrir antes del commit si sus archivos también forman parte del commit.
 */
export class IssueEventPipeline {
  readonly eventLog: CanonicalEventLog;
  readonly rootDir: string;
  readonly stream: string;

  private readonly commitGit: GitCommitter;
  private readonly projector: IssueEventProjector;
  private readonly checkpointStore: IssueEventCheckpointStore;
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
    return this.eventLog.appendMany(events);
  }

  /** Hace commit solo después de que el append terminó sin errores. */
  commit(): void {
    const eventIds = this.eventLog.read().map((event) => event.eventId);
    this.commitGit({ rootDir: this.rootDir, eventIds });
  }

  /**
   * Proyecta desde el último checkpoint. Un error de apply o save deja el
   * checkpoint anterior intacto para que el mismo evento se pueda reintentar.
   */
  project(): IssueEventProjectionResult {
    const events = this.eventLog.read();
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
    runGit(rootDir, ["add", "--", ".prime-board/log/events.jsonl"]);
    const status = spawnSync(
      "git",
      ["-C", rootDir, "diff", "--cached", "--quiet", "--", ".prime-board/log/events.jsonl"],
      {
        encoding: "utf8",
      },
    );
    if (status.error) throw status.error;
    if (status.status === 0) return;
    if (status.status !== 1) {
      throw new Error(status.stderr.trim() || "Cannot inspect staged event log changes");
    }
    runGit(rootDir, [
      "commit",
      "--only",
      "-m",
      "chore(events): append canonical issue events",
      "--",
      ".prime-board/log/events.jsonl",
    ]);
  };
}

function runGit(rootDir: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", rootDir, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
  }
}
