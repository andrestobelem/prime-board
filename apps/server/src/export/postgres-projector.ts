import type { PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { type DomainEvent, type JsonObject, validateDomainEvent } from "./event-log.ts";

interface Row {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function value(payload: Row, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) return payload[key];
  }
  return undefined;
}

function stringValue(input: unknown): string | null {
  return typeof input === "string" && input.trim().length > 0 ? input : null;
}

function requiredString(payload: Row, ...keys: string[]): string {
  const result = stringValue(value(payload, ...keys));
  if (!result) throw new Error(`Canonical event is missing ${keys[0] ?? "a string field"}`);
  return result;
}

function numberValue(input: unknown, fallback: number): number {
  return typeof input === "number" && Number.isFinite(input) ? input : fallback;
}

function booleanValue(input: unknown, fallback: boolean): boolean {
  return typeof input === "boolean" ? input : fallback;
}

function sqlValue(input: unknown): SqlValue {
  if (input === null || input === undefined) return null;
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    return input;
  }
  if (typeof input === "bigint" || input instanceof Uint8Array) return input;
  return JSON.stringify(input);
}

function actorId(event: DomainEvent): string | null {
  if (typeof event.actor === "string") return event.actor;
  return stringValue(value(event.actor, "id", "actorId"));
}

function actorFromEvent(event: DomainEvent, id: string): { name: string; type: "human" | "agent" } {
  if (isRecord(event.actor) && stringValue(value(event.actor, "id", "actorId")) === id) {
    const actorType =
      stringValue(value(event.actor, "type"))?.toLowerCase() === "human" ? "human" : "agent";
    return { name: stringValue(value(event.actor, "name")) ?? id, type: actorType };
  }
  return { name: id, type: "agent" };
}

function isSyntheticActorId(id: string, displayName: string): boolean {
  return (
    id.toLowerCase() === displayName.toLowerCase() ||
    id.startsWith("actor:") ||
    id.startsWith("placeholder-actor:")
  );
}

async function ensureActor(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string | null,
  displayName?: string | null,
): Promise<void> {
  if (!id) return;
  const existing = await tx.one<{ id: string }>("SELECT id FROM actors WHERE id = $1", [id]);
  if (existing) return;
  const actor = actorFromEvent(event, id);
  const name = displayName ?? actor.name;
  const sameName = await tx.one<{ id: string }>(
    "SELECT id FROM actors WHERE lower(name) = lower($1) ORDER BY id LIMIT 1",
    [name],
  );
  let insertName = name;
  if (sameName && sameName.id !== id) {
    if (isSyntheticActorId(sameName.id, name)) {
      await tx.execute("UPDATE actors SET name = $1, updated_at = $2 WHERE id = $3", [
        `historical:${sameName.id}`,
        event.occurredAt,
        sameName.id,
      ]);
    } else {
      // Conserva el ID canónico aunque otro Actor ya use el nombre de origen.
      // El snapshot posterior del Actor puede restaurar su nombre.
      insertName = `historical:${id}`;
    }
  }
  await tx.execute(
    `INSERT INTO actors (id, name, type, workspace_role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'member', 'active', $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, insertName, actor.type, event.occurredAt],
  );
}

function eventType(event: DomainEvent, suffix: string): boolean {
  return (
    event.type === suffix ||
    event.type === `${event.aggregate}.${suffix}` ||
    event.type === `issue.${suffix}` ||
    event.type === `issues.${suffix}`
  );
}

function isSnapshotEvent(event: DomainEvent): boolean {
  return (
    event.type === "snapshot_imported" || event.type === `${event.aggregate}.snapshot_imported`
  );
}

function eventData(event: DomainEvent): Row {
  return event.payload;
}

function issueIdentifier(event: DomainEvent, payload: Row): string {
  return stringValue(value(payload, "identifier", "issueIdentifier")) ?? event.aggregateKey;
}

async function findIssueId(
  tx: PersistenceTransaction,
  event: DomainEvent,
  payload: Row,
): Promise<string | null> {
  const direct = stringValue(value(payload, "issueId", "issue_id", "id"));
  if (direct && !/^([A-Za-z][A-Za-z0-9]{0,7})-\d+$/u.test(direct)) {
    if (await tx.one<{ id: string }>("SELECT id FROM issues WHERE id = $1", [direct]))
      return direct;
    // Una importación Markdown puede crear una fila determinista por clave
    // natural antes del snapshot UUID. Prefiere esa fila para promoverla sin
    // violar UNIQUE(team_id, number).
  }
  const identifier = issueIdentifier(event, payload);
  const match = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/u.exec(identifier);
  if (!match || !event.workspaceId) return !match ? direct : null;
  const teamKey = match[1]!.toUpperCase();
  const row = await tx.one<{ id: string }>(
    `SELECT issues.id FROM issues JOIN teams ON teams.id = issues.team_id
       WHERE (lower(teams.key) = lower($1) OR lower(teams.key) = lower($2)) AND issues.number = $3
       ORDER BY CASE WHEN lower(teams.key) = lower($1) THEN 0 ELSE 1 END, issues.id LIMIT 1`,
    [teamKey, `historical:team:${teamKey}`, Number(match[2])],
  );
  return row?.id ?? (direct && !/^([A-Za-z][A-Za-z0-9]{0,7})-\d+$/u.test(direct) ? direct : null);
}

function historicalIssuePlaceholder(event: DomainEvent, identifier: string): string {
  const natural = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/u.exec(identifier);
  const normalizedIdentifier = natural ? `${natural[1]!.toUpperCase()}-${natural[2]}` : identifier;
  return `historical-issue:${event.workspaceId ?? "workspace"}:${normalizedIdentifier}`;
}

function hasCompleteIssuePayload(payload: Row): boolean {
  return (
    stringValue(value(payload, "teamId", "team_id")) !== null &&
    stringValue(value(payload, "stateId", "state_id")) !== null &&
    stringValue(value(payload, "title")) !== null &&
    numberValue(value(payload, "number"), 0) > 0
  );
}

function isHistoricalActivityEvent(event: DomainEvent, payload: Row): boolean {
  if (isSnapshotEvent(event)) return false;
  if (event.aggregate !== "issue" && event.aggregate !== "issues") return false;
  // Las exportaciones antiguas de Activity usan `created` sin calificar. Un
  // payload completo aún permite reconstruir el Issue; los eventos escasos
  // siguen siendo historial y usan un placeholder determinista.
  if (eventType(event, "created")) return !hasCompleteIssuePayload(payload);
  return ![
    "updated",
    "deleted",
    "archived",
    "unarchived",
    "relation_added",
    "relation_removed",
    "labeled",
    "unlabeled",
    "subscribed",
    "unsubscribed",
  ].some((suffix) => eventType(event, suffix));
}

async function findHistoricalIssueId(
  tx: PersistenceTransaction,
  event: DomainEvent,
  payload: Row,
): Promise<string | null> {
  const direct = await findIssueId(tx, event, payload);
  if (direct) return direct;
  const identifier = issueIdentifier(event, payload);
  return identifier ? historicalIssuePlaceholder(event, identifier) : null;
}

async function findExistingIssueReference(
  tx: PersistenceTransaction,
  event: DomainEvent,
  payload: Row,
): Promise<string | null> {
  const direct = stringValue(value(payload, "issueId", "issue_id", "id"));
  if (
    direct &&
    !/^([A-Za-z][A-Za-z0-9]{0,7})-\d+$/u.test(direct) &&
    (await tx.one<{ id: string }>("SELECT id FROM issues WHERE id = $1", [direct]))
  ) {
    return direct;
  }
  // Una referencia natural solo se puede reconciliar dentro de un Workspace
  // explícito. Sin ese alcance, no inspecciona ni promueve otra fuente.
  if (!event.workspaceId) return null;
  const identifier = issueIdentifier(event, payload);
  const match = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/u.exec(identifier);
  if (match) {
    const teamKey = match[1]!.toUpperCase();
    const row = await tx.one<{ id: string }>(
      `SELECT issues.id FROM issues JOIN teams ON teams.id = issues.team_id
       WHERE (lower(teams.key) = lower($1) OR lower(teams.key) = lower($2)) AND issues.number = $3
       ORDER BY CASE WHEN lower(teams.key) = lower($1) THEN 0 ELSE 1 END, issues.id LIMIT 1`,
      [teamKey, `historical:team:${teamKey}`, Number(match[2])],
    );
    if (row) return row.id;
  }
  const exact = historicalIssuePlaceholder(event, identifier);
  if (await tx.one<{ id: string }>("SELECT id FROM issues WHERE id = $1", [exact])) return exact;
  return null;
}

async function rebindHistoricalIssue(
  tx: PersistenceTransaction,
  event: DomainEvent,
  identifier: string,
  issueId: string,
): Promise<void> {
  // Nunca reasigna un placeholder sin un Workspace explícito. El proyector
  // PostgreSQL puede reproducirse desde varios Workspaces de origen.
  if (!event.workspaceId) return;
  const placeholder = historicalIssuePlaceholder(event, identifier);
  if (placeholder === issueId) return;
  if (!(await tx.one<{ id: string }>("SELECT id FROM issues WHERE id = $1", [placeholder]))) return;
  await rebindHistoricalIssueId(tx, placeholder, issueId);
}

async function rebindHistoricalIssueId(
  tx: PersistenceTransaction,
  placeholder: string,
  issueId: string,
): Promise<void> {
  // Las filas Activity se importan antes del snapshot del Issue porque el
  // orden canónico usa fecha/eventId. Reasigna cada FK antes de eliminar la
  // fila temporal.
  await tx.execute("UPDATE activity SET issue_id = $1 WHERE issue_id = $2", [issueId, placeholder]);
  await tx.execute("UPDATE comments SET issue_id = $1 WHERE issue_id = $2", [issueId, placeholder]);
  await tx.execute("UPDATE reviews SET issue_id = $1 WHERE issue_id = $2", [issueId, placeholder]);
  await tx.execute(
    `DELETE FROM issue_subscribers
     WHERE issue_id = $1
       AND actor_id IN (SELECT actor_id FROM issue_subscribers WHERE issue_id = $2)`,
    [placeholder, issueId],
  );
  await tx.execute("UPDATE issue_subscribers SET issue_id = $1 WHERE issue_id = $2", [
    issueId,
    placeholder,
  ]);
  await tx.execute(
    `DELETE FROM issue_labels
     WHERE issue_id = $1
       AND label_id IN (SELECT label_id FROM issue_labels WHERE issue_id = $2)`,
    [placeholder, issueId],
  );
  await tx.execute("UPDATE issue_labels SET issue_id = $1 WHERE issue_id = $2", [
    issueId,
    placeholder,
  ]);
  await rebindHistoricalRelations(tx, issueId, placeholder);
  await tx.execute("UPDATE issues SET parent_id = $1 WHERE parent_id = $2", [issueId, placeholder]);
  await tx.execute("DELETE FROM issues WHERE id = $1", [placeholder]);
  await tx.execute("DELETE FROM workflow_states WHERE id = $1", [
    `placeholder-state:${placeholder}`,
  ]);
  await tx.execute("DELETE FROM teams WHERE id = $1", [`placeholder-team:${placeholder}`]);
}

async function rebindHistoricalRelations(
  tx: PersistenceTransaction,
  issueId: string,
  placeholder: string,
): Promise<void> {
  const rows = await tx.many<{
    id: string;
    issue_id: string;
    related_id: string;
    type: string;
  }>(
    `SELECT id, issue_id, related_id, type FROM issue_relations
     WHERE issue_id = $1 OR related_id = $1 ORDER BY id`,
    [placeholder],
  );
  for (const row of rows) {
    let nextIssueId = row.issue_id === placeholder ? issueId : row.issue_id;
    let nextRelatedId = row.related_id === placeholder ? issueId : row.related_id;
    if (row.type === "related" && nextIssueId > nextRelatedId) {
      [nextIssueId, nextRelatedId] = [nextRelatedId, nextIssueId];
    }
    if (nextIssueId === nextRelatedId) {
      await tx.execute("DELETE FROM issue_relations WHERE id = $1", [row.id]);
      continue;
    }
    const duplicate = await tx.one<{ id: string }>(
      `SELECT id FROM issue_relations
       WHERE issue_id = $1 AND related_id = $2 AND type = $3 AND id <> $4`,
      [nextIssueId, nextRelatedId, row.type, row.id],
    );
    if (duplicate) {
      await tx.execute("DELETE FROM issue_relations WHERE id = $1", [row.id]);
      continue;
    }
    await tx.execute("UPDATE issue_relations SET issue_id = $1, related_id = $2 WHERE id = $3", [
      nextIssueId,
      nextRelatedId,
      row.id,
    ]);
  }
}

async function freePlaceholderIssueNumber(
  tx: PersistenceTransaction,
  teamId: string,
  sourceId: string,
): Promise<number> {
  let candidate = -placeholderNumber(sourceId);
  while (
    await tx.one<{ id: string }>(
      "SELECT id FROM issues WHERE team_id = $1 AND number = $2 AND id <> $3",
      [teamId, candidate, sourceId],
    )
  ) {
    candidate -= 1;
  }
  return candidate;
}

function promotionPayload(input: Row, existing: IssueRecord): Row {
  return {
    ...input,
    number: existing.number,
    title: existing.title,
    description: existing.description,
    priority: existing.priority,
    assigneeId: existing.assignee_id,
    parentId: existing.parent_id,
    projectId: existing.project_id,
    sortOrder: existing.sort_order,
    createdAt: existing.created_at,
    updatedAt: existing.updated_at,
    archivedAt: existing.archived_at,
    milestoneId: existing.milestone_id,
    cycleId: existing.cycle_id,
  };
}

async function promoteIssueId(
  tx: PersistenceTransaction,
  event: DomainEvent,
  sourceId: string,
  targetId: string,
  input: Row,
): Promise<void> {
  if (sourceId === targetId) return;
  const source = await tx.one<{ team_id: string; state_id: string }>(
    "SELECT team_id, state_id FROM issues WHERE id = $1",
    [sourceId],
  );
  const target = await tx.one<{ id: string }>("SELECT id FROM issues WHERE id = $1", [targetId]);
  if (!target) {
    // Libera la clave natural mientras se inserta la fila UUID canónica.
    // Las FK de Issue en PostgreSQL no usan ON UPDATE CASCADE. Mueve las
    // referencias solo después de crear ambas filas.
    const placeholder = source
      ? await freePlaceholderIssueNumber(tx, source.team_id, sourceId)
      : -placeholderNumber(sourceId);
    await tx.execute("UPDATE issues SET number = $1 WHERE id = $2", [placeholder, sourceId]);
    await insertIssue(tx, event, { ...input, id: targetId });
  }
  await tx.execute("UPDATE activity SET issue_id = $1 WHERE issue_id = $2", [targetId, sourceId]);
  await tx.execute("UPDATE comments SET issue_id = $1 WHERE issue_id = $2", [targetId, sourceId]);
  await tx.execute("UPDATE reviews SET issue_id = $1 WHERE issue_id = $2", [targetId, sourceId]);
  await tx.execute(
    `DELETE FROM issue_subscribers
     WHERE issue_id = $1
       AND actor_id IN (SELECT actor_id FROM issue_subscribers WHERE issue_id = $2)`,
    [sourceId, targetId],
  );
  await tx.execute("UPDATE issue_subscribers SET issue_id = $1 WHERE issue_id = $2", [
    targetId,
    sourceId,
  ]);
  await tx.execute(
    `DELETE FROM issue_labels
     WHERE issue_id = $1
       AND label_id IN (SELECT label_id FROM issue_labels WHERE issue_id = $2)`,
    [sourceId, targetId],
  );
  await tx.execute("UPDATE issue_labels SET issue_id = $1 WHERE issue_id = $2", [
    targetId,
    sourceId,
  ]);
  await rebindHistoricalRelations(tx, targetId, sourceId);
  await tx.execute("UPDATE issues SET parent_id = $1 WHERE parent_id = $2", [targetId, sourceId]);
  await tx.execute("DELETE FROM issues WHERE id = $1", [sourceId]);
  if (source) {
    await tx.execute(
      `DELETE FROM workflow_states
       WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM issues WHERE state_id = workflow_states.id)
         AND NOT EXISTS (SELECT 1 FROM teams WHERE default_state_id = workflow_states.id)`,
      [source.state_id],
    );
    await tx.execute(
      `DELETE FROM teams
       WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM issues WHERE team_id = teams.id)
         AND NOT EXISTS (SELECT 1 FROM workflow_states WHERE team_id = teams.id)
         AND NOT EXISTS (SELECT 1 FROM cycles WHERE team_id = teams.id)
         AND NOT EXISTS (SELECT 1 FROM labels WHERE team_id = teams.id)
         AND NOT EXISTS (SELECT 1 FROM project_teams WHERE team_id = teams.id)
         AND NOT EXISTS (SELECT 1 FROM team_memberships WHERE team_id = teams.id)
         AND NOT EXISTS (SELECT 1 FROM saved_views WHERE team_id = teams.id)
         AND NOT EXISTS (SELECT 1 FROM webhooks WHERE team_id = teams.id)
         AND NOT EXISTS (SELECT 1 FROM initiative_teams WHERE team_id = teams.id)
         AND NOT EXISTS (SELECT 1 FROM api_key_team_limits WHERE team_id = teams.id)`,
      [source.team_id],
    );
  }
  await tx.execute("DELETE FROM workflow_states WHERE id = $1", [`placeholder-state:${sourceId}`]);
  await tx.execute("DELETE FROM teams WHERE id = $1", [`placeholder-team:${sourceId}`]);
}

async function findIssueRef(
  tx: PersistenceTransaction,
  event: DomainEvent,
  reference: unknown,
): Promise<string | null> {
  const ref = stringValue(reference);
  if (!ref) return null;
  if (!/^([A-Za-z][A-Za-z0-9]{0,7})-\d+$/u.test(ref)) return ref;
  if (!event.workspaceId) return null;
  const match = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/u.exec(ref);
  if (!match) return ref;
  const teamKey = match[1]!.toUpperCase();
  const row = await tx.one<{ id: string }>(
    `SELECT issues.id FROM issues JOIN teams ON teams.id = issues.team_id
       WHERE (lower(teams.key) = lower($1) OR lower(teams.key) = lower($2)) AND issues.number = $3
       ORDER BY CASE WHEN lower(teams.key) = lower($1) THEN 0 ELSE 1 END, issues.id LIMIT 1`,
    [teamKey, `historical:team:${teamKey}`, Number(match[2])],
  );
  return row?.id ?? null;
}

/** Resuelve una referencia Issue sin perder un evento legacy que llega primero. */
async function resolveIssueRef(
  tx: PersistenceTransaction,
  event: DomainEvent,
  reference: unknown,
): Promise<string | null> {
  const ref = stringValue(reference);
  if (!ref) return null;
  const natural = /^([A-Za-z][A-Za-z0-9]{0,7})-\d+$/u.test(ref);
  const resolved = await findIssueRef(tx, event, ref);
  if (resolved) return resolved;
  if (natural && !event.workspaceId) return null;
  return natural ? historicalIssuePlaceholder(event, ref) : ref;
}

function relationStoredType(input: unknown): "blocks" | "related" | "duplicate_of" | null {
  if (input === "blocks" || input === "related" || input === "duplicate_of") return input;
  if (input === "blocked_by") return "blocks";
  if (input === "duplicated_by") return "duplicate_of";
  return null;
}

/** Convierte la perspectiva pública del extremo a una única dirección canónica. */
function relationEndpoints(
  sourceId: string,
  relatedId: string,
  input: unknown,
): { issueId: string; relatedId: string; type: "blocks" | "related" | "duplicate_of" } | null {
  if (input === "blocks") return { issueId: sourceId, relatedId, type: "blocks" };
  if (input === "blocked_by") return { issueId: relatedId, relatedId: sourceId, type: "blocks" };
  if (input === "duplicate_of") return { issueId: sourceId, relatedId, type: "duplicate_of" };
  if (input === "duplicated_by") {
    return { issueId: relatedId, relatedId: sourceId, type: "duplicate_of" };
  }
  if (input === "related") {
    return sourceId < relatedId
      ? { issueId: sourceId, relatedId, type: "related" }
      : { issueId: relatedId, relatedId: sourceId, type: "related" };
  }
  return null;
}

async function projectIssueRelation(
  tx: PersistenceTransaction,
  event: DomainEvent,
  payload: Row,
  sourceId: string | null,
): Promise<void> {
  const relationPayload = isRecord(value(payload, "relations"))
    ? value(payload, "relations")
    : payload;
  if (!isRecord(relationPayload)) return;
  const from = value(relationPayload, "from");
  const to = value(relationPayload, "to");
  const relation = isRecord(to)
    ? to
    : isRecord(from)
      ? from
      : isRecord(relationPayload)
        ? relationPayload
        : null;
  if (!relation || !sourceId) return;
  const type = value(relation, "type");
  const relatedReference = stringValue(value(relation, "issue", "relatedIssue", "relatedIssueId"));
  const relatedId = await resolveIssueRef(tx, event, relatedReference);
  if (!relatedId) return;
  const endpoints = relationEndpoints(sourceId, relatedId, type);
  if (!endpoints || endpoints.issueId === endpoints.relatedId) return;
  const removed = eventType(event, "relation_removed") || to === null;
  if (removed) {
    await tx.execute(
      "DELETE FROM issue_relations WHERE issue_id = $1 AND related_id = $2 AND type = $3",
      [endpoints.issueId, endpoints.relatedId, endpoints.type],
    );
    return;
  }
  // Un evento de relación puede preceder cualquiera de los snapshots Issue.
  // Crea filas técnicas para validar la FK y reasigna el extremo al llegar el snapshot.
  await ensureIssueReference(tx, event, relatedId);
  if (endpoints.issueId !== sourceId) await ensureIssueReference(tx, event, endpoints.issueId);
  if (endpoints.relatedId !== sourceId) await ensureIssueReference(tx, event, endpoints.relatedId);
  const relationId =
    stringValue(value(relation, "id", "relationId")) ??
    `${event.eventId}:${endpoints.type}:${endpoints.issueId}:${endpoints.relatedId}`;
  await tx.execute(
    `INSERT INTO issue_relations (id, issue_id, related_id, type, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (issue_id, related_id, type) DO UPDATE SET created_at = EXCLUDED.created_at`,
    [relationId, endpoints.issueId, endpoints.relatedId, endpoints.type, event.occurredAt],
  );
}

async function deleteIssue(tx: PersistenceTransaction, issueId: string): Promise<void> {
  // PostgreSQL mantiene estas FK restrictivas. Elimina dependencias en orden
  // y separa los hijos antes de eliminar el Issue de origen.
  await tx.execute("DELETE FROM issue_subscribers WHERE issue_id = $1", [issueId]);
  await tx.execute("DELETE FROM issue_labels WHERE issue_id = $1", [issueId]);
  await tx.execute("DELETE FROM issue_relations WHERE issue_id = $1 OR related_id = $1", [issueId]);
  await tx.execute("DELETE FROM reviews WHERE issue_id = $1", [issueId]);
  await tx.execute("DELETE FROM comments WHERE issue_id = $1", [issueId]);
  await tx.execute("DELETE FROM activity WHERE issue_id = $1", [issueId]);
  await tx.execute("UPDATE issues SET parent_id = NULL WHERE parent_id = $1", [issueId]);
  await tx.execute("DELETE FROM issues WHERE id = $1", [issueId]);
  await tx.execute("DELETE FROM workflow_states WHERE id = $1", [`placeholder-state:${issueId}`]);
  await tx.execute("DELETE FROM teams WHERE id = $1", [`placeholder-team:${issueId}`]);
}

async function projectIssue(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  if (isHistoricalActivityEvent(event, payload)) {
    const historicalIssueId = await findHistoricalIssueId(tx, event, payload);
    if (historicalIssueId) {
      await ensureIssueReference(tx, event, historicalIssueId);
      await projectActivity(tx, event, historicalIssueId);
    }
    return;
  }

  let sourceId = await findIssueId(tx, event, payload);
  const isRelationEvent =
    eventType(event, "relation_added") || eventType(event, "relation_removed");
  const isLabelEvent = eventType(event, "labeled") || eventType(event, "unlabeled");
  const isSubscriberEvent = eventType(event, "subscribed") || eventType(event, "unsubscribed");
  if (isRelationEvent || isLabelEvent || isSubscriberEvent) {
    // Los eventos Activity antiguos pueden preceder el snapshot Issue. Mantén
    // su fila técnica y reasígnala cuando llegue el snapshot real.
    const directReference = stringValue(value(payload, "issueId", "issue_id", "id"));
    const existingReference = await findExistingIssueReference(tx, event, payload);
    sourceId = existingReference ?? sourceId;
    if (directReference && !/^([A-Za-z][A-Za-z0-9]{0,7})-\d+$/u.test(directReference)) {
      sourceId ??= directReference;
    }
    sourceId ??= await findHistoricalIssueId(tx, event, payload);
    if (!sourceId) return;
    await ensureIssueReference(tx, event, sourceId);
    if (isRelationEvent) await projectIssueRelation(tx, event, payload, sourceId);
    if (isLabelEvent)
      await projectIssueLabel(tx, event, sourceId, payload, eventType(event, "unlabeled"));
    if (isSubscriberEvent)
      await projectIssueSubscriber(tx, event, sourceId, payload, eventType(event, "unsubscribed"));
    await projectActivity(tx, event, sourceId);
    return;
  }

  if (eventType(event, "deleted")) {
    let existing = sourceId
      ? await tx.one<IssueRecord>("SELECT * FROM issues WHERE id = $1", [sourceId])
      : null;
    if (!existing) {
      const historicalId = await findExistingIssueReference(tx, event, payload);
      if (historicalId) {
        sourceId = historicalId;
        existing = await tx.one<IssueRecord>("SELECT * FROM issues WHERE id = $1", [sourceId]);
      }
    }
    if (existing && sourceId && shouldApplyIssueState(event, payload, existing)) {
      await deleteIssue(tx, sourceId);
    }
    return;
  }

  if (eventType(event, "archived") || eventType(event, "unarchived")) {
    sourceId ??= await findHistoricalIssueId(tx, event, payload);
    if (!sourceId) return;
    let existing = await tx.one<IssueRecord>("SELECT * FROM issues WHERE id = $1", [sourceId]);
    if (!existing) {
      const historicalId = await findExistingIssueReference(tx, event, payload);
      if (historicalId && historicalId !== sourceId) {
        sourceId = historicalId;
        existing = await tx.one<IssueRecord>("SELECT * FROM issues WHERE id = $1", [sourceId]);
      }
    }
    await ensureIssueReference(tx, event, sourceId);
    if (!existing)
      existing = await tx.one<IssueRecord>("SELECT * FROM issues WHERE id = $1", [sourceId]);
    const canonicalId = stringValue(value(payload, "id", "issueId"));
    if (existing && canonicalId && canonicalId !== sourceId && hasCompleteIssuePayload(payload)) {
      if (!event.workspaceId)
        throw new Error(
          `Cannot promote Issue ${issueIdentifier(event, payload)} without Workspace`,
        );
      const promotionInput = shouldApplyIssueState(event, payload, existing)
        ? payload
        : promotionPayload(payload, existing);
      await promoteIssueId(tx, event, sourceId, canonicalId, promotionInput);
      sourceId = canonicalId;
      existing = await tx.one<IssueRecord>("SELECT * FROM issues WHERE id = $1", [sourceId]);
    }
    if (existing && shouldApplyIssueState(event, payload, existing))
      await updateIssue(tx, event, sourceId, existing, payload);
    if (isCanonicalIssueStateEvent(event)) {
      await cleanupIssueReferencePlaceholders(tx, sourceId);
      await rebindHistoricalIssue(tx, event, issueIdentifier(event, payload), sourceId);
    }
    await projectActivity(tx, event, sourceId);
    return;
  }

  // Una actualización canónica escasa puede apuntar al placeholder creado por
  // Activity antiguo. No usa este fallback para snapshots: inserta su ID explícito
  // y luego reasigna cada placeholder histórico.
  if (!sourceId && !isSnapshotEvent(event)) {
    sourceId = await findExistingIssueReference(tx, event, payload);
  }
  if (!sourceId) {
    if (
      (eventType(event, "updated") ||
        eventType(event, "archived") ||
        eventType(event, "unarchived")) &&
      !hasCompleteIssuePayload(payload)
    ) {
      throw new Error(`Cannot project Issue ${issueIdentifier(event, payload)} without its id`);
    }
    sourceId = await insertIssue(tx, event, payload);
  } else {
    let existing = await tx.one<IssueRecord>("SELECT * FROM issues WHERE id = $1", [sourceId]);
    // El puente Activity puede transportar un ID estable antes del placeholder
    // histórico. Prefiere un placeholder existente antes de insertar una
    // actualización escasa con ese ID.
    if (!existing && !isSnapshotEvent(event)) {
      const historicalId = await findExistingIssueReference(tx, event, payload);
      if (historicalId && historicalId !== sourceId) {
        sourceId = historicalId;
        existing = await tx.one<IssueRecord>("SELECT * FROM issues WHERE id = $1", [sourceId]);
      }
    }
    const canonicalId = stringValue(value(payload, "id", "issueId"));
    if (existing && canonicalId && canonicalId !== sourceId && hasCompleteIssuePayload(payload)) {
      if (!event.workspaceId)
        throw new Error(
          `Cannot promote Issue ${issueIdentifier(event, payload)} without Workspace`,
        );
      const promotionInput = shouldApplyIssueState(event, payload, existing)
        ? payload
        : promotionPayload(payload, existing);
      await promoteIssueId(tx, event, sourceId, canonicalId, promotionInput);
      sourceId = canonicalId;
      // La fila canónica puede existir antes que el placeholder histórico.
      // Actualízala con este snapshot completo antes de eliminar el origen duplicado.
      existing = await tx.one<IssueRecord>("SELECT * FROM issues WHERE id = $1", [sourceId]);
      if (existing && shouldApplyIssueState(event, payload, existing)) {
        await updateIssue(tx, event, sourceId, existing, payload);
      }
    } else if (
      !existing &&
      (eventType(event, "updated") ||
        eventType(event, "archived") ||
        eventType(event, "unarchived")) &&
      !hasCompleteIssuePayload(payload)
    ) {
      throw new Error(`Cannot project Issue ${issueIdentifier(event, payload)} without its id`);
    } else if (!existing) {
      sourceId = await insertIssue(tx, event, { ...payload, id: sourceId });
    } else if (shouldApplyIssueState(event, payload, existing)) {
      await updateIssue(tx, event, sourceId, existing, payload);
    }
  }

  // Un evento Issue canónico también puede ser el primero que vea un
  // placeholder histórico. Limpia sus FK sintéticas y reasigna dependencias
  // antes de avanzar el checkpoint.
  if (
    isSnapshotEvent(event) ||
    eventType(event, "created") ||
    (isCanonicalIssueStateEvent(event) && hasCompleteIssuePayload(payload))
  ) {
    await cleanupIssueReferencePlaceholders(tx, sourceId);
  }
  if (isCanonicalIssueStateEvent(event)) {
    await rebindHistoricalIssue(tx, event, issueIdentifier(event, payload), sourceId);
  }
  if (!isSnapshotEvent(event)) await projectActivity(tx, event, sourceId);
  await projectIssueRelationsFromPayload(tx, event, sourceId, payload);
  await projectIssueSubscribersFromPayload(tx, event, sourceId, payload);
}

function isCanonicalIssueStateEvent(event: DomainEvent): boolean {
  return (
    isSnapshotEvent(event) ||
    eventType(event, "created") ||
    eventType(event, "updated") ||
    eventType(event, "archived") ||
    eventType(event, "unarchived")
  );
}

interface IssueRecord extends Row {
  readonly id: string;
  readonly team_id: string;
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly state_id: string;
  readonly priority: number;
  readonly assignee_id: string | null;
  readonly parent_id: string | null;
  readonly project_id: string | null;
  readonly creator_id: string;
  readonly sort_order: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly milestone_id: string | null;
  readonly cycle_id: string | null;
}

async function ensureWorkspace(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
): Promise<void> {
  if (await tx.one<{ id: string }>("SELECT id FROM workspace WHERE id = $1", [id])) return;
  await tx.execute(
    `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
     VALUES ($1, $1, $1, $2, $2) ON CONFLICT (id) DO NOTHING`,
    [id, event.occurredAt],
  );
}

function placeholderNumber(id: string): number {
  let hash = 17;
  for (const character of id) hash = (hash * 31 + character.codePointAt(0)!) % 899999;
  return hash + 1;
}

async function ensureIssueReference(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
): Promise<void> {
  if (await tx.one<{ id: string }>("SELECT id FROM issues WHERE id = $1", [id])) return;
  const teamId = `placeholder-team:${id}`;
  // El ID técnico completo evita colisiones entre claves de Team. No trunques
  // el hash: Team.key es globalmente único aunque varios Issues sean escasos.
  const teamKey = teamId;
  const stateId = `placeholder-state:${id}`;
  const actor = actorId(event) ?? `placeholder-actor:${id}`;
  await ensureActor(tx, event, actor);
  await ensureTeam(tx, event, teamId, teamKey, 0);
  await ensureWorkflowState(tx, event, stateId, teamId, "Unstarted");
  await tx.execute(
    `INSERT INTO issues
       (id, team_id, number, title, state_id, priority, creator_id, sort_order, created_at, updated_at)
     VALUES ($1, $2, $3, $1, $4, 0, $5, 0, $6, $6) ON CONFLICT (id) DO NOTHING`,
    [id, teamId, placeholderNumber(id), stateId, actor, event.occurredAt],
  );
}

async function rebindTeamId(
  tx: PersistenceTransaction,
  sourceId: string,
  targetId: string,
): Promise<void> {
  if (sourceId === targetId) return;
  const sourceTeam = await tx.one<{
    default_state_id: string | null;
    next_issue_number: number;
  }>("SELECT default_state_id, next_issue_number FROM teams WHERE id = $1", [sourceId]);
  const targetTeam = await tx.one<{
    default_state_id: string | null;
    next_issue_number: number;
  }>("SELECT default_state_id, next_issue_number FROM teams WHERE id = $1", [targetId]);
  let sourceDefaultStateId = sourceTeam?.default_state_id ?? null;

  // Los números de Issue, nombres de State, números de Cycle y nombres de Label
  // tienen claves únicas por alcance. Vincula duplicados antes de mover las FK.
  const issueConflicts = await tx.many<{ source_id: string; target_id: string }>(
    `SELECT source.id AS source_id, target.id AS target_id
     FROM issues source
     JOIN issues target ON target.team_id = $1 AND target.number = source.number
     WHERE source.team_id = $2`,
    [targetId, sourceId],
  );
  for (const conflict of issueConflicts) {
    await rebindHistoricalIssueId(tx, conflict.source_id, conflict.target_id);
  }
  await tx.execute("UPDATE issues SET team_id = $1 WHERE team_id = $2", [targetId, sourceId]);

  const stateConflicts = await tx.many<{ source_id: string; target_id: string }>(
    `SELECT source.id AS source_id, target.id AS target_id
     FROM workflow_states source
     JOIN workflow_states target
       ON target.team_id = $1 AND lower(target.name) = lower(source.name)
     WHERE source.team_id = $2`,
    [targetId, sourceId],
  );
  for (const conflict of stateConflicts) {
    if (sourceDefaultStateId === conflict.source_id) sourceDefaultStateId = conflict.target_id;
    await tx.execute("UPDATE issues SET state_id = $1 WHERE state_id = $2", [
      conflict.target_id,
      conflict.source_id,
    ]);
    await tx.execute("UPDATE teams SET default_state_id = $1 WHERE default_state_id = $2", [
      conflict.target_id,
      conflict.source_id,
    ]);
    await tx.execute("DELETE FROM workflow_states WHERE id = $1", [conflict.source_id]);
  }
  await tx.execute("UPDATE workflow_states SET team_id = $1 WHERE team_id = $2", [
    targetId,
    sourceId,
  ]);
  await tx.execute("UPDATE teams SET default_state_id = $1 WHERE default_state_id = $2", [
    targetId,
    sourceId,
  ]);

  const cycleConflicts = await tx.many<{ source_id: string; target_id: string }>(
    `SELECT source.id AS source_id, target.id AS target_id
     FROM cycles source
     JOIN cycles target ON target.team_id = $1 AND target.number = source.number
     WHERE source.team_id = $2`,
    [targetId, sourceId],
  );
  for (const conflict of cycleConflicts) {
    await tx.execute("UPDATE issues SET cycle_id = $1 WHERE cycle_id = $2", [
      conflict.target_id,
      conflict.source_id,
    ]);
    await tx.execute("DELETE FROM cycles WHERE id = $1", [conflict.source_id]);
  }
  await tx.execute("UPDATE cycles SET team_id = $1 WHERE team_id = $2", [targetId, sourceId]);

  const labelConflicts = await tx.many<{ source_id: string; target_id: string }>(
    `SELECT source.id AS source_id, target.id AS target_id
     FROM labels source
     JOIN labels target
       ON target.team_id = $1 AND lower(target.name) = lower(source.name)
     WHERE source.team_id = $2`,
    [targetId, sourceId],
  );
  for (const conflict of labelConflicts) {
    await tx.execute(
      `DELETE FROM issue_labels
       WHERE label_id = $1
         AND EXISTS (SELECT 1 FROM issue_labels target
                     WHERE target.issue_id = issue_labels.issue_id AND target.label_id = $2)`,
      [conflict.source_id, conflict.target_id],
    );
    await tx.execute("UPDATE issue_labels SET label_id = $1 WHERE label_id = $2", [
      conflict.target_id,
      conflict.source_id,
    ]);
    await tx.execute("DELETE FROM labels WHERE id = $1", [conflict.source_id]);
  }
  await tx.execute("UPDATE labels SET team_id = $1 WHERE team_id = $2", [targetId, sourceId]);

  await tx.execute(
    `DELETE FROM project_teams
     WHERE team_id = $1
       AND EXISTS (SELECT 1 FROM project_teams target
                   WHERE target.project_id = project_teams.project_id AND target.team_id = $2)`,
    [sourceId, targetId],
  );
  await tx.execute("UPDATE project_teams SET team_id = $1 WHERE team_id = $2", [
    targetId,
    sourceId,
  ]);
  await tx.execute(
    `DELETE FROM team_memberships
     WHERE team_id = $1
       AND EXISTS (SELECT 1 FROM team_memberships target
                   WHERE target.actor_id = team_memberships.actor_id AND target.team_id = $2)`,
    [sourceId, targetId],
  );
  await tx.execute("UPDATE team_memberships SET team_id = $1 WHERE team_id = $2", [
    targetId,
    sourceId,
  ]);
  await tx.execute("UPDATE saved_views SET team_id = $1 WHERE team_id = $2", [targetId, sourceId]);
  await tx.execute("UPDATE webhooks SET team_id = $1 WHERE team_id = $2", [targetId, sourceId]);
  await tx.execute(
    `DELETE FROM initiative_teams
     WHERE team_id = $1
       AND EXISTS (SELECT 1 FROM initiative_teams target
                   WHERE target.initiative_id = initiative_teams.initiative_id AND target.team_id = $2)`,
    [sourceId, targetId],
  );
  await tx.execute("UPDATE initiative_teams SET team_id = $1 WHERE team_id = $2", [
    targetId,
    sourceId,
  ]);
  await tx.execute(
    `DELETE FROM api_key_team_limits
     WHERE team_id = $1
       AND EXISTS (SELECT 1 FROM api_key_team_limits target
                   WHERE target.api_key_id = api_key_team_limits.api_key_id AND target.team_id = $2)`,
    [sourceId, targetId],
  );
  await tx.execute("UPDATE api_key_team_limits SET team_id = $1 WHERE team_id = $2", [
    targetId,
    sourceId,
  ]);
  if (sourceDefaultStateId && !targetTeam?.default_state_id) {
    await tx.execute(
      "UPDATE teams SET default_state_id = $1 WHERE id = $2 AND default_state_id IS NULL",
      [sourceDefaultStateId, targetId],
    );
  }
  const highestIssue = await tx.one<{ max_number: number }>(
    "SELECT COALESCE(MAX(number), 0) AS max_number FROM issues WHERE team_id = $1",
    [targetId],
  );
  const nextIssueNumber = Math.max(
    1,
    sourceTeam?.next_issue_number ?? 1,
    targetTeam?.next_issue_number ?? 1,
    (highestIssue?.max_number ?? 0) + 1,
  );
  await tx.execute("UPDATE teams SET next_issue_number = $1 WHERE id = $2", [
    nextIssueNumber,
    targetId,
  ]);
  await tx.execute("DELETE FROM teams WHERE id = $1", [sourceId]);
}

function isSyntheticTeamId(id: string, key: string): boolean {
  return (
    id.startsWith("team:") ||
    id.startsWith("historical:team:") ||
    id.toLowerCase() === key.toLowerCase()
  );
}

async function ensureTeam(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
  key: string,
  nextIssueNumber: number,
): Promise<void> {
  const teamKey = /^[A-Za-z][A-Za-z0-9]{0,7}$/u.test(key) ? key.toUpperCase() : key;
  const canonical = await tx.one<{ id: string; key: string }>(
    "SELECT id, key FROM teams WHERE id = $1",
    [id],
  );
  const existingKey = await tx.one<{ id: string }>(
    "SELECT id, key FROM teams WHERE lower(key) = lower($1) ORDER BY id LIMIT 1",
    [teamKey],
  );
  const historicalKey = await tx.one<{ id: string }>("SELECT id FROM teams WHERE key = $1", [
    `historical:team:${teamKey}`,
  ]);
  const source =
    existingKey && existingKey.id !== id
      ? existingKey
      : historicalKey && historicalKey.id !== id
        ? historicalKey
        : null;
  if (source) {
    if (!event.workspaceId) {
      throw new Error(`Cannot rebind Team ${teamKey} without Workspace`);
    }
    if (!isSyntheticTeamId(source.id, teamKey))
      throw new Error(`Canonical event maps Team key ${teamKey} to two ids`);
    if (canonical) {
      await rebindTeamId(tx, source.id, id);
    } else {
      // Un Issue solo de Markdown puede haber materializado esta clave antes
      // del snapshot Team. Aparta la clave natural, crea el Team canónico y
      // mueve sus dependencias antes de retirar la fila sintética.
      if (existingKey?.id === source.id) {
        await tx.execute("UPDATE teams SET key = $1, name = $1 WHERE id = $2", [
          `historical:team:${teamKey}`,
          source.id,
        ]);
      }
    }
  }
  if (!canonical) {
    await tx.execute(
      `INSERT INTO teams (id, key, name, next_issue_number, created_at, updated_at)
       VALUES ($1, $2, $2, $3, $4, $4) ON CONFLICT (id) DO NOTHING`,
      [id, teamKey, Math.max(1, nextIssueNumber + 1), event.occurredAt],
    );
  }
  if (source && !canonical) await rebindTeamId(tx, source.id, id);
}

async function ensureWorkflowState(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
  teamId: string,
  name?: string,
): Promise<void> {
  const existing = await tx.one<{ id: string; team_id: string }>(
    "SELECT id, team_id FROM workflow_states WHERE id = $1",
    [id],
  );
  if (existing) {
    if (existing.team_id !== teamId)
      throw new Error(`Canonical State ${id} belongs to another Team`);
    return;
  }
  const stateName = name ?? id;
  const sameName = await tx.one<{ id: string }>(
    "SELECT id FROM workflow_states WHERE team_id = $1 AND lower(name) = lower($2)",
    [teamId, stateName],
  );
  if (sameName && sameName.id !== id) {
    if (sameName.id.startsWith("state:") || sameName.id.startsWith("placeholder-state:")) {
      await tx.execute("UPDATE workflow_states SET name = $1, updated_at = $2 WHERE id = $3", [
        `historical:${sameName.id}`,
        event.occurredAt,
        sameName.id,
      ]);
    } else {
      throw new Error(`Canonical event maps State name ${stateName} to two ids`);
    }
  }
  await tx.execute(
    `INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at)
     VALUES ($1, $2, $3, 'unstarted', '#000000', 0, $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, teamId, stateName, event.occurredAt],
  );
  if (sameName && sameName.id !== id) {
    // Mueve las FK antes de retirar el State natural. La fila canónica ya
    // existe, por lo que PostgreSQL mantiene sus restricciones inmediatas.
    await tx.execute("UPDATE issues SET state_id = $1 WHERE state_id = $2", [id, sameName.id]);
    await tx.execute("UPDATE teams SET default_state_id = $1 WHERE default_state_id = $2", [
      id,
      sameName.id,
    ]);
    await tx.execute(
      `DELETE FROM workflow_states
       WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM issues WHERE state_id = workflow_states.id)
         AND NOT EXISTS (SELECT 1 FROM teams WHERE default_state_id = workflow_states.id)`,
      [sameName.id],
    );
  }
}

async function resolveActorReference(
  tx: PersistenceTransaction,
  event: DomainEvent,
  input: Row,
  ...keys: string[]
): Promise<string | null> {
  const explicitReference = keys
    .filter(
      (key) =>
        key === "creatorId" ||
        key === "creator_id" ||
        key === "assigneeId" ||
        key === "assignee_id",
    )
    .map((key) => stringValue(value(input, key)))
    .find((reference): reference is string => Boolean(reference));
  const reference = explicitReference ?? stringValue(value(input, ...keys));
  if (!reference) return null;
  const byId = await tx.one<{ id: string }>("SELECT id FROM actors WHERE id = $1", [reference]);
  if (byId) return byId.id;
  if (!explicitReference) {
    const byName = await tx.one<{ id: string }>(
      "SELECT id FROM actors WHERE lower(name) = lower($1) ORDER BY id LIMIT 1",
      [reference],
    );
    if (byName) return byName.id;
  }
  // Markdown guarda el nombre natural del Actor y los snapshots canónicos
  // guardan su ID estable. Si aún no existe el snapshot Actor, la referencia es
  // la única identidad durable disponible para esta reproducción.
  await ensureActor(tx, event, reference, reference);
  return reference;
}

async function resolveProjectReference(
  tx: PersistenceTransaction,
  event: DomainEvent,
  input: Row,
): Promise<string | null> {
  const explicitReference = stringValue(value(input, "projectId", "project_id"));
  const reference = explicitReference ?? stringValue(value(input, "project"));
  if (!reference) return null;
  const byId = await tx.one<{ id: string }>("SELECT id FROM projects WHERE id = $1", [reference]);
  if (byId) return byId.id;
  if (!explicitReference) {
    const byName = await tx.one<{ id: string }>(
      "SELECT id FROM projects WHERE name = $1 ORDER BY id LIMIT 1",
      [reference],
    );
    if (byName) return byName.id;
  }
  await ensureProject(tx, event, reference, reference);
  return reference;
}

async function resolveMilestoneReference(
  tx: PersistenceTransaction,
  event: DomainEvent,
  input: Row,
  projectId: string | null,
): Promise<string | null> {
  const explicitReference = stringValue(value(input, "milestoneId", "milestone_id"));
  const reference = explicitReference ?? stringValue(value(input, "milestone"));
  if (!reference) return null;
  const byId = await tx.one<{ id: string }>("SELECT id FROM milestones WHERE id = $1", [reference]);
  if (byId) return byId.id;
  if (!explicitReference) {
    if (!projectId) throw new Error(`Canonical milestone ${reference} has no project`);
    const byName = await tx.one<{ id: string }>(
      "SELECT id FROM milestones WHERE project_id = $1 AND name = $2 ORDER BY id LIMIT 1",
      [projectId, reference],
    );
    if (byName) return byName.id;
  }
  return reference;
}

async function resolveCycleReference(
  tx: PersistenceTransaction,
  event: DomainEvent,
  input: Row,
  teamId: string,
): Promise<string | null> {
  const explicitReference = stringValue(value(input, "cycleId", "cycle_id"));
  const reference = explicitReference ?? stringValue(value(input, "cycle"));
  if (!reference) return null;
  const byId = await tx.one<{ id: string }>("SELECT id FROM cycles WHERE id = $1", [reference]);
  if (byId) return byId.id;
  if (!explicitReference) {
    const cycleNumber = Number.parseInt(reference.split("/").at(-1) ?? reference, 10);
    if (Number.isFinite(cycleNumber)) {
      const byNumber = await tx.one<{ id: string }>(
        "SELECT id FROM cycles WHERE team_id = $1 AND number = $2",
        [teamId, cycleNumber],
      );
      if (byNumber) return byNumber.id;
    }
  }
  return reference;
}

async function ensureProject(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
  name = id,
): Promise<void> {
  if (await tx.one<{ id: string }>("SELECT id FROM projects WHERE id = $1", [id])) return;
  await tx.execute(
    `INSERT INTO projects (id, name, state, created_at, updated_at)
     VALUES ($1, $2, 'backlog', $3, $3) ON CONFLICT (id) DO NOTHING`,
    [id, name, event.occurredAt],
  );
}

async function ensureMilestone(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string | null,
  projectId: string | null,
  input?: Row,
): Promise<string | null> {
  if (!id) return null;
  if (await tx.one<{ id: string }>("SELECT id FROM milestones WHERE id = $1", [id])) return id;
  if (!projectId) throw new Error(`Canonical milestone ${id} has no project`);
  await ensureProject(tx, event, projectId);
  const name =
    stringValue(input && value(input, "milestoneName", "milestone_name", "milestone")) ?? id;
  const sameName = await tx.one<{ id: string }>(
    "SELECT id FROM milestones WHERE project_id = $1 AND lower(name) = lower($2)",
    [projectId, name],
  );
  if (sameName && sameName.id !== id) {
    if (sameName.id === name || sameName.id.startsWith("milestone:")) {
      await tx.execute("UPDATE milestones SET name = $1, updated_at = $2 WHERE id = $3", [
        `historical:${sameName.id}`,
        event.occurredAt,
        sameName.id,
      ]);
    } else {
      throw new Error(`Canonical event maps Milestone ${name} to two ids`);
    }
  }
  await tx.execute(
    `INSERT INTO milestones (id, project_id, name, position, created_at, updated_at)
     VALUES ($1, $2, $3, 0, $4, $4) ON CONFLICT (id) DO NOTHING`,
    [id, projectId, name, event.occurredAt],
  );
  return id;
}

async function ensureCycle(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string | null,
  teamId: string,
  input: Row,
): Promise<string | null> {
  if (!id) return null;
  if (await tx.one<{ id: string }>("SELECT id FROM cycles WHERE id = $1", [id])) return id;
  // Un snapshot Issue puede referenciar un Cycle antes de que llegue su fila.
  // Usa un placeholder determinista y deja que el snapshot Cycle lo reemplace.
  const startsAt = stringValue(value(input, "startsAt", "starts_at")) ?? event.occurredAt;
  const endsAt = stringValue(value(input, "endsAt", "ends_at")) ?? event.occurredAt;
  const referenceNumber = Number.parseInt(id.split("/").at(-1) ?? id, 10);
  const cycleNumber = numberValue(
    value(input, "cycleNumber", "cycle_number", "number"),
    Number.isFinite(referenceNumber) ? referenceNumber : -placeholderNumber(id),
  );
  await ensureTeam(
    tx,
    event,
    teamId,
    stringValue(value(input, "team", "teamKey")) ?? teamId,
    cycleNumber,
  );
  const sameNumber = await tx.one<{ id: string }>(
    "SELECT id FROM cycles WHERE team_id = $1 AND number = $2",
    [teamId, cycleNumber],
  );
  if (sameNumber && sameNumber.id !== id) {
    if (sameNumber.id.startsWith("cycle:") || sameNumber.id.startsWith("placeholder-cycle:")) {
      let replacement = -placeholderNumber(sameNumber.id);
      while (
        replacement === cycleNumber ||
        (await tx.one<{ id: string }>("SELECT id FROM cycles WHERE team_id = $1 AND number = $2", [
          teamId,
          replacement,
        ]))
      ) {
        replacement -= 1;
      }
      await tx.execute("UPDATE cycles SET number = $1, updated_at = $2 WHERE id = $3", [
        replacement,
        event.occurredAt,
        sameNumber.id,
      ]);
    } else {
      throw new Error(`Canonical event maps Cycle number ${cycleNumber} to two ids`);
    }
  }
  await tx.execute(
    `INSERT INTO cycles (id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at)
     VALUES ($1, $2, $3, $1, $4, $5, 'upcoming', $6, $6) ON CONFLICT (id) DO NOTHING`,
    [id, teamId, cycleNumber, startsAt, endsAt, event.occurredAt],
  );
  return id;
}

async function resolveTeamReference(
  tx: PersistenceTransaction,
  input: Row,
  identifier: string,
): Promise<{ id: string; key: string }> {
  const explicitId = stringValue(value(input, "teamId", "team_id"));
  const naturalKey = stringValue(value(input, "team", "teamKey", "team_key"));
  const keyFromIdentifier = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/u.exec(identifier)?.[1];
  const key = (naturalKey ?? keyFromIdentifier ?? explicitId ?? "TEAM").toUpperCase();
  if (explicitId) {
    const byId = await tx.one<{ id: string; key: string }>(
      "SELECT id, key FROM teams WHERE id = $1",
      [explicitId],
    );
    if (byId) return byId;
    // Los IDs canónicos explícitos tienen precedencia sobre una referencia
    // Markdown natural. ensureTeam() aparta la clave técnica antes de insertar.
    return { id: explicitId, key };
  }
  if (naturalKey) {
    const byId = await tx.one<{ id: string; key: string }>(
      "SELECT id, key FROM teams WHERE id = $1",
      [naturalKey],
    );
    if (byId) return byId;
    const byKey = await tx.one<{ id: string; key: string }>(
      "SELECT id, key FROM teams WHERE lower(key) = lower($1)",
      [key],
    );
    if (byKey) return byKey;
  }
  return { id: `team:${key}`, key };
}

async function resolveStateReference(
  tx: PersistenceTransaction,
  input: Row,
  teamId: string,
): Promise<{ id: string; name: string }> {
  const explicitId = stringValue(value(input, "stateId", "state_id"));
  const name =
    stringValue(value(input, "state", "stateName", "state_name")) ?? explicitId ?? "Unstarted";
  if (explicitId) {
    const byId = await tx.one<{ id: string; name: string; team_id: string }>(
      "SELECT id, name, team_id FROM workflow_states WHERE id = $1",
      [explicitId],
    );
    // Un ID State explícito es autoritativo. Solo una identidad sintética
    // puede seguir el State canónico después de un rebind de Team.
    if (byId?.team_id === teamId) return { id: byId.id, name: byId.name };
    if (byId && byId.team_id !== teamId) {
      if (!explicitId.startsWith("state:") && !explicitId.startsWith("placeholder-state:")) {
        throw new Error(`Canonical State ${explicitId} belongs to another Team`);
      }
    }
    if (explicitId.startsWith("state:") || explicitId.startsWith("placeholder-state:")) {
      const byName = await tx.one<{ id: string; name: string }>(
        "SELECT id, name FROM workflow_states WHERE team_id = $1 AND lower(name) = lower($2)",
        [teamId, name],
      );
      if (byName) return byName;
    }
    if (byId) throw new Error(`Canonical State ${explicitId} belongs to another Team`);
    return { id: explicitId, name };
  }
  const byName = await tx.one<{ id: string; name: string }>(
    "SELECT id, name FROM workflow_states WHERE team_id = $1 AND lower(name) = lower($2)",
    [teamId, name],
  );
  if (byName) return byName;
  return { id: `state:${teamId}:${name}`, name };
}

async function insertIssue(
  tx: PersistenceTransaction,
  event: DomainEvent,
  input: Row,
): Promise<string> {
  const identifier = issueIdentifier(event, input);
  const match = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/u.exec(identifier);
  const number = numberValue(value(input, "number"), match ? Number(match[2]) : 0);
  if (number <= 0) throw new Error(`Canonical event is missing issue number for ${identifier}`);
  const id =
    stringValue(value(input, "id", "issueId")) ??
    `issue:${event.workspaceId ?? "workspace"}:${identifier}`;
  const dependencies = await ensureIssueDependencies(tx, event, input, id);
  await tx.execute(
    `INSERT INTO issues
       (id, team_id, number, title, description, state_id, priority, assignee_id, parent_id,
        project_id, creator_id, sort_order, created_at, updated_at, archived_at, milestone_id, cycle_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (id) DO UPDATE SET
       team_id = EXCLUDED.team_id, number = EXCLUDED.number, title = EXCLUDED.title,
       description = EXCLUDED.description, state_id = EXCLUDED.state_id, priority = EXCLUDED.priority,
       assignee_id = EXCLUDED.assignee_id, parent_id = EXCLUDED.parent_id, project_id = EXCLUDED.project_id,
       creator_id = EXCLUDED.creator_id, sort_order = EXCLUDED.sort_order,
       created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
       archived_at = EXCLUDED.archived_at, milestone_id = EXCLUDED.milestone_id, cycle_id = EXCLUDED.cycle_id`,
    [
      id,
      dependencies.teamId,
      number,
      stringValue(value(input, "title")) ?? identifier,
      stringValue(value(input, "description")),
      dependencies.stateId,
      numberValue(value(input, "priority"), 0),
      dependencies.assigneeId,
      dependencies.parentId,
      dependencies.projectId,
      dependencies.creatorId,
      numberValue(value(input, "sortOrder", "sort_order"), 0),
      stringValue(value(input, "createdAt", "created_at")) ?? event.occurredAt,
      stringValue(value(input, "updatedAt", "updated_at")) ?? event.occurredAt,
      stringValue(value(input, "archivedAt", "archived_at")),
      dependencies.milestoneId,
      dependencies.cycleId,
    ],
  );
  return id;
}

async function cleanupIssueReferencePlaceholders(
  tx: PersistenceTransaction,
  issueId: string,
): Promise<void> {
  // Las filas de relación/comentario pueden llegar antes del snapshot Issue.
  // Cuando la fila de origen actualiza el placeholder, sus Team y State sintéticos
  // quedan sin referencias y no deben permanecer en el tablero reconstruido.
  // Conserva una fila
  // cuando otra FK todavía la referencia; PostgreSQL impone esas FK.
  await tx.execute(
    `DELETE FROM workflow_states
     WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM issues WHERE state_id = workflow_states.id)
       AND NOT EXISTS (SELECT 1 FROM teams WHERE default_state_id = workflow_states.id)`,
    [`placeholder-state:${issueId}`],
  );
  await tx.execute(
    `DELETE FROM teams
     WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM issues WHERE team_id = teams.id)
       AND NOT EXISTS (SELECT 1 FROM workflow_states WHERE team_id = teams.id)
       AND NOT EXISTS (SELECT 1 FROM cycles WHERE team_id = teams.id)
       AND NOT EXISTS (SELECT 1 FROM labels WHERE team_id = teams.id)
       AND NOT EXISTS (SELECT 1 FROM project_teams WHERE team_id = teams.id)
       AND NOT EXISTS (SELECT 1 FROM team_memberships WHERE team_id = teams.id)
       AND NOT EXISTS (SELECT 1 FROM saved_views WHERE team_id = teams.id)
       AND NOT EXISTS (SELECT 1 FROM webhooks WHERE team_id = teams.id)
       AND NOT EXISTS (SELECT 1 FROM initiative_teams WHERE team_id = teams.id)
       AND NOT EXISTS (SELECT 1 FROM api_key_team_limits WHERE team_id = teams.id)`,
    [`placeholder-team:${issueId}`],
  );
}

interface PreparedIssueDependencies {
  readonly teamId: string;
  readonly teamKey: string;
  readonly stateId: string;
  readonly stateName: string;
  readonly creatorId: string;
  readonly assigneeId: string | null;
  readonly projectId: string | null;
  readonly milestoneId: string | null;
  readonly cycleId: string | null;
  readonly parentId: string | null;
}

async function ensureIssueDependencies(
  tx: PersistenceTransaction,
  event: DomainEvent,
  input: Row,
  issueId?: string,
): Promise<PreparedIssueDependencies> {
  const identifier = issueIdentifier(event, input);
  const team = await resolveTeamReference(tx, input, identifier);
  const number = numberValue(value(input, "number"), 0);
  // Rebind Team before resolving State: a synthetic State may have been moved
  // or merged while the canonical Team was materialized.
  await ensureTeam(tx, event, team.id, team.key, number);
  const state = await resolveStateReference(tx, input, team.id);
  await ensureWorkflowState(tx, event, state.id, team.id, state.name);

  const creatorId =
    (await resolveActorReference(tx, event, input, "creatorId", "creator_id", "creator")) ??
    actorId(event);
  if (!creatorId) throw new Error(`Canonical event is missing creator for ${identifier}`);
  await ensureActor(tx, event, creatorId);
  const assigneeId = await resolveActorReference(
    tx,
    event,
    input,
    "assigneeId",
    "assignee_id",
    "assignee",
  );

  const projectId = await resolveProjectReference(tx, event, input);
  const milestoneId = await ensureMilestone(
    tx,
    event,
    await resolveMilestoneReference(tx, event, input, projectId),
    projectId,
    input,
  );
  const cycleId = await ensureCycle(
    tx,
    event,
    await resolveCycleReference(tx, event, input, team.id),
    team.id,
    input,
  );
  const parentRef = stringValue(value(input, "parentId", "parent_id", "parent"));
  const selfIdentifier = issueIdentifier(event, input);
  if (
    parentRef &&
    (parentRef === issueId || parentRef.toUpperCase() === selfIdentifier.toUpperCase())
  ) {
    throw new Error(`Canonical Issue ${selfIdentifier} cannot be its own parent`);
  }
  const parentId = parentRef ? await resolveIssueRef(tx, event, parentRef) : null;
  if (parentId && parentId === issueId) {
    throw new Error(`Canonical Issue ${identifier} cannot be its own parent`);
  }
  if (parentId) await ensureIssueReference(tx, event, parentId);
  return {
    teamId: team.id,
    teamKey: team.key,
    stateId: state.id,
    stateName: state.name,
    creatorId,
    assigneeId,
    projectId,
    milestoneId,
    cycleId,
    parentId,
  };
}

function issueStateTimestamp(event: DomainEvent, payload: Row): number {
  const updatedAt = stringValue(value(payload, "updatedAt", "updated_at"));
  const timestamp = Date.parse(updatedAt ?? event.occurredAt);
  return Number.isFinite(timestamp) ? timestamp : Date.parse(event.occurredAt);
}

// El guard de fecha cubre solo columnas de estado del Issue. Las relaciones y
// suscripciones dependen del orden canónico del log y no se reordenan aquí.
function shouldApplyIssueState(event: DomainEvent, payload: Row, existing: IssueRecord): boolean {
  const currentTimestamp = Date.parse(existing.updated_at);
  const eventTimestamp = issueStateTimestamp(event, payload);
  return !Number.isFinite(currentTimestamp) || eventTimestamp >= currentTimestamp;
}

async function updateIssue(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
  existing: IssueRecord,
  input: Row,
): Promise<void> {
  const changeValue = value(input, "changes");
  const changes: Row = isRecord(changeValue) ? changeValue : {};
  const changed = (name: string, ...keys: string[]): unknown => {
    const inputKeys = keys.length > 0 ? keys : [name];
    if (inputKeys.some((key) => Object.prototype.hasOwnProperty.call(input, key))) {
      return value(input, ...inputKeys);
    }
    if (Object.prototype.hasOwnProperty.call(changes, name)) {
      const item = value(changes, name);
      return isRecord(item) && Object.prototype.hasOwnProperty.call(item, "to")
        ? item.to
        : undefined;
    }
    return undefined;
  };
  const nextValue = (candidate: unknown, fallback: unknown): unknown =>
    candidate === undefined ? fallback : candidate;
  // Los campos NOT NULL conservan su valor ante un `null` sparse. Solo los
  // campos nullable aceptan `null` como una orden de limpieza.
  const nextRequired = (candidate: unknown, fallback: unknown): unknown =>
    candidate === undefined || candidate === null ? fallback : candidate;
  const next = {
    teamId: nextRequired(changed("teamId", "teamId", "team_id"), existing.team_id),
    number: nextRequired(changed("number"), existing.number),
    title: nextRequired(changed("title"), existing.title),
    description: nextValue(changed("description"), existing.description),
    stateId: nextRequired(changed("stateId", "stateId", "state_id"), existing.state_id),
    priority: nextRequired(changed("priority"), existing.priority),
    assigneeId: nextValue(changed("assigneeId", "assigneeId", "assignee_id"), existing.assignee_id),
    parentId: nextValue(changed("parentId", "parentId", "parent_id"), existing.parent_id),
    projectId: nextValue(changed("projectId", "projectId", "project_id"), existing.project_id),
    creatorId: nextRequired(changed("creatorId", "creatorId", "creator_id"), existing.creator_id),
    sortOrder: nextRequired(changed("sortOrder", "sortOrder", "sort_order"), existing.sort_order),
    createdAt: nextRequired(changed("createdAt", "createdAt", "created_at"), existing.created_at),
    updatedAt: nextRequired(changed("updatedAt", "updatedAt", "updated_at"), event.occurredAt),
    archivedAt: nextValue(changed("archivedAt", "archivedAt", "archived_at"), existing.archived_at),
    milestoneId: nextValue(
      changed("milestoneId", "milestoneId", "milestone_id"),
      existing.milestone_id,
    ),
    cycleId: nextValue(changed("cycleId", "cycleId", "cycle_id"), existing.cycle_id),
  };
  if (eventType(event, "archived"))
    next.archivedAt = stringValue(value(input, "archivedAt", "archived_at")) ?? event.occurredAt;
  if (eventType(event, "unarchived")) next.archivedAt = null;
  const dependencies = await ensureIssueDependencies(
    tx,
    event,
    {
      ...input,
      teamId: next.teamId,
      number: next.number,
      stateId: next.stateId,
      assigneeId: next.assigneeId,
      parentId: next.parentId,
      projectId: next.projectId,
      creatorId: next.creatorId,
      sortOrder: next.sortOrder,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
      archivedAt: next.archivedAt,
      milestoneId: next.milestoneId,
      cycleId: next.cycleId,
    },
    id,
  );
  next.teamId = dependencies.teamId;
  next.stateId = dependencies.stateId;
  next.assigneeId = dependencies.assigneeId;
  next.parentId = dependencies.parentId;
  next.projectId = dependencies.projectId;
  next.creatorId = dependencies.creatorId;
  next.milestoneId = dependencies.milestoneId;
  next.cycleId = dependencies.cycleId;
  const numberConflict = await tx.one<{ id: string }>(
    "SELECT id FROM issues WHERE team_id = $1 AND number = $2 AND id <> $3",
    [sqlValue(next.teamId), sqlValue(next.number), id],
  );
  if (numberConflict)
    throw new Error(
      `Canonical Issue ${issueIdentifier(event, input)} conflicts with Issue ${numberConflict.id}`,
    );
  await tx.execute(
    `UPDATE issues SET team_id = $1, number = $2, title = $3, description = $4, state_id = $5,
       priority = $6, assignee_id = $7, parent_id = $8, project_id = $9, creator_id = $10,
       sort_order = $11, created_at = $12, updated_at = $13, archived_at = $14,
       milestone_id = $15, cycle_id = $16 WHERE id = $17`,
    [
      sqlValue(next.teamId),
      sqlValue(next.number),
      sqlValue(next.title),
      sqlValue(next.description),
      sqlValue(next.stateId),
      sqlValue(next.priority),
      sqlValue(next.assigneeId),
      sqlValue(next.parentId),
      sqlValue(next.projectId),
      sqlValue(next.creatorId),
      sqlValue(next.sortOrder),
      sqlValue(next.createdAt),
      sqlValue(next.updatedAt),
      sqlValue(next.archivedAt),
      sqlValue(next.milestoneId),
      sqlValue(next.cycleId),
      id,
    ],
  );
}

async function projectIssueSubscribersFromPayload(
  tx: PersistenceTransaction,
  event: DomainEvent,
  issueId: string,
  payload: Row,
): Promise<void> {
  const changes = value(payload, "changes");
  if (!isRecord(changes)) return;
  const subscription = value(changes, "subscribers");
  if (!isRecord(subscription)) return;
  const from = stringValue(value(subscription, "from"));
  const to = stringValue(value(subscription, "to"));
  if (to) {
    await projectIssueSubscriber(tx, event, issueId, { actorId: to }, false);
  } else if (from) {
    await projectIssueSubscriber(tx, event, issueId, { actorId: from }, true);
  }
}

async function projectIssueRelationsFromPayload(
  tx: PersistenceTransaction,
  event: DomainEvent,
  sourceId: string,
  payload: Row,
): Promise<void> {
  if (isRecord(value(payload, "relations"))) {
    await projectIssueRelation(tx, event, payload, sourceId);
  }
  const changes = value(payload, "changes");
  if (isRecord(changes) && isRecord(value(changes, "relations"))) {
    await projectIssueRelation(tx, event, { relations: value(changes, "relations") }, sourceId);
  }
}

async function ensureLabel(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
  payload: Row,
): Promise<void> {
  if (await tx.one<{ id: string }>("SELECT id FROM labels WHERE id = $1", [id])) return;
  const teamId = stringValue(value(payload, "labelTeamId", "teamId", "team_id"));
  if (teamId)
    await ensureTeam(
      tx,
      event,
      teamId,
      stringValue(value(payload, "team", "teamKey")) ?? teamId,
      0,
    );
  const name = stringValue(value(payload, "name", "label")) ?? id;
  if (teamId) {
    const sameName = await tx.one<{ id: string }>(
      "SELECT id FROM labels WHERE team_id = $1 AND lower(name) = lower($2)",
      [teamId, name],
    );
    if (sameName && sameName.id !== id) {
      if (sameName.id === name || sameName.id.startsWith("label:")) {
        await tx.execute("UPDATE labels SET name = $1 WHERE id = $2", [
          `historical:${sameName.id}`,
          sameName.id,
        ]);
      } else {
        throw new Error(`Canonical event maps Label ${name} to two ids`);
      }
    }
  }
  await tx.execute(
    `INSERT INTO labels (id, name, color, team_id, created_at)
     VALUES ($1, $2, '#000000', $3, $4) ON CONFLICT (id) DO NOTHING`,
    [id, name, teamId, event.occurredAt],
  );
}

async function projectIssueLabel(
  tx: PersistenceTransaction,
  event: DomainEvent,
  issueId: string,
  payload: Row,
  remove: boolean,
): Promise<void> {
  const labelId = stringValue(value(payload, "labelId", "label_id"));
  if (!labelId) return;
  await ensureLabel(tx, event, labelId, payload);
  if (remove) {
    await tx.execute("DELETE FROM issue_labels WHERE issue_id = $1 AND label_id = $2", [
      issueId,
      labelId,
    ]);
    return;
  }
  await tx.execute(
    "INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [issueId, labelId],
  );
}

async function projectIssueSubscriber(
  tx: PersistenceTransaction,
  event: DomainEvent,
  issueId: string,
  payload: Row,
  remove: boolean,
): Promise<void> {
  const subscriberId = stringValue(value(payload, "actorId", "actor_id")) ?? actorId(event);
  const workspaceId = event.workspaceId;
  if (!subscriberId || !workspaceId) return;
  await ensureWorkspace(tx, event, workspaceId);
  await ensureActor(tx, event, subscriberId);
  if (remove) {
    await tx.execute("DELETE FROM issue_subscribers WHERE issue_id = $1 AND actor_id = $2", [
      issueId,
      subscriberId,
    ]);
    return;
  }
  await tx.execute(
    `INSERT INTO issue_subscribers (issue_id, actor_id, workspace_id, created_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT (issue_id, actor_id) DO NOTHING`,
    [issueId, subscriberId, workspaceId, event.occurredAt],
  );
}

async function projectActivity(
  tx: PersistenceTransaction,
  event: DomainEvent,
  issueId: string,
): Promise<void> {
  const actor = actorId(event);
  if (!actor) return;
  await ensureActor(tx, event, actor);
  await tx.execute(
    `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, type = EXCLUDED.type`,
    [event.eventId, issueId, actor, event.type, JSON.stringify(event.payload), event.occurredAt],
  );
}

async function projectWorkspace(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  const id = stringValue(value(payload, "id")) ?? event.aggregateKey;
  const name = stringValue(value(payload, "name")) ?? id;
  const urlKey = stringValue(value(payload, "urlKey", "url_key")) ?? id.toLowerCase();
  await tx.execute(
    `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url_key = EXCLUDED.url_key, updated_at = EXCLUDED.updated_at`,
    [
      id,
      name,
      urlKey,
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
      stringValue(value(payload, "updatedAt", "updated_at")) ?? event.occurredAt,
    ],
  );
}

async function projectActor(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  const id = stringValue(value(payload, "id")) ?? event.aggregateKey;
  if (eventType(event, "deleted") || eventType(event, "revoked")) {
    await tx.execute(
      "UPDATE actors SET status = 'left', left_at = $1, updated_at = $1 WHERE id = $2",
      [event.occurredAt, id],
    );
    return;
  }
  const name = stringValue(value(payload, "name")) ?? id;
  const naturalActor = await tx.one<{ id: string }>(
    "SELECT id FROM actors WHERE lower(name) = lower($1) ORDER BY id LIMIT 1",
    [name],
  );
  let insertName = name;
  if (naturalActor && naturalActor.id !== id) {
    if (isSyntheticActorId(naturalActor.id, name)) {
      // Una importación Markdown puede usar el nombre visible como ID temporal.
      // Aparta solo esa fila determinista antes de insertar el Actor canónico.
      await tx.execute("UPDATE actors SET name = $1, updated_at = $2 WHERE id = $3", [
        `historical:${naturalActor.id}`,
        event.occurredAt,
        naturalActor.id,
      ]);
    } else {
      insertName = `historical:${id}`;
    }
  }
  await tx.execute(
    `INSERT INTO actors (id, name, email, type, avatar_url, workspace_role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
       type = EXCLUDED.type, avatar_url = EXCLUDED.avatar_url, workspace_role = EXCLUDED.workspace_role,
       status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
    [
      id,
      insertName,
      stringValue(value(payload, "email")),
      stringValue(value(payload, "type")) ?? "agent",
      stringValue(value(payload, "avatarUrl", "avatar_url")),
      stringValue(value(payload, "workspaceRole", "workspace_role")) ?? "member",
      stringValue(value(payload, "status")) ?? "active",
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
      stringValue(value(payload, "updatedAt", "updated_at")) ?? event.occurredAt,
    ],
  );
}

async function projectTeam(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  const id = stringValue(value(payload, "id", "teamId")) ?? event.aggregateKey;
  if (eventType(event, "deleted")) {
    // Conserva un tombstone. Otras filas reconstruidas aún pueden referenciar Team.
    await tx.execute("UPDATE teams SET archived_at = $1, updated_at = $1 WHERE id = $2", [
      event.occurredAt,
      id,
    ]);
    return;
  }
  const teamKey = (stringValue(value(payload, "key")) ?? event.aggregateKey).toUpperCase();
  await ensureTeam(
    tx,
    event,
    id,
    teamKey,
    numberValue(value(payload, "nextIssueNumber", "next_issue_number"), 1) - 1,
  );
  const defaultStateProvided =
    Object.prototype.hasOwnProperty.call(payload, "defaultStateId") ||
    Object.prototype.hasOwnProperty.call(payload, "default_state_id");
  const currentTeam = await tx.one<{ default_state_id: string | null }>(
    "SELECT default_state_id FROM teams WHERE id = $1",
    [id],
  );
  const defaultStateId = defaultStateProvided
    ? stringValue(value(payload, "defaultStateId", "default_state_id"))
    : (currentTeam?.default_state_id ?? null);
  const defaultState = defaultStateId
    ? await tx.one<{ id: string }>("SELECT id FROM workflow_states WHERE id = $1", [defaultStateId])
    : null;
  // `teams.default_state_id` y `workflow_states.team_id` forman un ciclo.
  // Inserta Team con default nulo y luego crea o actualiza la referencia State.
  await tx.execute(
    `INSERT INTO teams (id, key, name, description, next_issue_number, created_at, updated_at,
       default_state_id, archived_at, visibility, access_policy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key, name = EXCLUDED.name,
       description = EXCLUDED.description, updated_at = EXCLUDED.updated_at,
       default_state_id = EXCLUDED.default_state_id, archived_at = EXCLUDED.archived_at,
       visibility = EXCLUDED.visibility, access_policy = EXCLUDED.access_policy`,
    [
      id,
      teamKey,
      stringValue(value(payload, "name")) ?? event.aggregateKey,
      stringValue(value(payload, "description")),
      numberValue(value(payload, "nextIssueNumber", "next_issue_number"), 1),
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
      stringValue(value(payload, "updatedAt", "updated_at")) ?? event.occurredAt,
      defaultState ? defaultStateId : null,
      stringValue(value(payload, "archivedAt", "archived_at")),
      stringValue(value(payload, "visibility")) ?? "public",
      stringValue(value(payload, "accessPolicy", "access_policy")) ?? "team_members",
    ],
  );
  if (defaultStateId && !defaultState) {
    await ensureWorkflowState(tx, event, defaultStateId, id, "Unstarted");
    await tx.execute("UPDATE teams SET default_state_id = $1 WHERE id = $2", [defaultStateId, id]);
  }
}

async function projectWorkflowState(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  const id = requiredString(payload, "id");
  if (eventType(event, "deleted")) {
    // State tiene referencias restrictivas desde Issue y defaults Team.
    // Conserva un tombstone cancelado en vez de eliminar una fila referenciada.
    await tx.execute(
      "UPDATE workflow_states SET type = 'canceled', updated_at = $1 WHERE id = $2",
      [event.occurredAt, id],
    );
    return;
  }
  const teamId = requiredString(payload, "teamId", "team_id");
  await ensureTeam(
    tx,
    event,
    teamId,
    stringValue(value(payload, "team", "teamKey", "team_key")) ?? teamId,
    0,
  );
  await ensureWorkflowState(tx, event, id, teamId, stringValue(value(payload, "name")) ?? id);
  await tx.execute(
    `INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET team_id = EXCLUDED.team_id, name = EXCLUDED.name,
       type = EXCLUDED.type, color = EXCLUDED.color, position = EXCLUDED.position, updated_at = EXCLUDED.updated_at`,
    [
      id,
      teamId,
      stringValue(value(payload, "name")) ?? id,
      stringValue(value(payload, "type")) ?? "unstarted",
      stringValue(value(payload, "color")) ?? "#000000",
      numberValue(value(payload, "position"), 0),
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
      stringValue(value(payload, "updatedAt", "updated_at")) ?? event.occurredAt,
    ],
  );
}

async function projectProject(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  const id = stringValue(value(payload, "id", "projectId")) ?? event.aggregateKey;
  if (eventType(event, "deleted")) {
    // Issue, milestones, joins y favoritos pueden referenciar Project.
    // Conserva la fila como tombstone archivado para una reproducción segura.
    await tx.execute("UPDATE projects SET archived_at = $1, updated_at = $1 WHERE id = $2", [
      event.occurredAt,
      id,
    ]);
    return;
  }
  const leadId = stringValue(value(payload, "leadId", "lead_id"));
  await ensureActor(tx, event, leadId);
  await tx.execute(
    `INSERT INTO projects (id, name, description, state, lead_id, target_date, created_at, updated_at, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
       state = EXCLUDED.state, lead_id = EXCLUDED.lead_id, target_date = EXCLUDED.target_date,
       updated_at = EXCLUDED.updated_at, archived_at = EXCLUDED.archived_at`,
    [
      id,
      stringValue(value(payload, "name")) ?? id,
      stringValue(value(payload, "description")),
      stringValue(value(payload, "state")) ?? "backlog",
      leadId,
      stringValue(value(payload, "targetDate", "target_date")),
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
      stringValue(value(payload, "updatedAt", "updated_at")) ?? event.occurredAt,
      stringValue(value(payload, "archivedAt", "archived_at")),
    ],
  );
  const teams = value(payload, "teamIds", "team_ids");
  if (Array.isArray(teams)) {
    for (const team of teams) {
      const teamId = stringValue(team);
      if (teamId) await ensureTeam(tx, event, teamId, teamId, 0);
    }
    await tx.execute("DELETE FROM project_teams WHERE project_id = $1", [id]);
    for (const teamId of teams) {
      const resolved = stringValue(teamId);
      if (resolved)
        await tx.execute(
          "INSERT INTO project_teams (project_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [id, resolved],
        );
    }
  }
}

async function projectLabel(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  const id = requiredString(payload, "id", "labelId");
  if (eventType(event, "deleted")) {
    // Label tiene referencias restrictivas desde issue_labels y no tiene
    // columna tombstone. Conserva la fila para no violar esa FK.
    return;
  }
  const teamId = stringValue(value(payload, "teamId", "team_id"));
  if (teamId) {
    await ensureTeam(
      tx,
      event,
      teamId,
      stringValue(value(payload, "team", "teamKey", "team_key")) ?? teamId,
      0,
    );
  }
  await ensureLabel(tx, event, id, payload);
  await tx.execute(
    `INSERT INTO labels (id, name, color, team_id, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color, team_id = EXCLUDED.team_id`,
    [
      id,
      stringValue(value(payload, "name")) ?? id,
      stringValue(value(payload, "color")) ?? "#000000",
      teamId,
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
    ],
  );
}

async function projectCycle(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  const id = requiredString(payload, "id", "cycleId");
  if (eventType(event, "deleted")) {
    await tx.execute(
      "UPDATE cycles SET state = 'completed', archived_at = $1, updated_at = $1 WHERE id = $2",
      [event.occurredAt, id],
    );
    return;
  }
  const teamId = requiredString(payload, "teamId", "team_id");
  await ensureTeam(
    tx,
    event,
    teamId,
    stringValue(value(payload, "team", "teamKey", "team_key")) ?? teamId,
    numberValue(value(payload, "number"), 0),
  );
  await ensureCycle(tx, event, id, teamId, payload);
  await tx.execute(
    `INSERT INTO cycles (id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET team_id = EXCLUDED.team_id, number = EXCLUDED.number,
       name = EXCLUDED.name, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
       state = EXCLUDED.state, updated_at = EXCLUDED.updated_at, archived_at = EXCLUDED.archived_at`,
    [
      id,
      teamId,
      numberValue(value(payload, "number"), 0),
      stringValue(value(payload, "name")) ?? id,
      requiredString(payload, "startsAt", "starts_at"),
      requiredString(payload, "endsAt", "ends_at"),
      stringValue(value(payload, "state")) ?? "upcoming",
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
      stringValue(value(payload, "updatedAt", "updated_at")) ?? event.occurredAt,
      stringValue(value(payload, "archivedAt", "archived_at")),
    ],
  );
}

async function projectComment(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  const id = requiredString(payload, "id", "commentId");
  const issueReference = stringValue(
    value(payload, "issueId", "issue_id", "issueIdentifier", "issue_identifier"),
  );
  const issueId = issueReference ? await resolveIssueRef(tx, event, issueReference) : null;
  const authorId = stringValue(value(payload, "authorId", "author_id")) ?? actorId(event);
  if (!issueId || !authorId) throw new Error(`Canonical comment ${id} has no issue or author`);
  await ensureIssueReference(tx, event, issueId);
  await ensureActor(tx, event, authorId);
  await tx.execute(
    `INSERT INTO comments (id, issue_id, actor_id, body, created_at, edited_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET issue_id = EXCLUDED.issue_id, actor_id = EXCLUDED.actor_id,
       body = EXCLUDED.body, created_at = EXCLUDED.created_at, edited_at = EXCLUDED.edited_at`,
    [
      id,
      issueId,
      authorId,
      requiredString(payload, "body"),
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
      stringValue(value(payload, "editedAt", "edited_at")),
    ],
  );
  if (!isSnapshotEvent(event)) await projectActivity(tx, event, issueId);
}

function snapshotValue(payload: Row, ...keys: string[]): unknown {
  return value(payload, ...keys);
}

async function projectProjectTeam(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  const projectId = requiredString(payload, "projectId", "project_id");
  const teamId = requiredString(payload, "teamId", "team_id");
  if (eventType(event, "deleted")) {
    await tx.execute("DELETE FROM project_teams WHERE project_id = $1 AND team_id = $2", [
      projectId,
      teamId,
    ]);
    return;
  }
  await ensureProject(tx, event, projectId);
  await ensureTeam(
    tx,
    event,
    teamId,
    stringValue(snapshotValue(payload, "team", "teamKey", "team_key")) ?? teamId,
    0,
  );
  await tx.execute(
    "INSERT INTO project_teams (project_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [projectId, teamId],
  );
}

async function projectIssueLabelSnapshot(
  tx: PersistenceTransaction,
  event: DomainEvent,
): Promise<void> {
  const payload = eventData(event);
  const rawIssueId = requiredString(payload, "issueId", "issue_id");
  const issueId = (await resolveIssueRef(tx, event, rawIssueId)) ?? rawIssueId;
  const labelId = requiredString(payload, "labelId", "label_id");
  if (eventType(event, "deleted")) {
    await tx.execute("DELETE FROM issue_labels WHERE issue_id = $1 AND label_id = $2", [
      issueId,
      labelId,
    ]);
    return;
  }
  await ensureIssueReference(tx, event, issueId);
  await ensureLabel(tx, event, labelId, payload);
  await tx.execute(
    "INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [issueId, labelId],
  );
}

async function projectIssueRelationSnapshot(
  tx: PersistenceTransaction,
  event: DomainEvent,
): Promise<void> {
  const payload = eventData(event);
  const id = requiredString(payload, "id");
  const rawIssueId = requiredString(payload, "issueId", "issue_id");
  const rawRelatedId = requiredString(payload, "relatedId", "related_id");
  const issueResolved = await resolveIssueRef(tx, event, rawIssueId);
  const relatedResolved = await resolveIssueRef(tx, event, rawRelatedId);
  const issueId =
    issueResolved ??
    (/^([A-Za-z][A-Za-z0-9]{0,7})-\d+$/u.test(rawIssueId) && !event.workspaceId
      ? null
      : rawIssueId);
  const relatedId =
    relatedResolved ??
    (/^([A-Za-z][A-Za-z0-9]{0,7})-\d+$/u.test(rawRelatedId) && !event.workspaceId
      ? null
      : rawRelatedId);
  if (!issueId || !relatedId) return;
  const rawType = value(payload, "type");
  const type = relationStoredType(rawType);
  if (!type) throw new Error(`Canonical issue relation ${id} has an invalid type`);
  const endpoints = relationEndpoints(issueId, relatedId, rawType);
  if (!endpoints) throw new Error(`Canonical issue relation ${id} has an invalid type`);
  if (endpoints.issueId === endpoints.relatedId) {
    throw new Error(`Canonical issue relation ${id} cannot connect an Issue to itself`);
  }
  if (eventType(event, "deleted")) {
    await tx.execute("DELETE FROM issue_relations WHERE id = $1", [id]);
    await tx.execute(
      "DELETE FROM issue_relations WHERE issue_id = $1 AND related_id = $2 AND type = $3",
      [endpoints.issueId, endpoints.relatedId, endpoints.type],
    );
    return;
  }
  await ensureIssueReference(tx, event, endpoints.issueId);
  await ensureIssueReference(tx, event, endpoints.relatedId);
  const endpointRow = await tx.one<{ id: string }>(
    `SELECT id FROM issue_relations
     WHERE issue_id = $1 AND related_id = $2 AND type = $3`,
    [endpoints.issueId, endpoints.relatedId, endpoints.type],
  );
  const idRow = await tx.one<{ id: string }>("SELECT id FROM issue_relations WHERE id = $1", [id]);
  if (endpointRow && endpointRow.id !== id) {
    if (idRow) await tx.execute("DELETE FROM issue_relations WHERE id = $1", [endpointRow.id]);
    else await tx.execute("UPDATE issue_relations SET id = $1 WHERE id = $2", [id, endpointRow.id]);
  }
  await tx.execute(
    `INSERT INTO issue_relations (id, issue_id, related_id, type, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET issue_id = EXCLUDED.issue_id,
       related_id = EXCLUDED.related_id, type = EXCLUDED.type, created_at = EXCLUDED.created_at`,
    [
      id,
      endpoints.issueId,
      endpoints.relatedId,
      endpoints.type,
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
    ],
  );
}

async function ensureInitiativeReference(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
): Promise<void> {
  if (await tx.one<{ id: string }>("SELECT id FROM initiatives WHERE id = $1", [id])) return;
  await tx.execute(
    `INSERT INTO initiatives (id, name, state, created_at, updated_at)
     VALUES ($1, $1, 'planned', $2, $2) ON CONFLICT (id) DO NOTHING`,
    [id, event.occurredAt],
  );
}

async function projectInitiativeProject(
  tx: PersistenceTransaction,
  event: DomainEvent,
): Promise<void> {
  const payload = eventData(event);
  const initiativeId = requiredString(payload, "initiativeId", "initiative_id");
  const projectId = requiredString(payload, "projectId", "project_id");
  if (eventType(event, "deleted")) {
    await tx.execute(
      "DELETE FROM initiative_projects WHERE initiative_id = $1 AND project_id = $2",
      [initiativeId, projectId],
    );
    return;
  }
  await ensureInitiativeReference(tx, event, initiativeId);
  await ensureProject(tx, event, projectId);
  await tx.execute(
    "INSERT INTO initiative_projects (initiative_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [initiativeId, projectId],
  );
}

async function projectInitiativeTeam(
  tx: PersistenceTransaction,
  event: DomainEvent,
): Promise<void> {
  const payload = eventData(event);
  const initiativeId = requiredString(payload, "initiativeId", "initiative_id");
  const teamId = requiredString(payload, "teamId", "team_id");
  if (eventType(event, "deleted")) {
    await tx.execute("DELETE FROM initiative_teams WHERE initiative_id = $1 AND team_id = $2", [
      initiativeId,
      teamId,
    ]);
    return;
  }
  await ensureInitiativeReference(tx, event, initiativeId);
  await ensureTeam(
    tx,
    event,
    teamId,
    stringValue(snapshotValue(payload, "team", "teamKey", "team_key")) ?? teamId,
    0,
  );
  await tx.execute(
    "INSERT INTO initiative_teams (initiative_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [initiativeId, teamId],
  );
}

async function projectIssueSubscriberSnapshot(
  tx: PersistenceTransaction,
  event: DomainEvent,
): Promise<void> {
  const payload = eventData(event);
  const rawIssueId = requiredString(payload, "issueId", "issue_id");
  const issueId = (await resolveIssueRef(tx, event, rawIssueId)) ?? rawIssueId;
  const actor = requiredString(payload, "actorId", "actor_id");
  const workspaceId = requiredString(payload, "workspaceId", "workspace_id");
  if (eventType(event, "deleted")) {
    await tx.execute("DELETE FROM issue_subscribers WHERE issue_id = $1 AND actor_id = $2", [
      issueId,
      actor,
    ]);
    return;
  }
  await ensureIssueReference(tx, event, issueId);
  await ensureWorkspace(tx, event, workspaceId);
  await ensureActor(tx, event, actor);
  await tx.execute(
    `INSERT INTO issue_subscribers (issue_id, actor_id, workspace_id, created_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT (issue_id, actor_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id`,
    [
      issueId,
      actor,
      workspaceId,
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
    ],
  );
}

async function projectWorkspaceMembership(
  tx: PersistenceTransaction,
  event: DomainEvent,
): Promise<void> {
  const payload = eventData(event);
  const id = requiredString(payload, "id");
  const workspaceId = requiredString(payload, "workspaceId", "workspace_id");
  const actor = requiredString(payload, "actorId", "actor_id");
  if (eventType(event, "deleted")) {
    await tx.execute(
      "DELETE FROM workspace_memberships WHERE id = $1 OR (workspace_id = $2 AND actor_id = $3)",
      [id, workspaceId, actor],
    );
    return;
  }
  await ensureWorkspace(tx, event, workspaceId);
  await ensureActor(tx, event, actor);
  await ensureActor(tx, event, stringValue(value(payload, "suspendedBy", "suspended_by")));
  await tx.execute(
    `INSERT INTO workspace_memberships
       (id, workspace_id, actor_id, role, status, created_at, updated_at, suspended_at, suspended_by, left_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (workspace_id, actor_id) DO UPDATE SET id = EXCLUDED.id,
      workspace_id = EXCLUDED.workspace_id, actor_id = EXCLUDED.actor_id,
       role = EXCLUDED.role, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at,
       suspended_at = EXCLUDED.suspended_at, suspended_by = EXCLUDED.suspended_by, left_at = EXCLUDED.left_at`,
    [
      id,
      workspaceId,
      actor,
      stringValue(value(payload, "role")) ?? "member",
      stringValue(value(payload, "status")) ?? "active",
      stringValue(value(payload, "createdAt", "created_at")) ?? event.occurredAt,
      stringValue(value(payload, "updatedAt", "updated_at")) ?? event.occurredAt,
      stringValue(value(payload, "suspendedAt", "suspended_at")),
      stringValue(value(payload, "suspendedBy", "suspended_by")),
      stringValue(value(payload, "leftAt", "left_at")),
    ],
  );
}

async function projectSimpleRow(
  tx: PersistenceTransaction,
  event: DomainEvent,
  table:
    | "milestones"
    | "reviews"
    | "project_updates"
    | "team_memberships"
    | "saved_views"
    | "initiatives",
): Promise<void> {
  // Estos agregados tienen validaciones de dominio propias. El proyector solo
  // acepta filas completas y usa INSERT ... ON CONFLICT para que el retry sea seguro.
  const payload = eventData(event);
  const id = requiredString(payload, "id");
  if (eventType(event, "deleted")) {
    // Issue referencia Milestone y la tabla no tiene columna tombstone.
    // Conserva la fila para no violar la FK restrictiva.
    if (table === "milestones") return;
    await tx.execute(`DELETE FROM ${table} WHERE id = $1`, [id]);
    return;
  }
  const definitions: Record<
    typeof table,
    { columns: string[]; keys: string[]; defaults: SqlValue[] }
  > = {
    milestones: {
      columns: [
        "project_id",
        "name",
        "description",
        "target_date",
        "position",
        "created_at",
        "updated_at",
      ],
      keys: [
        "projectId",
        "name",
        "description",
        "targetDate",
        "position",
        "createdAt",
        "updatedAt",
      ],
      defaults: [null, id, null, null, 0, event.occurredAt, event.occurredAt],
    },
    reviews: {
      columns: ["issue_id", "requester_id", "reviewer_id", "status", "created_at", "updated_at"],
      keys: ["issueId", "requesterId", "reviewerId", "status", "createdAt", "updatedAt"],
      defaults: [
        null,
        actorId(event),
        actorId(event),
        "requested",
        event.occurredAt,
        event.occurredAt,
      ],
    },
    project_updates: {
      columns: ["project_id", "author_id", "health", "body", "risks", "created_at", "updated_at"],
      keys: ["projectId", "authorId", "health", "body", "risks", "createdAt", "updatedAt"],
      defaults: [null, actorId(event), "on_track", "", null, event.occurredAt, event.occurredAt],
    },
    team_memberships: {
      columns: ["team_id", "actor_id", "role", "created_at"],
      keys: ["teamId", "actorId", "role", "createdAt"],
      defaults: [null, actorId(event), "member", event.occurredAt],
    },
    saved_views: {
      columns: [
        "name",
        "scope",
        "team_id",
        "owner_id",
        "filter_json",
        "order_by",
        "group_by",
        "created_at",
        "updated_at",
        "archived_at",
        "columns_json",
      ],
      keys: [
        "name",
        "scope",
        "teamId",
        "ownerId",
        "filter",
        "orderBy",
        "groupBy",
        "createdAt",
        "updatedAt",
        "archivedAt",
        "columns",
      ],
      defaults: [
        id,
        "workspace",
        null,
        actorId(event),
        "{}",
        "CREATED_DESC",
        "state",
        event.occurredAt,
        event.occurredAt,
        null,
        "[]",
      ],
    },
    initiatives: {
      columns: [
        "name",
        "description",
        "state",
        "target_date",
        "created_at",
        "updated_at",
        "archived_at",
        "owner_id",
      ],
      keys: [
        "name",
        "description",
        "state",
        "targetDate",
        "createdAt",
        "updatedAt",
        "archivedAt",
        "ownerId",
      ],
      defaults: [
        id,
        null,
        "planned",
        null,
        event.occurredAt,
        event.occurredAt,
        null,
        actorId(event),
      ],
    },
  };
  const definition = definitions[table];
  const requiredColumns: Record<typeof table, string[]> = {
    milestones: ["projectId"],
    reviews: ["issueId", "requesterId", "reviewerId"],
    project_updates: ["projectId", "authorId"],
    team_memberships: ["teamId", "actorId"],
    saved_views: ["ownerId"],
    initiatives: [],
  };
  for (const key of requiredColumns[table]) {
    if (
      stringValue(
        value(
          payload,
          key,
          key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
        ),
      ) ??
      (key === "authorId" ||
      key === "requesterId" ||
      key === "reviewerId" ||
      key === "actorId" ||
      key === "ownerId"
        ? actorId(event)
        : null)
    ) {
      continue;
    }
    throw new Error(`Canonical ${table} event ${event.eventId} is missing ${key}`);
  }

  const projectId = stringValue(value(payload, "projectId", "project_id"));
  const reviewIssueReference = stringValue(value(payload, "issueId", "issue_id"));
  const reviewIssueId = reviewIssueReference
    ? await resolveIssueRef(tx, event, reviewIssueReference)
    : null;
  if (table === "milestones" || table === "project_updates") {
    if (projectId) await ensureProject(tx, event, projectId);
  }
  if (table === "milestones") await ensureMilestone(tx, event, id, projectId, payload);
  if (table === "project_updates") {
    await ensureActor(
      tx,
      event,
      stringValue(value(payload, "authorId", "author_id")) ?? actorId(event),
    );
  }
  if (table === "reviews") {
    if (reviewIssueId) await ensureIssueReference(tx, event, reviewIssueId);
    await ensureActor(
      tx,
      event,
      stringValue(value(payload, "requesterId", "requester_id")) ?? actorId(event),
    );
    await ensureActor(
      tx,
      event,
      stringValue(value(payload, "reviewerId", "reviewer_id")) ?? actorId(event),
    );
  }
  if (table === "team_memberships" || table === "saved_views") {
    const teamId = stringValue(value(payload, "teamId", "team_id"));
    if (teamId)
      await ensureTeam(
        tx,
        event,
        teamId,
        stringValue(value(payload, "team", "teamKey")) ?? teamId,
        0,
      );
    if (table === "team_memberships") {
      await ensureActor(
        tx,
        event,
        stringValue(value(payload, "actorId", "actor_id")) ?? actorId(event),
      );
    } else {
      await ensureActor(
        tx,
        event,
        stringValue(value(payload, "ownerId", "owner_id")) ?? actorId(event),
      );
    }
  }
  if (table === "initiatives") {
    await ensureActor(
      tx,
      event,
      stringValue(value(payload, "ownerId", "owner_id")) ?? actorId(event),
    );
    const projectIds = value(payload, "projectIds", "project_ids");
    if (Array.isArray(projectIds)) {
      for (const project of projectIds) {
        const projectRef = stringValue(project);
        if (projectRef) await ensureProject(tx, event, projectRef);
      }
    }
    const teamIds = value(payload, "teamIds", "team_ids");
    if (Array.isArray(teamIds)) {
      for (const team of teamIds) {
        const teamRef = stringValue(team);
        if (teamRef) await ensureTeam(tx, event, teamRef, teamRef, 0);
      }
    }
  }

  const requiredKeys = new Set(requiredColumns[table]);
  const values = definition.keys.map((key, index) => {
    const snakeKey = key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
    const aliases =
      table === "saved_views" && key === "filter"
        ? ["filter", "filterJson", "filter_json"]
        : table === "saved_views" && key === "columns"
          ? ["columns", "columnsJson", "columns_json"]
          : [key, snakeKey];
    const current =
      table === "reviews" && key === "issueId" ? reviewIssueId : value(payload, ...aliases);
    const fallback = definition.defaults[index] ?? null;
    // Un campo Actor requerido puede usar el Actor del evento, incluso cuando
    // un payload histórico lo codificó como null explícito.
    const resolved = requiredKeys.has(key) && current == null ? fallback : current;
    if (table === "saved_views" && (key === "filter" || key === "columns")) {
      if (resolved == null) return fallback;
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    }
    return sqlValue(resolved === undefined ? fallback : resolved);
  });

  const columns = ["id", ...definition.columns];
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(", ");
  const updates = definition.columns.map((column) => `${column} = EXCLUDED.${column}`).join(", ");
  const conflict = table === "team_memberships" ? "(team_id, actor_id)" : "(id)";
  await tx.execute(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT ${conflict} DO UPDATE SET ${updates}`,
    [id, ...values],
  );

  if (table === "initiatives") {
    const projectIds = value(payload, "projectIds", "project_ids");
    const teamIds = value(payload, "teamIds", "team_ids");
    if (Array.isArray(projectIds)) {
      await tx.execute("DELETE FROM initiative_projects WHERE initiative_id = $1", [id]);
      for (const projectId of projectIds) {
        const resolved = stringValue(projectId);
        if (resolved) {
          await tx.execute(
            "INSERT INTO initiative_projects (initiative_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [id, resolved],
          );
        }
      }
    }
    if (Array.isArray(teamIds)) {
      await tx.execute("DELETE FROM initiative_teams WHERE initiative_id = $1", [id]);
      for (const teamId of teamIds) {
        const resolved = stringValue(teamId);
        if (resolved) {
          await tx.execute(
            "INSERT INTO initiative_teams (initiative_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [id, resolved],
          );
        }
      }
    }
  }
}

async function assertWorkspaceScope(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const embedded = stringValue(value(event.payload, "workspaceId", "workspace_id"));
  if (embedded && !event.workspaceId) {
    throw new Error(`Canonical event with Workspace ${embedded} is missing event scope`);
  }
  if (embedded && embedded !== event.workspaceId) {
    throw new Error(`Canonical event Workspace ${embedded} does not match event scope`);
  }
  if (!event.workspaceId) return;
  if (event.aggregate === "workspace" || event.aggregate === "workspaces") {
    if (event.aggregateKey !== event.workspaceId) {
      throw new Error(
        `Canonical Workspace aggregate ${event.aggregateKey} does not match event scope`,
      );
    }
    const payloadId = stringValue(value(event.payload, "id"));
    if (payloadId && payloadId !== event.workspaceId) {
      throw new Error(`Canonical Workspace payload ${payloadId} does not match event scope`);
    }
  }
  const existing = await tx.one<{ id: string }>("SELECT id FROM workspace LIMIT 1");
  if (existing && existing.id !== event.workspaceId) {
    throw new Error(
      `Canonical event Workspace ${event.workspaceId} does not match PostgreSQL Workspace`,
    );
  }
}

/** Aplica un evento canónico a la proyección PostgreSQL. */
export async function applyCanonicalEvent(
  tx: PersistenceTransaction,
  input: DomainEvent,
): Promise<void> {
  const event = validateDomainEvent(input);
  await assertWorkspaceScope(tx, event);
  switch (event.aggregate) {
    case "workspace":
    case "workspaces":
      await projectWorkspace(tx, event);
      return;
    case "actor":
    case "actors":
      await projectActor(tx, event);
      return;
    case "team":
    case "teams":
      await projectTeam(tx, event);
      return;
    case "workflow_state":
    case "workflow_states":
    case "workflowState":
      await projectWorkflowState(tx, event);
      return;
    case "project":
    case "projects":
      await projectProject(tx, event);
      return;
    case "label":
    case "labels":
      await projectLabel(tx, event);
      return;
    case "cycle":
    case "cycles":
      await projectCycle(tx, event);
      return;
    case "issue":
    case "issues":
      await projectIssue(tx, event);
      return;
    case "project_team":
    case "project_teams":
    case "projectTeam":
      await projectProjectTeam(tx, event);
      return;
    case "issue_label":
    case "issue_labels":
    case "issueLabel":
      await projectIssueLabelSnapshot(tx, event);
      return;
    case "issue_relation":
    case "issue_relations":
    case "issueRelation":
      await projectIssueRelationSnapshot(tx, event);
      return;
    case "initiative_project":
    case "initiative_projects":
    case "initiativeProject":
      await projectInitiativeProject(tx, event);
      return;
    case "initiative_team":
    case "initiative_teams":
    case "initiativeTeam":
      await projectInitiativeTeam(tx, event);
      return;
    case "issue_subscriber":
    case "issue_subscribers":
    case "issueSubscriber":
      await projectIssueSubscriberSnapshot(tx, event);
      return;
    case "workspace_membership":
    case "workspace_memberships":
    case "workspaceMembership":
      await projectWorkspaceMembership(tx, event);
      return;
    case "comment":
    case "comments":
      await projectComment(tx, event);
      return;
    case "milestone":
    case "milestones":
      await projectSimpleRow(tx, event, "milestones");
      return;
    case "review":
    case "reviews":
      await projectSimpleRow(tx, event, "reviews");
      return;
    case "project_update":
    case "project_updates":
    case "projectUpdate":
      await projectSimpleRow(tx, event, "project_updates");
      return;
    case "team_membership":
    case "team_memberships":
    case "teamMembership":
      await projectSimpleRow(tx, event, "team_memberships");
      return;
    case "saved_view":
    case "saved_views":
    case "savedView":
      await projectSimpleRow(tx, event, "saved_views");
      return;
    case "initiative":
    case "initiatives":
      await projectSimpleRow(tx, event, "initiatives");
      return;
    case "favorite":
    case "favorites":
    case "inbox":
    case "inbox_receipt":
    case "inboxReceipt":
    case "api_key":
    case "webhook":
    case "webhook_secret":
      throw new Error(
        `Aggregate ${event.aggregate} is not part of the shared canonical projection`,
      );
    default:
      // Los eventos de extensiones pueden convivir en el Log. No se deben
      // convertir en escrituras de negocio si no existe un adapter explícito.
      return;
  }
}

export const projectCanonicalEvent = applyCanonicalEvent;
