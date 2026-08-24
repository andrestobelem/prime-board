import type { DomainEvent, EventLogOptions } from "./event-log.ts";
import { EventLogReader } from "./event-log.ts";

export interface ProjectorCheckpoint {
  readonly stream: string;
  readonly eventId: string;
  readonly occurredAt: string;
}

export interface ProjectorApplyContext {
  /** Last committed event. The current event is not committed yet. */
  readonly checkpoint: ProjectorCheckpoint | undefined;
}

export type ApplyEvent = (event: DomainEvent, context: ProjectorApplyContext) => void;

export interface ReplayOptions extends EventLogOptions {
  readonly stream: string;
  readonly checkpoint?: ProjectorCheckpoint;
}

export interface ReplayResult {
  readonly applied: number;
  readonly skipped: number;
  readonly checkpoint: ProjectorCheckpoint | undefined;
  /** True when applyEvent failed. The same event is visible on the next retry. */
  readonly failed: boolean;
  readonly error?: unknown;
}

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

function validateOptions(options: ReplayOptions): void {
  if (options.stream.trim().length === 0 || /[\r\n]/u.test(options.stream)) {
    throw new Error("Projector stream must be a non-empty safe string");
  }
  if (options.checkpoint) {
    validateCheckpoint(options.checkpoint);
    if (options.checkpoint.stream !== options.stream) {
      throw new Error("Projector checkpoint stream does not match the projector stream");
    }
  }
}

/**
 * Small replay seam for projections. The callback runs before the checkpoint
 * advances. A callback failure is returned to the caller, and the last
 * successful checkpoint remains in memory for a later retry.
 *
 * Checkpoint persistence is intentionally outside this slice. In particular,
 * this module does not write PostgreSQL and does not import historical SQLite.
 */
export class EventProjector {
  private checkpoint: ProjectorCheckpoint | undefined;
  private readonly reader: EventLogReader;

  constructor(
    private readonly applyEvent: ApplyEvent,
    private readonly options: ReplayOptions,
  ) {
    validateOptions(options);
    this.reader = new EventLogReader(options);
    this.checkpoint = options.checkpoint;
  }

  getCheckpoint(): ProjectorCheckpoint | undefined {
    return this.checkpoint;
  }

  replay(checkpoint?: ProjectorCheckpoint): ReplayResult {
    if (checkpoint) {
      validateCheckpoint(checkpoint);
      if (checkpoint.stream !== this.options.stream) {
        throw new Error("Projector checkpoint stream does not match the projector stream");
      }
      this.checkpoint = checkpoint;
    }
    const events = this.reader.read();
    let applied = 0;
    let skipped = 0;
    let lastCheckpoint = this.checkpoint;

    for (const event of events) {
      if (lastCheckpoint && !isAfterCheckpoint(event, lastCheckpoint)) {
        skipped += 1;
        continue;
      }
      try {
        this.applyEvent(event, { checkpoint: lastCheckpoint });
      } catch (error) {
        // Do not advance on failure. The failed event remains the next event
        // after lastCheckpoint, so replay() exposes it for retry.
        this.checkpoint = lastCheckpoint;
        return {
          applied,
          skipped,
          checkpoint: lastCheckpoint,
          failed: true,
          error,
        };
      }
      lastCheckpoint = checkpointFor(this.options.stream, event);
      this.checkpoint = lastCheckpoint;
      applied += 1;
    }

    this.checkpoint = lastCheckpoint;
    return {
      applied,
      skipped,
      checkpoint: lastCheckpoint,
      failed: false,
    };
  }

  resume(checkpoint?: ProjectorCheckpoint): ReplayResult {
    return this.replay(checkpoint);
  }

  replayFromBeginning(): ReplayResult {
    this.checkpoint = undefined;
    return this.replay();
  }
}

export function replayEvents(applyEvent: ApplyEvent, options: ReplayOptions): ReplayResult {
  return new EventProjector(applyEvent, options).replay();
}
