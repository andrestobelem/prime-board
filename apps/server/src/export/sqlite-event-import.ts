import type { Database } from "bun:sqlite";
import { EventLogWriter, type DomainEvent, validateDomainEvent } from "./event-log.ts";

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function warning(warnings: string[], kind: string, id: string): void {
  if (warnings.length < 100) warnings.push(`${kind}:${id}`);
}

function rowEvent(row: ActivityRow): DomainEvent | undefined {
  if (!row.issue_identifier || !row.actor || !row.issue_id || !row.team_id) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  try {
    return validateDomainEvent({
      schemaVersion: 1,
      eventId: row.id,
      aggregate: "issue",
      aggregateKey: row.issue_identifier,
      type: row.type,
      actor: row.actor,
      occurredAt: row.occurred_at,
      payload: parsed,
    });
  } catch {
    return undefined;
  }
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
  const existing = options.dryRun
    ? new Set<string>()
    : new Set(writer.read().map((event) => event.eventId));
  const seen = new Set<string>();
  const events: DomainEvent[] = [];
  let orphaned = 0;
  let rejected = 0;
  let ambiguous = 0;

  for (const row of rows) {
    if (!row.issue_identifier || !row.actor || !row.issue_id || !row.team_id) {
      orphaned += 1;
      warning(warnings, "orphaned", row.id);
      continue;
    }
    const event = rowEvent(row);
    if (!event) {
      rejected += 1;
      warning(warnings, "rejected", row.id);
      continue;
    }
    if (seen.has(event.eventId) || existing.has(event.eventId)) {
      if (seen.has(event.eventId)) ambiguous += 1;
      else existing.add(event.eventId);
      continue;
    }
    seen.add(event.eventId);
    events.push(event);
  }

  if (!options.dryRun) {
    for (const event of events) writer.append(event);
  }
  return {
    status: "completed",
    scanned: rows.length,
    emitted: options.dryRun ? events.length : events.length,
    duplicates: rows.length - orphaned - rejected - ambiguous - events.length,
    orphaned,
    rejected,
    ambiguous,
    warnings,
  };
}
