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
import {
  normalizeSqliteResultRow,
  quoteSqliteIdentifier,
  sqliteColumnName,
  sqliteColumnNames,
} from "./sqlite-row.ts";

export interface ActivityEventRow {
  readonly id: string;
  /** Referencia de presentación mutable que se conserva para lectores legacy. */
  readonly issue_identifier: string;
  /** ID estable del Issue. Los callers legacy pueden omitirlo. */
  readonly issue_id?: string | null;
  /** Stable Actor ID. Legacy fixtures may provide only `actor`. */
  readonly actor_id?: string | null;
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

function assertUnambiguousTableColumns(db: Database, table: string): void {
  const metadata = sqliteColumnNames(db, table);
  if (metadata.kind === "ambiguous") {
    throw new Error(`${table} table has ambiguous column names`);
  }
  if (metadata.kind === "invalid") {
    throw new Error(`${table} table has invalid column metadata`);
  }
}

function activityWorkspaceColumn(db: Database): string | undefined {
  const lookup = sqliteColumnName(db, "activity", "workspace_id");
  if (lookup.kind === "ambiguous") {
    throw new Error("Activity table has ambiguous column names");
  }
  if (lookup.kind === "invalid") {
    throw new Error("Activity table has invalid column metadata");
  }
  return lookup.kind === "found" ? lookup.name : undefined;
}

export function isSharedActivityType(type: string): boolean {
  return !isSensitiveEventName(type);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizedActivityEventRow(value: unknown): ActivityEventRow | undefined {
  const row = normalizeSqliteResultRow(value);
  if (row === undefined) return undefined;
  const id = textValue(row.id);
  const issueIdentifier = textValue(row.issue_identifier);
  const issueId = textValue(row.issue_id);
  const actorId = textValue(row.actor_id);
  const actor = textValue(row.actor);
  const type = typeof row.type === "string" ? row.type : undefined;
  const payload = typeof row.payload === "string" ? row.payload : undefined;
  const occurredAt = typeof row.occurred_at === "string" ? row.occurred_at : undefined;
  let workspaceId: string | null | undefined;
  if (row.workspace_id === null || row.workspace_id === undefined) workspaceId = row.workspace_id;
  else workspaceId = textValue(row.workspace_id);
  if (
    id === undefined ||
    issueIdentifier === undefined ||
    issueId === undefined ||
    actorId === undefined ||
    actor === undefined ||
    type === undefined ||
    payload === undefined ||
    occurredAt === undefined ||
    (row.workspace_id !== null && row.workspace_id !== undefined && workspaceId === undefined)
  ) {
    return undefined;
  }
  return {
    id,
    issue_identifier: issueIdentifier,
    issue_id: issueId,
    actor_id: actorId,
    actor,
    type,
    payload,
    workspace_id: workspaceId,
    occurred_at: occurredAt,
  };
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

function withIssueIdentifierReference(
  payload: Record<string, unknown>,
  issueIdentifier: string,
  issueId: string | undefined,
): Record<string, unknown> | undefined {
  // Solo los eventos con ID estable necesitan conservar el identificador de
  // presentación en el payload. Los callers legacy sin issue_id mantienen su
  // forma anterior.
  if (issueId === undefined) return payload;
  if (hasOwn(payload, "issue_identifier")) {
    return typeof payload.issue_identifier === "string" ? payload : undefined;
  }
  return { ...payload, issue_identifier: issueIdentifier };
}

function withoutStableIssueReference(event: DomainEvent): DomainEvent {
  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(event.payload)) {
    if (key !== "issue_id") payload[key] = value;
  }
  return { ...event, payload };
}

function withoutMutableIssueIdentifier(event: DomainEvent): DomainEvent {
  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(event.payload)) {
    if (key !== "issue_identifier") payload[key] = value;
  }
  return { ...event, aggregateKey: "activity-identifier", payload };
}

/**
 * Compara eventos Activity y acepta el formato anterior a la referencia estable.
 *
 * Los eventos nuevos llevan `payload.issue_id` y usan ese ID como `aggregateKey`;
 * un evento anterior puede no llevarlo. Solo se ignoran esas referencias
 * ausentes, además del identificador de presentación, para que un Team
 * renombrado o una Issue renumerada no cree un segundo evento Activity.
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
    withoutMutableIssueIdentifier(withoutStableIssueReference(left)),
    withoutMutableIssueIdentifier(withoutStableIssueReference(right)),
  );
}

/**
 * Translate one existing shared Activity row. Activity is the only SQLite
 * bridge in this slice. Per-issue historical log files are not read here.
 */
export function activityToDomainEvent(row: ActivityEventRow): DomainEvent | undefined {
  if (
    typeof row.id !== "string" ||
    typeof row.issue_identifier !== "string" ||
    typeof row.actor !== "string" ||
    typeof row.type !== "string" ||
    typeof row.payload !== "string" ||
    typeof row.occurred_at !== "string" ||
    (row.issue_id !== undefined && row.issue_id !== null && typeof row.issue_id !== "string") ||
    (row.actor_id !== undefined && row.actor_id !== null && typeof row.actor_id !== "string") ||
    (row.workspace_id !== undefined &&
      row.workspace_id !== null &&
      typeof row.workspace_id !== "string")
  ) {
    return undefined;
  }
  if (!isSharedActivityType(row.type)) return undefined;
  const issueId = typeof row.issue_id === "string" ? row.issue_id : undefined;
  const actorId = typeof row.actor_id === "string" ? row.actor_id : undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload) as unknown;
  } catch {
    return undefined;
  }
  if (!isPlainObject(payload)) return undefined;
  const stablePayload = withStableIssueReference(payload, issueId);
  const canonicalPayload = stablePayload
    ? withIssueIdentifierReference(stablePayload, row.issue_identifier, issueId)
    : undefined;
  if (!canonicalPayload) return undefined;
  try {
    const event: Record<string, unknown> = {
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
      // Activity IDs and Actor IDs are immutable. Do not use the mutable
      // display name as the canonical event author.
      eventId: row.id,
      aggregate: "issue",
      // Usa el ID inmutable cuando está disponible. El identificador legible
      // puede cambiar si el Team se renombra o la Issue se renumera; queda en
      // payload.issue_identifier para lectores legacy y auditoría histórica.
      aggregateKey: issueId ?? row.issue_identifier,
      type: row.type,
      actor: actorId ?? row.actor,
      occurredAt: row.occurred_at,
      payload: canonicalPayload,
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
  for (const table of ["activity", "issues", "teams", "actors"]) {
    assertUnambiguousTableColumns(db, table);
  }
  const workspaceColumnName = activityWorkspaceColumn(db);
  const workspaceColumn =
    workspaceColumnName === undefined
      ? "NULL"
      : `activity.${quoteSqliteIdentifier(workspaceColumnName)}`;
  const rows = db
    .query(
      `SELECT activity.id AS id,
              teams.key || '-' || issues.number AS issue_identifier,
              activity.issue_id AS issue_id,
              activity.actor_id AS actor_id,
              actors.name AS actor,
              activity.type AS type,
              activity.payload AS payload,
              ${workspaceColumn} AS workspace_id,
              activity.created_at AS occurred_at
       FROM activity
       JOIN issues ON issues.id = activity.issue_id
       JOIN teams ON teams.id = issues.team_id
       JOIN actors ON actors.id = activity.actor_id
       ORDER BY activity.created_at, activity.id`,
    )
    .all() as unknown[];
  const normalizedRows = rows.map(normalizedActivityEventRow);
  eventLog.recover?.();
  const events = normalizedRows.flatMap((row) => {
    if (row === undefined) return [];
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
