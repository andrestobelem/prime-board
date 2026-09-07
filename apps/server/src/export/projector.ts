import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import type { DomainEvent, EventLogOptions } from "./event-log.ts";
import { EventLogReader } from "./event-log.ts";

export interface ProjectorCheckpoint {
  readonly stream: string;
  readonly eventId: string;
  readonly occurredAt: string;
}

/** Durable checkpoint boundary. Implementations must not write domain state. */
export interface ProjectorCheckpointStore {
  load(stream: string): Promise<ProjectorCheckpoint | undefined>;
  save(checkpoint: ProjectorCheckpoint): Promise<void>;
}

/** Short aliases for callers that use generic async names. */
export type CheckpointStore = ProjectorCheckpointStore;
export type AsyncCheckpointStore = ProjectorCheckpointStore;

export interface ProjectorApplyContext {
  /** Last committed event. The current event is not committed yet. */
  readonly checkpoint: ProjectorCheckpoint | undefined;
}

export type ApplyEvent = (event: DomainEvent, context: ProjectorApplyContext) => void;
export type AsyncApplyEvent = (
  event: DomainEvent,
  context: ProjectorApplyContext,
) => void | PromiseLike<void>;

export interface ReplayOptions extends EventLogOptions {
  readonly stream: string;
  readonly checkpoint?: ProjectorCheckpoint;
  /** Optional durable store used by replayAsync(). */
  readonly checkpointStore?: ProjectorCheckpointStore;
}

export type AsyncReplayOptions = ReplayOptions;

export interface ReplayResult {
  readonly applied: number;
  readonly skipped: number;
  readonly checkpoint: ProjectorCheckpoint | undefined;
  /** True when applyEvent failed. The same event is visible on the next retry. */
  readonly failed: boolean;
  readonly error?: unknown;
}

export interface ReplayCompletedResult {
  readonly status: "completed";
  readonly kind: "completed";
  readonly applied: number;
  readonly skipped: number;
  readonly checkpoint: ProjectorCheckpoint | undefined;
  readonly failed: false;
  readonly lag: 0;
  readonly lagging: false;
  readonly retry: false;
  readonly retryable: false;
  readonly error?: undefined;
}

export interface ReplayFailedResult {
  readonly status: "failed";
  readonly kind: "failed";
  readonly applied: number;
  readonly skipped: number;
  readonly checkpoint: ProjectorCheckpoint | undefined;
  readonly failed: true;
  /** Number of events still waiting after the last committed checkpoint. */
  readonly lag: number;
  readonly lagging: boolean;
  /** The same event can be retried without constructing a new projector. */
  readonly retry: true;
  readonly retryable: true;
  readonly error: unknown;
}

export type AsyncReplayResult = ReplayCompletedResult | ReplayFailedResult;

function checkpointFor(stream: string, event: DomainEvent): ProjectorCheckpoint {
  return {
    stream,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
  };
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

function validateCheckpoint(checkpoint: ProjectorCheckpoint): void {
  if (
    checkpoint.stream.trim().length === 0 ||
    checkpoint.eventId.trim().length === 0 ||
    /[\r\n]/u.test(checkpoint.stream) ||
    /[\r\n]/u.test(checkpoint.eventId) ||
    !Number.isFinite(Date.parse(checkpoint.occurredAt))
  ) {
    throw new Error("Projector checkpoint is invalid");
  }
}

function validateStream(stream: string): void {
  if (stream.trim().length === 0 || /[\r\n]/u.test(stream)) {
    throw new Error("Projector stream must be a non-empty safe string");
  }
}

function validateOptions(options: ReplayOptions): void {
  validateStream(options.stream);
  if (options.checkpoint) {
    validateCheckpoint(options.checkpoint);
    if (options.checkpoint.stream !== options.stream) {
      throw new Error("Projector checkpoint stream does not match the projector stream");
    }
  }
}

function assertCheckpointStream(checkpoint: ProjectorCheckpoint, stream: string): void {
  validateCheckpoint(checkpoint);
  if (checkpoint.stream !== stream) {
    throw new Error("Projector checkpoint stream does not match the projector stream");
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function legacyCompleted(
  applied: number,
  skipped: number,
  checkpoint: ProjectorCheckpoint | undefined,
): ReplayResult {
  return { applied, skipped, checkpoint, failed: false };
}

function legacyFailed(
  applied: number,
  skipped: number,
  checkpoint: ProjectorCheckpoint | undefined,
  error: unknown,
): ReplayResult {
  return { applied, skipped, checkpoint, failed: true, error };
}

function completed(
  applied: number,
  skipped: number,
  checkpoint: ProjectorCheckpoint | undefined,
): ReplayCompletedResult {
  return {
    status: "completed",
    kind: "completed",
    applied,
    skipped,
    checkpoint,
    failed: false,
    lag: 0,
    lagging: false,
    retry: false,
    retryable: false,
  };
}

function failed(
  applied: number,
  skipped: number,
  checkpoint: ProjectorCheckpoint | undefined,
  error: unknown,
  lag: number,
): ReplayFailedResult {
  return {
    status: "failed",
    kind: "failed",
    applied,
    skipped,
    checkpoint,
    failed: true,
    lag,
    lagging: lag > 0,
    retry: true,
    retryable: true,
    error,
  };
}

interface CheckpointRow {
  readonly stream: string;
  readonly event_id: string;
  readonly occurred_at: string;
  readonly processed: boolean;
}

/**
 * PostgreSQL-backed checkpoint store. It only writes projector metadata.
 * Domain rows must be changed by the projector callback, never by this class.
 */
export async function saveProjectorCheckpoint(
  tx: PersistenceTransaction,
  checkpoint: ProjectorCheckpoint,
): Promise<void> {
  validateCheckpoint(checkpoint);
  await tx.execute(
    `INSERT INTO projector_checkpoints
       (stream, event_id, occurred_at, processed, updated_at)
     VALUES ($1, $2, $3, TRUE, now())
     ON CONFLICT (stream) DO UPDATE SET
       event_id = EXCLUDED.event_id,
       occurred_at = EXCLUDED.occurred_at,
       processed = TRUE,
       updated_at = now()
     WHERE projector_checkpoints.processed = FALSE
        OR projector_checkpoints.occurred_at < EXCLUDED.occurred_at
        OR (projector_checkpoints.occurred_at = EXCLUDED.occurred_at
            AND projector_checkpoints.event_id < EXCLUDED.event_id)`,
    [checkpoint.stream, checkpoint.eventId, checkpoint.occurredAt],
  );
}

export class PostgresCheckpointStore implements ProjectorCheckpointStore {
  constructor(private readonly persistence: Persistence) {}

  async load(stream: string): Promise<ProjectorCheckpoint | undefined> {
    validateStream(stream);
    const row = await this.persistence.one<CheckpointRow>(
      `SELECT stream, event_id, occurred_at, processed
       FROM projector_checkpoints
       WHERE stream = $1`,
      [stream],
    );
    if (!row || !row.processed) return undefined;
    const checkpoint: ProjectorCheckpoint = {
      stream: row.stream,
      eventId: row.event_id,
      occurredAt: row.occurred_at,
    };
    assertCheckpointStream(checkpoint, stream);
    return checkpoint;
  }

  async save(checkpoint: ProjectorCheckpoint): Promise<void> {
    await this.persistence.transaction((tx) => saveProjectorCheckpoint(tx, checkpoint));
  }

  /** Compatibility names for generic key/value checkpoint adapters. */
  get(stream: string): Promise<ProjectorCheckpoint | undefined> {
    return this.load(stream);
  }

  set(checkpoint: ProjectorCheckpoint): Promise<void> {
    return this.save(checkpoint);
  }
}

/**
 * Replay seam for projections. The callback runs before the checkpoint
 * advances. A callback or checkpoint-store failure is returned to the caller,
 * and the last successful checkpoint remains visible for retry.
 *
 * The original synchronous replay API remains available. Use replayAsync()
 * when the callback or checkpoint store performs asynchronous I/O.
 */
export class EventProjector {
  private checkpoint: ProjectorCheckpoint | undefined;
  private readonly reader: EventLogReader;

  private readonly options: ReplayOptions;

  constructor(
    private readonly applyEvent: ApplyEvent | AsyncApplyEvent,
    options: ReplayOptions,
    checkpointStore?: ProjectorCheckpointStore,
  ) {
    this.options = checkpointStore ? { ...options, checkpointStore } : options;
    validateOptions(this.options);
    this.reader = new EventLogReader(this.options);
    this.checkpoint = this.options.checkpoint;
  }

  getCheckpoint(): ProjectorCheckpoint | undefined {
    return this.checkpoint;
  }

  replay(checkpoint?: ProjectorCheckpoint): ReplayResult {
    if (checkpoint) {
      assertCheckpointStream(checkpoint, this.options.stream);
      this.checkpoint = checkpoint;
    }
    const events = this.reader.read();
    let applied = 0;
    let skipped = 0;
    let lastCheckpoint = this.checkpoint;

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      if (lastCheckpoint && !isAfterCheckpoint(event, lastCheckpoint)) {
        skipped += 1;
        continue;
      }
      try {
        const result = this.applyEvent(event, { checkpoint: lastCheckpoint });
        if (isPromiseLike(result)) {
          throw new Error("Async projector callback requires replayAsync()");
        }
      } catch (error) {
        // Do not advance on failure. The failed event remains the next event
        // after lastCheckpoint, so replay() exposes it for retry.
        this.checkpoint = lastCheckpoint;
        return legacyFailed(applied, skipped, lastCheckpoint, error);
      }
      lastCheckpoint = checkpointFor(this.options.stream, event);
      this.checkpoint = lastCheckpoint;
      applied += 1;
    }

    this.checkpoint = lastCheckpoint;
    return legacyCompleted(applied, skipped, lastCheckpoint);
  }

  resume(checkpoint?: ProjectorCheckpoint): ReplayResult {
    return this.replay(checkpoint);
  }

  replayFromBeginning(): ReplayResult {
    this.checkpoint = undefined;
    return this.replay();
  }

  async replayAsync(checkpoint?: ProjectorCheckpoint): Promise<AsyncReplayResult> {
    return this.runAsync({ checkpoint, loadStore: checkpoint === undefined });
  }

  async resumeAsync(checkpoint?: ProjectorCheckpoint): Promise<AsyncReplayResult> {
    return this.replayAsync(checkpoint);
  }

  async replayFromBeginningAsync(): Promise<AsyncReplayResult> {
    this.checkpoint = undefined;
    return this.runAsync({ loadStore: false });
  }

  private async runAsync(options: {
    readonly checkpoint?: ProjectorCheckpoint;
    readonly loadStore: boolean;
  }): Promise<AsyncReplayResult> {
    const events = this.reader.read();
    let applied = 0;
    let skipped = 0;
    let lastCheckpoint = this.checkpoint;

    if (options.checkpoint) {
      try {
        assertCheckpointStream(options.checkpoint, this.options.stream);
      } catch (error) {
        return failed(applied, skipped, lastCheckpoint, error, events.length);
      }
      lastCheckpoint = options.checkpoint;
      this.checkpoint = lastCheckpoint;
    } else if (options.loadStore && this.options.checkpointStore) {
      try {
        const loaded = await this.options.checkpointStore.load(this.options.stream);
        if (loaded) {
          assertCheckpointStream(loaded, this.options.stream);
          lastCheckpoint = loaded;
          this.checkpoint = loaded;
        }
      } catch (error) {
        this.checkpoint = lastCheckpoint;
        return failed(applied, skipped, lastCheckpoint, error, events.length);
      }
    }

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      if (lastCheckpoint && !isAfterCheckpoint(event, lastCheckpoint)) {
        skipped += 1;
        continue;
      }
      try {
        await this.applyEvent(event, { checkpoint: lastCheckpoint });
      } catch (error) {
        // The event was not checkpointed. A later replay retries this event.
        this.checkpoint = lastCheckpoint;
        return failed(applied, skipped, lastCheckpoint, error, events.length - index);
      }

      const nextCheckpoint = checkpointFor(this.options.stream, event);
      if (this.options.checkpointStore) {
        try {
          await this.options.checkpointStore.save(nextCheckpoint);
        } catch (error) {
          // Applying succeeded, but the durable cursor did not. Keep the old
          // cursor so a retry can safely re-apply an idempotent projection.
          this.checkpoint = lastCheckpoint;
          return failed(applied, skipped, lastCheckpoint, error, events.length - index);
        }
      }
      lastCheckpoint = nextCheckpoint;
      this.checkpoint = lastCheckpoint;
      applied += 1;
    }

    this.checkpoint = lastCheckpoint;
    return completed(applied, skipped, lastCheckpoint);
  }
}

export type PostgresApplyEvent = (
  tx: PersistenceTransaction,
  event: DomainEvent,
  context: ProjectorApplyContext,
) => void | PromiseLike<void>;

export interface PostgresReplayOptions extends ReplayOptions {
  readonly persistence: Persistence;
  readonly checkpointStore?: ProjectorCheckpointStore;
}

/**
 * Replay through PostgreSQL with domain apply and checkpoint in one transaction.
 * The callback must use the supplied transaction for all domain writes.
 */
async function projectorEventsAvailable(persistence: Persistence): Promise<boolean> {
  try {
    const row = await persistence.one<{ available: number }>(
      `SELECT 1 AS available
       FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'projector_events'
       LIMIT 1`,
    );
    return row?.available === 1;
  } catch {
    // Las instalaciones antiguas y los adaptadores de prueba pueden usar aún
    // el cursor único de checkpoint. La migración 0016 activa el camino seguro.
    return false;
  }
}

async function projectorEventProcessed(
  persistence: Persistence,
  stream: string,
  eventId: string,
): Promise<boolean> {
  const row = await persistence.one<{ event_id: string }>(
    "SELECT event_id FROM projector_events WHERE stream = $1 AND event_id = $2",
    [stream, eventId],
  );
  return row !== null;
}

async function claimProjectorEvent(
  tx: PersistenceTransaction,
  stream: string,
  event: DomainEvent,
): Promise<boolean> {
  const result = await tx.execute<{ event_id: string }>(
    `INSERT INTO projector_events (stream, event_id, occurred_at)
     VALUES ($1, $2, $3) ON CONFLICT (stream, event_id) DO NOTHING
     RETURNING event_id`,
    [stream, event.eventId, event.occurredAt],
  );
  return result.rowCount > 0;
}

function compareCheckpointOrder(left: ProjectorCheckpoint, right: ProjectorCheckpoint): number {
  const leftTime = Date.parse(left.occurredAt);
  const rightTime = Date.parse(right.occurredAt);
  if (leftTime !== rightTime) return leftTime - rightTime;
  if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? -1 : 1;
  if (left.eventId === right.eventId) return 0;
  return left.eventId < right.eventId ? -1 : 1;
}

export async function replayPostgresEvents(
  applyEvent: PostgresApplyEvent,
  options: PostgresReplayOptions,
): Promise<AsyncReplayResult> {
  validateOptions(options);
  const events = new EventLogReader(options).read();
  const store = options.checkpointStore ?? new PostgresCheckpointStore(options.persistence);
  let applied = 0;
  let skipped = 0;
  let lastCheckpoint = options.checkpoint;

  if (!lastCheckpoint) {
    try {
      lastCheckpoint = await store.load(options.stream);
    } catch (error) {
      return failed(applied, skipped, lastCheckpoint, error, events.length);
    }
  }
  if (lastCheckpoint) {
    try {
      assertCheckpointStream(lastCheckpoint, options.stream);
    } catch (error) {
      return failed(applied, skipped, undefined, error, events.length);
    }
  }

  // La migración 0016 registra cada evento aplicado. Con receipts se puede
  // detectar un backfill aunque su fecha quede antes del checkpoint; por eso no
  // se usa el checkpoint como límite cuando la tabla está disponible.
  const receipts = await projectorEventsAvailable(options.persistence);
  for (let index = 0; index < events.length; index += 1) {
    const current = events[index];
    if (!current) continue;
    if (!receipts && lastCheckpoint && !isAfterCheckpoint(current, lastCheckpoint)) {
      skipped += 1;
      continue;
    }

    const candidate = checkpointFor(options.stream, current);
    const nextCheckpoint =
      !lastCheckpoint || compareCheckpointOrder(candidate, lastCheckpoint) > 0
        ? candidate
        : lastCheckpoint;
    let claimed = true;
    try {
      claimed = await options.persistence.transaction(async (tx) => {
        if (receipts) {
          await tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", [options.stream]);
          if (await projectorEventProcessed(tx, options.stream, current.eventId)) return false;
          if (!(await claimProjectorEvent(tx, options.stream, current))) return false;
        }
        await applyEvent(tx, current, { checkpoint: lastCheckpoint });
        await saveProjectorCheckpoint(tx, nextCheckpoint);
        return true;
      });
    } catch (error) {
      return failed(applied, skipped, lastCheckpoint, error, events.length - index);
    }
    if (!claimed) {
      skipped += 1;
      continue;
    }
    lastCheckpoint = nextCheckpoint;
    applied += 1;
  }
  return completed(applied, skipped, lastCheckpoint);
}

export function replayEvents(applyEvent: ApplyEvent, options: ReplayOptions): ReplayResult {
  return new EventProjector(applyEvent, options).replay();
}

export async function replayEventsAsync(
  applyEvent: AsyncApplyEvent,
  options: ReplayOptions,
  checkpointStore?: ProjectorCheckpointStore,
): Promise<AsyncReplayResult> {
  return new EventProjector(applyEvent, options, checkpointStore).replayAsync();
}
