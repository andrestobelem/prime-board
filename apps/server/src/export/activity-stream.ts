import type { Database } from "bun:sqlite";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  EventLogWriter,
  type DomainEvent,
  validateDomainEvent,
} from "./event-log.ts";

export interface ActivityEventRow {
  readonly id: string;
  readonly issue_identifier: string;
  readonly actor: string;
  readonly type: string;
  readonly payload: string;
  readonly occurred_at: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSharedActivityType(type: string): boolean {
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
      // Activity IDs are already immutable and unique. Keeping the ID directly
      // makes repeated exports idempotent without inventing a second identity.
      eventId: row.id,
      aggregate: "issue",
      aggregateKey: row.issue_identifier,
      type: row.type,
      actor: row.actor,
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
export function appendActivityEvents(db: Database, root: string): number {
  const rows = db
    .query(
      `SELECT activity.id,
              teams.key || '-' || issues.number AS issue_identifier,
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
  const events = rows.flatMap((row) => {
    const event = activityToDomainEvent(row);
    return event ? [event] : [];
  });
  if (events.length === 0) return 0;
  new EventLogWriter({ rootDir: root }).appendMany(events);
  return events.length;
}
