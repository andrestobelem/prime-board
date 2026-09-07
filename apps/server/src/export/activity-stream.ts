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
  /** ID estable de Issue. Los fixtures legacy pueden aportar solo `issue_identifier`. */
  readonly issue_id?: string;
  /** ID estable de Actor. Los fixtures legacy pueden aportar solo `actor`. */
  readonly actor_id?: string;
  readonly actor: string;
  readonly type: string;
  readonly payload: string;
  /** Workspace efectivo. Los fixtures legacy pueden omitirlo. */
  readonly workspace_id?: string | null;
  readonly occurred_at: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasActivityWorkspaceColumn(db: Database): boolean {
  const columns = db.query("PRAGMA table_info(activity)").all() as Array<{ name: string }>;
  return columns.some((column) => column.name === "workspace_id");
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
    // Activity se vincula a la fila Issue, no a su identificador mutable.
    // Conserva el identificador para el historial legible y lleva el UUID
    // estable para vincular Activity antes del snapshot Issue.
    const canonicalPayload = { ...payload };
    if (typeof row.issue_id === "string" && row.issue_id.trim().length > 0) {
      canonicalPayload.issueId = row.issue_id;
    }
    const event: Record<string, unknown> = {
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
      // Los IDs de Activity y Actor son inmutables. No uses el nombre mutable
      // como autor del evento canónico.
      eventId: row.id,
      aggregate: "issue",
      aggregateKey: row.issue_identifier,
      type: row.type,
      actor: row.actor_id ?? row.actor,
      occurredAt: row.occurred_at,
      payload: canonicalPayload,
    };
    if (typeof row.workspace_id === "string") event.workspaceId = row.workspace_id;
    return validateDomainEvent(event);
  } catch {
    // No copies payloads Activity malformados o sensibles al stream canónico.
    // La exportación de snapshots sigue siendo el límite del caller.
    return undefined;
  }
}

/**
 * Agrega la proyección Activity compartida al stream canónico. No importa
 * SQLite ni transforma los logs existentes por Issue.
 */
export function appendActivityEvents(
  db: Database,
  root: string,
  eventLog: Pick<CanonicalEventLog, "appendMany" | "read" | "recover"> = new EventLogWriter({
    rootDir: root,
  }),
  onEventIds?: (eventIds: readonly string[]) => void,
): number {
  const workspaceColumn = hasActivityWorkspaceColumn(db) ? "activity.workspace_id" : "NULL";
  const rows = db
    .query(
      `SELECT activity.id,
              teams.key || '-' || issues.number AS issue_identifier,
              activity.issue_id AS issue_id,
              activity.actor_id AS actor_id,
              actors.name AS actor,
              activity.type,
              activity.payload,
              ${workspaceColumn} AS workspace_id,
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
    // Incluye resultados idempotentes: otro proceso puede haber agregado el
    // evento antes de que fallara su commit Git. El committer valida el delta
    // contra HEAD e ignora IDs ya confirmados.
    onEventIds?.(results.map((result) => result.eventId));
  } catch (error) {
    // Una escritura por lote puede dejar un append parcial. Conserva solo IDs
    // aparecidos en este intento para que un retry posterior confirme el delta.
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
