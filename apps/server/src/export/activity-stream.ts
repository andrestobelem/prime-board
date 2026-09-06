import type { Database } from "bun:sqlite";
import {
  areDomainEventsEquivalent,
  CURRENT_EVENT_SCHEMA_VERSION,
  EventLogWriter,
  isSensitiveEventName,
  type AppendResult,
  type DomainEvent,
  type JsonValue,
  validateDomainEvent,
} from "./event-log.ts";
import type { CanonicalEventLog } from "./issue-event-pipeline.ts";

export interface ActivityEventRow {
  readonly id: string;
  /** Referencia de presentación mutable que se conserva para lectores legacy. */
  readonly issue_identifier: string;
  /** ID estable del Issue. Los callers legacy pueden omitirlo. */
  readonly issue_id?: string;
  /** Stable Actor ID. Legacy fixtures may provide only `actor`. */
  readonly actor_id?: string;
  readonly actor: string;
  readonly type: string;
  readonly payload: string;
  /** Effective Workspace. Legacy fixtures may omit it. */
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
  return !isSensitiveEventName(type);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function withStableIssueReference(
  payload: Record<string, unknown>,
  issueId: string | undefined,
): Record<string, unknown> | undefined {
  if (hasOwn(payload, "issue_id") && typeof payload.issue_id !== "string") return undefined;
  if (issueId === undefined) return payload;
  if (hasOwn(payload, "issue_id") && payload.issue_id !== issueId) return undefined;
  if (hasOwn(payload, "issue_id")) return payload;
  return { ...payload, issue_id: issueId };
}

function withoutStableIssueReference(event: DomainEvent): DomainEvent {
  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(event.payload)) {
    if (key !== "issue_id") payload[key] = value;
  }
  return { ...event, payload };
}

function withoutMutableIssueIdentifier(event: DomainEvent): DomainEvent {
  return { ...event, aggregateKey: "activity-identifier", payload: event.payload };
}

/**
 * Compara eventos Activity y acepta el formato anterior a la referencia estable.
 *
 * Los eventos nuevos llevan `payload.issue_id`; un evento anterior puede no
 * llevarlo. Solo se ignora ese campo ausente; el resto del sobre y payload debe
 * coincidir. Cuando ambos registros llevan el ID estable, se ignora el
 * identificador de presentación para que un Team renombrado o un Issue
 * renumerado no cree un segundo evento Activity.
 */
export function areActivityEventsEquivalent(left: DomainEvent, right: DomainEvent): boolean {
  if (areDomainEventsEquivalent(left, right)) return true;
  if (left.aggregate !== "issue" || right.aggregate !== "issue") return false;
  const leftIssueId = left.payload.issue_id;
  const rightIssueId = right.payload.issue_id;
  if (typeof leftIssueId === "string" && leftIssueId === rightIssueId) {
    return areDomainEventsEquivalent(
      withoutMutableIssueIdentifier(withoutStableIssueReference(left)),
      withoutMutableIssueIdentifier(withoutStableIssueReference(right)),
    );
  }
  const leftHasIssueId = hasOwn(left.payload, "issue_id");
  const rightHasIssueId = hasOwn(right.payload, "issue_id");
  if (leftHasIssueId === rightHasIssueId) return false;
  const stableIssueId = leftHasIssueId ? leftIssueId : rightIssueId;
  if (typeof stableIssueId !== "string") return false;
  return areDomainEventsEquivalent(
    withoutStableIssueReference(left),
    withoutStableIssueReference(right),
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
  const stablePayload = withStableIssueReference(payload, row.issue_id);
  if (!stablePayload) return undefined;
  try {
    const event: Record<string, unknown> = {
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
      // Activity IDs and Actor IDs are immutable. Do not use the mutable
      // display name as the canonical event author.
      eventId: row.id,
      aggregate: "issue",
      // Conserva el identificador para callers legacy. `payload.issue_id` es la
      // referencia durable que usan los nuevos projectors.
      aggregateKey: row.issue_identifier,
      type: row.type,
      actor: row.actor_id ?? row.actor,
      occurredAt: row.occurred_at,
      payload: stablePayload,
    };
    if (typeof row.workspace_id === "string") event.workspaceId = row.workspace_id;
    return validateDomainEvent(event);
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
  const existing = new Map(eventLog.read().map((event) => [event.eventId, event]));
  const before = new Set(existing.keys());
  // Un registro legacy sin `payload.issue_id` permanece inmutable. Pasa ese
  // registro exacto al writer para que el puente de compatibilidad no lo reescriba.
  const appendEvents = events.map((event) => {
    const previous = existing.get(event.eventId);
    return previous && areActivityEventsEquivalent(previous, event) ? previous : event;
  });
  try {
    const results: AppendResult[] = eventLog.appendMany(appendEvents);
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
