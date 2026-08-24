import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
    const before = new Set(this.eventLog.read().map((event) => event.eventId));
    try {
      const results = this.eventLog.appendMany(events);
      for (const result of results) {
        if (result.appended) this.pendingEventIds.add(result.eventId);
      }
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
    const changedEventIds = validateEventLogDelta(rootDir, eventIds);
    if (changedEventIds.size === 0) return;
    runGit(rootDir, ["add", "--", EVENT_LOG_RELATIVE_PATH]);
    const status = spawnSync(
      "git",
      ["-C", rootDir, "diff", "--cached", "--quiet", "--", EVENT_LOG_RELATIVE_PATH],
      { encoding: "utf8" },
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
      EVENT_LOG_RELATIVE_PATH,
    ]);
  };
}

/**
 * Verify that the working-tree change is an append of only expected events.
 * This check runs before `git add`, so a concurrent or pre-existing change is
 * rejected and remains available for its owner to retry.
 */
function validateEventLogDelta(rootDir: string, expectedEventIds: readonly string[]): Set<string> {
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
  if (delta.length === 0) return new Set();
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
  return changed;
}

function readHeadEventLog(rootDir: string): string {
  const result = spawnSync("git", ["-C", rootDir, "show", `HEAD:${EVENT_LOG_RELATIVE_PATH}`], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout;
  if (result.status === 128) return "";
  throw new Error(result.stderr.trim() || "Cannot read HEAD event log");
}

function runGit(rootDir: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", rootDir, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
  }
}
