import type { Database } from "bun:sqlite";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  EventLogWriter,
  type AppendResult,
  type DomainEvent,
  validateDomainEvent,
} from "./event-log.ts";
import type { CanonicalEventLog } from "./issue-event-pipeline.ts";

export interface ActivityEventRow {
  readonly id: string;
  readonly issue_identifier: string;
  /** Stable Actor ID. Legacy fixtures may provide only `actor`. */
  readonly actor_id?: string;
  readonly actor: string;
  readonly type: string;
  readonly payload: string;
  readonly occurred_at: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSharedActivityType(type: string): boolean {
  const normalized = type.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  return !(
    normalized.includes("secret") ||
    normalized.includes("apikey") ||
    normalized.includes("favorite") ||
    normalized.includes("inbox")
  );
}

/**
 * Translate one existing shared Activity row. Activity is the only SQLite
 * bridge in this slice. Per-issue historical log files are not read here.
 */
export function activityToDomainEvent(row: ActivityEventRow): DomainEvent | undefined {
  if (!isSharedActivityType(row.type)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload) as unknown;
  } catch {
    return undefined;
  }
  if (!isPlainObject(payload)) return undefined;
  try {
    return validateDomainEvent({
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
      // Activity IDs and Actor IDs are immutable. Do not use the mutable
      // display name as the canonical event author.
      eventId: row.id,
      aggregate: "issue",
      aggregateKey: row.issue_identifier,
      type: row.type,
      actor: row.actor_id ?? row.actor,
      occurredAt: row.occurred_at,
      payload,
    });
  } catch {
    // Never copy malformed or sensitive Activity payloads into the canonical
    // stream. The regular snapshot export remains the caller's boundary.
    return undefined;
  }
}

/**
 * Append the shared Activity projection to the canonical stream. This does not
 * import SQLite and does not transform the existing per-issue log files.
 */
export function appendActivityEvents(
  db: Database,
  root: string,
  eventLog: Pick<CanonicalEventLog, "appendMany" | "read" | "recover"> = new EventLogWriter({
    rootDir: root,
  }),
  onEventIds?: (eventIds: readonly string[]) => void,
): number {
  const rows = db
    .query(
      `SELECT activity.id,
              teams.key || '-' || issues.number AS issue_identifier,
              activity.actor_id AS actor_id,
              actors.name AS actor,
              activity.type,
              activity.payload,
              activity.created_at AS occurred_at
       FROM activity
       JOIN issues ON issues.id = activity.issue_id
       JOIN teams ON teams.id = issues.team_id
       JOIN actors ON actors.id = activity.actor_id
       ORDER BY activity.created_at, activity.id`,
    )
    .all() as ActivityEventRow[];
  eventLog.recover?.();
  const events = rows.flatMap((row) => {
    const event = activityToDomainEvent(row);
    return event ? [event] : [];
  });
  if (events.length === 0) return 0;
  const before = new Set(eventLog.read().map((event) => event.eventId));
  try {
    const results: AppendResult[] = eventLog.appendMany(events);
    // Include idempotent results: a previous process may have appended the
    // event before its Git commit failed. The committer validates the delta
    // against HEAD and ignores IDs that are already committed.
    onEventIds?.(results.map((result) => result.eventId));
  } catch (error) {
    // A batch write may leave a partial append. Preserve only IDs that appeared
    // during this attempt so a later retry can commit the partial delta.
    const after = new Set(eventLog.read().map((event) => event.eventId));
    onEventIds?.(
      events
        .filter((event) => !before.has(event.eventId) && after.has(event.eventId))
        .map((event) => event.eventId),
    );
    throw error;
  }
  return events.length;
}
