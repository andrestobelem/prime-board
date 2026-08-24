import type { Database } from "bun:sqlite";
import { EventLogWriter, serializeDomainEvent, type DomainEvent } from "./event-log.ts";
import { activityToDomainEvent, type ActivityEventRow } from "./activity-stream.ts";

export interface SQLiteEventImportOptions {
  readonly db: Database;
  readonly rootDir: string;
  readonly dryRun?: boolean;
}

export interface SQLiteEventImportResult {
  readonly status: "completed";
  readonly scanned: number;
  readonly emitted: number;
  readonly duplicates: number;
  readonly orphaned: number;
  readonly rejected: number;
  readonly ambiguous: number;
  readonly warnings: readonly string[];
}

interface ActivityRow {
  readonly id: string;
  readonly issue_identifier: string | null;
  readonly actor: string | null;
  readonly issue_id: string | null;
  readonly team_id: string | null;
  readonly type: string;
  readonly payload: string;
  readonly occurred_at: string;
}

function warning(warnings: string[], kind: string, id: string): void {
  if (warnings.length < 100) warnings.push(`${kind}:${id}`);
}

/**
 * Import the durable history available in SQLite Activity into the canonical
 * event stream. It never reads legacy per-Issue logs and never talks to PG.
 */
export function importSqliteActivity(options: SQLiteEventImportOptions): SQLiteEventImportResult {
  const rows = options.db
    .query(
      `SELECT activity.id,
              teams.key || '-' || issues.number AS issue_identifier,
              actors.name AS actor,
              issues.id AS issue_id,
              teams.id AS team_id,
              activity.type,
              activity.payload,
              activity.created_at AS occurred_at
       FROM activity
       LEFT JOIN issues ON issues.id = activity.issue_id
       LEFT JOIN teams ON teams.id = issues.team_id
       LEFT JOIN actors ON actors.id = activity.actor_id
       ORDER BY activity.created_at, activity.id`,
    )
    .all() as ActivityRow[];

  const writer = new EventLogWriter({ rootDir: options.rootDir });
  const warnings: string[] = [];
  // Dry-run inspects the existing stream too. It never creates the file, but
  // it reports the same duplicate/conflict result as a real import.
  const existing = new Map(writer.read().map((event) => [event.eventId, event]));
  const seen = new Map<string, DomainEvent>();
  const events: DomainEvent[] = [];
  let orphaned = 0;
  let rejected = 0;
  let ambiguous = 0;
  let duplicates = 0;

  for (const row of rows) {
    if (!row.issue_identifier || !row.actor || !row.issue_id || !row.team_id) {
      orphaned += 1;
      warning(warnings, "orphaned", row.id);
      continue;
    }
    const event = activityToDomainEvent({
      id: row.id,
      issue_identifier: row.issue_identifier,
      actor: row.actor,
      type: row.type,
      payload: row.payload,
      occurred_at: row.occurred_at,
    } satisfies ActivityEventRow);
    if (!event) {
      rejected += 1;
      warning(warnings, "rejected", row.id);
      continue;
    }
    const previous = seen.get(event.eventId) ?? existing.get(event.eventId);
    if (previous) {
      if (serializeDomainEvent(previous) !== serializeDomainEvent(event)) {
        ambiguous += 1;
        warning(warnings, "ambiguous", event.eventId);
      } else {
        duplicates += 1;
      }
      continue;
    }
    seen.set(event.eventId, event);
    events.push(event);
  }

  if (!options.dryRun) {
    for (const event of events) writer.append(event);
  }
  return {
    status: "completed",
    scanned: rows.length,
    emitted: events.length,
    duplicates,
    orphaned,
    rejected,
    ambiguous,
    warnings,
  };
}
