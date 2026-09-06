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

async function ensureActor(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string | null,
): Promise<void> {
  if (!id) return;
  const existing = await tx.one<{ id: string }>("SELECT id FROM actors WHERE id = $1", [id]);
  if (existing) return;
  const actor = actorFromEvent(event, id);
  await tx.execute(
    `INSERT INTO actors (id, name, type, workspace_role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'member', 'active', $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, actor.name, actor.type, event.occurredAt],
  );
}

function eventType(event: DomainEvent, suffix: string): boolean {
  return event.type === suffix || event.type === `${event.aggregate}.${suffix}`;
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
  if (direct && !/^([A-Za-z][A-Za-z0-9]{0,7})-\d+$/u.test(direct)) return direct;
  const identifier = issueIdentifier(event, payload);
  const match = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/u.exec(identifier);
  if (!match) return direct;
  const row = await tx.one<{ id: string }>(
    "SELECT issues.id FROM issues JOIN teams ON teams.id = issues.team_id WHERE teams.key = $1 AND issues.number = $2",
    [match[1]!.toUpperCase(), Number(match[2])],
  );
  return row?.id ?? null;
}

function historicalIssuePlaceholder(event: DomainEvent, identifier: string): string {
  return `historical-issue:${event.workspaceId ?? "workspace"}:${identifier}`;
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
  if (
    ["issue.created", "issue.updated", "issue.archived", "issue.unarchived"].includes(event.type)
  ) {
    return false;
  }
  if (event.type === "created" && hasCompleteIssuePayload(payload)) return false;
  return (
    (event.aggregate === "issue" || event.aggregate === "issues") &&
    ![
      "issue.deleted",
      "relation_added",
      "relation_removed",
      "labeled",
      "unlabeled",
      "subscribed",
      "unsubscribed",
    ].includes(event.type)
  );
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

async function rebindHistoricalIssue(
  tx: PersistenceTransaction,
  event: DomainEvent,
  identifier: string,
  issueId: string,
): Promise<void> {
  const placeholder = historicalIssuePlaceholder(event, identifier);
  if (placeholder === issueId) return;
  if (!(await tx.one<{ id: string }>("SELECT id FROM issues WHERE id = $1", [placeholder]))) return;
  // Activity rows are imported before the source Issue snapshot because the
  // canonical ordering is by timestamp/eventId. Rebind every possible FK
  // before dropping the temporary source row.
  await tx.execute("UPDATE activity SET issue_id = $1 WHERE issue_id = $2", [issueId, placeholder]);
  await tx.execute("UPDATE comments SET issue_id = $1 WHERE issue_id = $2", [issueId, placeholder]);
  await tx.execute("UPDATE reviews SET issue_id = $1 WHERE issue_id = $2", [issueId, placeholder]);
  await tx.execute("UPDATE issue_subscribers SET issue_id = $1 WHERE issue_id = $2", [
    issueId,
    placeholder,
  ]);
  await tx.execute("UPDATE issue_labels SET issue_id = $1 WHERE issue_id = $2", [
    issueId,
    placeholder,
  ]);
  await tx.execute("UPDATE issue_relations SET issue_id = $1 WHERE issue_id = $2", [
    issueId,
    placeholder,
  ]);
  await tx.execute("UPDATE issue_relations SET related_id = $1 WHERE related_id = $2", [
    issueId,
    placeholder,
  ]);
  await tx.execute("UPDATE issues SET parent_id = $1 WHERE parent_id = $2", [issueId, placeholder]);
  await tx.execute("DELETE FROM issues WHERE id = $1", [placeholder]);
  await tx.execute("DELETE FROM workflow_states WHERE id = $1", [
    `placeholder-state:${placeholder}`,
  ]);
  await tx.execute("DELETE FROM teams WHERE id = $1", [`placeholder-team:${placeholder}`]);
}

async function findIssueRef(
  tx: PersistenceTransaction,
  reference: unknown,
): Promise<string | null> {
  const ref = stringValue(reference);
  if (!ref) return null;
  if (!/^([A-Za-z][A-Za-z0-9]{0,7})-\d+$/u.test(ref)) return ref;
  const match = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/u.exec(ref);
  if (!match) return ref;
  const row = await tx.one<{ id: string }>(
    "SELECT issues.id FROM issues JOIN teams ON teams.id = issues.team_id WHERE teams.key = $1 AND issues.number = $2",
    [match[1]!.toUpperCase(), Number(match[2])],
  );
  return row?.id ?? null;
}

function relationStoredType(input: unknown): "blocks" | "related" | "duplicate_of" | null {
  if (input === "blocks" || input === "related" || input === "duplicate_of") return input;
  if (input === "blocked_by") return "blocks";
  if (input === "duplicated_by") return "duplicate_of";
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
  const relation = isRecord(to) ? to : isRecord(from) ? from : null;
  if (!relation || !sourceId) return;
  const type = relationStoredType(value(relation, "type"));
  const relatedId = await findIssueRef(
    tx,
    value(relation, "issue", "relatedIssue", "relatedIssueId"),
  );
  if (!type || !relatedId) return;
  const removed = to === null;
  if (removed) {
    await tx.execute(
      "DELETE FROM issue_relations WHERE issue_id = $1 AND related_id = $2 AND type = $3",
      [sourceId, relatedId, type],
    );
    return;
  }
  const relationId = stringValue(value(relation, "id", "relationId")) ?? `${event.eventId}:${type}`;
  await tx.execute(
    `INSERT INTO issue_relations (id, issue_id, related_id, type, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (issue_id, related_id, type) DO UPDATE SET created_at = EXCLUDED.created_at`,
    [relationId, sourceId, relatedId, type, event.occurredAt],
  );
}

async function projectIssue(tx: PersistenceTransaction, event: DomainEvent): Promise<void> {
  const payload = eventData(event);
  const type = event.type;
  if (isHistoricalActivityEvent(event, payload)) {
    const historicalIssueId = await findHistoricalIssueId(tx, event, payload);
    if (historicalIssueId) {
      await ensureIssueReference(tx, event, historicalIssueId);
      await projectActivity(tx, event, historicalIssueId);
    }
    return;
  }
  const sourceId = await findIssueId(tx, event, payload);
  if (type === "issue.deleted" || type === "deleted") {
    if (sourceId) await tx.execute("DELETE FROM issues WHERE id = $1", [sourceId]);
    return;
  }
  if (type === "relation_added" || type === "relation_removed") {
    if (sourceId) {
      await projectIssueRelation(tx, event, payload, sourceId);
      if (!isSnapshotEvent(event)) await projectActivity(tx, event, sourceId);
    }
    return;
  }
  if (type === "labeled" || type === "unlabeled") {
    if (sourceId) {
      await projectIssueLabel(tx, event, sourceId, payload, type === "unlabeled");
      if (!isSnapshotEvent(event)) await projectActivity(tx, event, sourceId);
    }
    return;
  }
  if (type === "subscribed" || type === "unsubscribed") {
    if (sourceId) {
      await projectIssueSubscriber(tx, event, sourceId, payload, type === "unsubscribed");
      if (!isSnapshotEvent(event)) await projectActivity(tx, event, sourceId);
    }
    return;
  }
  if (!sourceId) {
    if (type === "issue.updated" || type === "issue.archived" || type === "issue.unarchived") {
      throw new Error(`Cannot project Issue ${issueIdentifier(event, payload)} without its id`);
    }
    await insertIssue(tx, event, payload);
    return;
  }
  const existing = await tx.one<IssueRecord>("SELECT * FROM issues WHERE id = $1", [sourceId]);
  if (!existing) {
    await insertIssue(tx, event, { ...payload, id: sourceId });
  } else {
    if (isSnapshotEvent(event)) await ensureIssueSnapshotDependencies(tx, event, payload);
    await updateIssue(tx, event, sourceId, existing, payload);
    if (isSnapshotEvent(event)) await cleanupIssueReferencePlaceholders(tx, sourceId);
  }
  if (!isSnapshotEvent(event)) await projectActivity(tx, event, sourceId);
  if (isSnapshotEvent(event)) {
    await rebindHistoricalIssue(tx, event, issueIdentifier(event, payload), sourceId);
  }
  await projectIssueRelationsFromPayload(tx, event, sourceId, payload);
  await projectIssueSubscribersFromPayload(tx, event, sourceId, payload);
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
  const teamKey = `P${placeholderNumber(id)}`.slice(0, 8).toUpperCase();
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

async function ensureTeam(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
  key: string,
  nextIssueNumber: number,
): Promise<void> {
  if (await tx.one<{ id: string }>("SELECT id FROM teams WHERE id = $1", [id])) return;
  const existingKey = await tx.one<{ id: string }>("SELECT id FROM teams WHERE key = $1", [key]);
  if (existingKey && existingKey.id !== id) {
    throw new Error(`Canonical event maps Team key ${key} to two ids`);
  }
  await tx.execute(
    `INSERT INTO teams (id, key, name, next_issue_number, created_at, updated_at)
     VALUES ($1, $2, $2, $3, $4, $4) ON CONFLICT (id) DO NOTHING`,
    [id, key, Math.max(1, nextIssueNumber + 1), event.occurredAt],
  );
}

async function ensureWorkflowState(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
  teamId: string,
  name?: string,
): Promise<void> {
  if (await tx.one<{ id: string }>("SELECT id FROM workflow_states WHERE id = $1", [id])) return;
  await tx.execute(
    `INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at)
     VALUES ($1, $2, $4, 'unstarted', '#000000', 0, $3, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, teamId, event.occurredAt, name ?? id],
  );
}

async function ensureProject(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string,
): Promise<void> {
  if (await tx.one<{ id: string }>("SELECT id FROM projects WHERE id = $1", [id])) return;
  await tx.execute(
    `INSERT INTO projects (id, name, state, created_at, updated_at)
     VALUES ($1, $1, 'backlog', $2, $2) ON CONFLICT (id) DO NOTHING`,
    [id, event.occurredAt],
  );
}

async function ensureMilestone(
  tx: PersistenceTransaction,
  event: DomainEvent,
  id: string | null,
  projectId: string | null,
): Promise<string | null> {
  if (!id) return null;
  if (await tx.one<{ id: string }>("SELECT id FROM milestones WHERE id = $1", [id])) return id;
  if (!projectId) throw new Error(`Canonical milestone ${id} has no project`);
  await ensureProject(tx, event, projectId);
  await tx.execute(
    `INSERT INTO milestones (id, project_id, name, position, created_at, updated_at)
     VALUES ($1, $2, $1, 0, $3, $3) ON CONFLICT (id) DO NOTHING`,
    [id, projectId, event.occurredAt],
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
  // An Issue snapshot may reference a Cycle before the Cycle row arrives.
  // Use a deterministic placeholder and let the Cycle snapshot replace it.
  const startsAt = stringValue(value(input, "startsAt", "starts_at")) ?? event.occurredAt;
  const endsAt = stringValue(value(input, "endsAt", "ends_at")) ?? event.occurredAt;
  const cycleNumber = numberValue(value(input, "number"), -placeholderNumber(id));
  await ensureTeam(
    tx,
    event,
    teamId,
    stringValue(value(input, "team", "teamKey")) ?? teamId,
    cycleNumber,
  );
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
  const raw = stringValue(value(input, "teamId", "team_id", "team", "teamKey", "team_key"));
  const keyFromIdentifier = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/u.exec(identifier)?.[1];
  const key = (
    stringValue(value(input, "team", "teamKey", "team_key")) ??
    keyFromIdentifier ??
    raw ??
    "TEAM"
  ).toUpperCase();
  if (raw) {
    const byId = await tx.one<{ id: string; key: string }>(
      "SELECT id, key FROM teams WHERE id = $1",
      [raw],
    );
    if (byId) return { id: byId.id, key: byId.key };
    const byKey = await tx.one<{ id: string; key: string }>(
      "SELECT id, key FROM teams WHERE key = $1",
      [key],
    );
    if (byKey) return { id: byKey.id, key: byKey.key };
  }
  const id = raw && raw !== key ? raw : `team:${key}`;
  return { id, key };
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
    const byId = await tx.one<{ id: string; name: string }>(
      "SELECT id, name FROM workflow_states WHERE id = $1",
      [explicitId],
    );
    if (byId) return byId;
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
): Promise<void> {
  const identifier = issueIdentifier(event, input);
  const match = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/u.exec(identifier);
  const number = numberValue(value(input, "number"), match ? Number(match[2]) : 0);
  if (number <= 0) throw new Error(`Canonical event is missing issue number for ${identifier}`);
  const id =
    stringValue(value(input, "id", "issueId")) ??
    `issue:${event.workspaceId ?? "workspace"}:${identifier}`;
  const team = await resolveTeamReference(tx, input, identifier);
  const teamId = team.id;
  const state = await resolveStateReference(tx, input, teamId);
  const stateId = state.id;
  const creatorId = stringValue(value(input, "creatorId", "creator_id")) ?? actorId(event);
  if (!creatorId) throw new Error(`Canonical event is missing creator for ${identifier}`);
  await ensureActor(tx, event, creatorId);
  const assigneeId = stringValue(value(input, "assigneeId", "assignee_id"));
  await ensureActor(tx, event, assigneeId);
  const teamKey = team.key;
  await ensureTeam(tx, event, teamId, teamKey, number);
  await ensureWorkflowState(tx, event, stateId, teamId, state.name);
  const projectId = stringValue(value(input, "projectId", "project_id"));
  if (projectId) await ensureProject(tx, event, projectId);
  const milestoneRef = stringValue(value(input, "milestoneId", "milestone_id"));
  const milestoneId = await ensureMilestone(tx, event, milestoneRef, projectId);
  const cycleRef = stringValue(value(input, "cycleId", "cycle_id"));
  const cycleId = await ensureCycle(tx, event, cycleRef, teamId, input);
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
      teamId,
      number,
      stringValue(value(input, "title")) ?? identifier,
      stringValue(value(input, "description")),
      stateId,
      numberValue(value(input, "priority"), 0),
      assigneeId,
      stringValue(value(input, "parentId", "parent_id")),
      projectId,
      creatorId,
      numberValue(value(input, "sortOrder", "sort_order"), 0),
      stringValue(value(input, "createdAt", "created_at")) ?? event.occurredAt,
      stringValue(value(input, "updatedAt", "updated_at")) ?? event.occurredAt,
      stringValue(value(input, "archivedAt", "archived_at")),
      milestoneId,
      cycleId,
    ],
  );
}

async function cleanupIssueReferencePlaceholders(
  tx: PersistenceTransaction,
  issueId: string,
): Promise<void> {
  // Relation/comment rows can arrive before their Issue snapshot. Once the
  // source row updates the placeholder Issue, its synthetic Team and State are
  // unreferenced and must not remain in the reconstructed board.
  await tx.execute("DELETE FROM workflow_states WHERE id = $1", [`placeholder-state:${issueId}`]);
  await tx.execute("DELETE FROM teams WHERE id = $1", [`placeholder-team:${issueId}`]);
}

async function ensureIssueSnapshotDependencies(
  tx: PersistenceTransaction,
  event: DomainEvent,
  input: Row,
): Promise<void> {
  const identifier = issueIdentifier(event, input);
  const team = await resolveTeamReference(tx, input, identifier);
  const state = await resolveStateReference(tx, input, team.id);
  await ensureTeam(tx, event, team.id, team.key, numberValue(value(input, "number"), 0));
  await ensureWorkflowState(tx, event, state.id, team.id, state.name);
  await ensureActor(
    tx,
    event,
    stringValue(value(input, "creatorId", "creator_id")) ?? actorId(event),
  );
  await ensureActor(tx, event, stringValue(value(input, "assigneeId", "assignee_id")));
  const projectId = stringValue(value(input, "projectId", "project_id"));
  if (projectId) await ensureProject(tx, event, projectId);
  await ensureMilestone(
    tx,
    event,
    stringValue(value(input, "milestoneId", "milestone_id")),
    projectId,
  );
  await ensureCycle(tx, event, stringValue(value(input, "cycleId", "cycle_id")), team.id, input);
  const parentId = stringValue(value(input, "parentId", "parent_id"));
  if (parentId) await ensureIssueReference(tx, event, parentId);
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
    if (keys.some((key) => Object.prototype.hasOwnProperty.call(input, key))) {
      return value(input, ...keys);
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
  const next = {
    teamId: nextValue(changed("teamId", "teamId", "team_id"), existing.team_id),
    number: nextValue(changed("number"), existing.number),
    title: nextValue(changed("title"), existing.title),
    description: nextValue(changed("description"), existing.description),
    stateId: nextValue(changed("stateId", "stateId", "state_id"), existing.state_id),
    priority: nextValue(changed("priority"), existing.priority),
    assigneeId: nextValue(changed("assigneeId", "assigneeId", "assignee_id"), existing.assignee_id),
    parentId: nextValue(changed("parentId", "parentId", "parent_id"), existing.parent_id),
    projectId: nextValue(changed("projectId", "projectId", "project_id"), existing.project_id),
    creatorId: nextValue(changed("creatorId", "creatorId", "creator_id"), existing.creator_id),
    sortOrder: nextValue(changed("sortOrder", "sortOrder", "sort_order"), existing.sort_order),
    createdAt: nextValue(changed("createdAt", "createdAt", "created_at"), existing.created_at),
    updatedAt: nextValue(changed("updatedAt", "updatedAt", "updated_at"), event.occurredAt),
    archivedAt: nextValue(changed("archivedAt", "archivedAt", "archived_at"), existing.archived_at),
    milestoneId: nextValue(
      changed("milestoneId", "milestoneId", "milestone_id"),
      existing.milestone_id,
    ),
    cycleId: nextValue(changed("cycleId", "cycleId", "cycle_id"), existing.cycle_id),
  };
  if (event.type === "issue.archived" || event.type === "archived")
    next.archivedAt = stringValue(value(input, "archivedAt", "archived_at")) ?? event.occurredAt;
  if (event.type === "issue.unarchived" || event.type === "unarchived") next.archivedAt = null;
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
  await tx.execute(
    `INSERT INTO labels (id, name, color, team_id, created_at)
     VALUES ($1, $1, '#000000', $2, $3) ON CONFLICT (id) DO NOTHING`,
    [id, teamId, event.occurredAt],
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
  await tx.execute(
    `INSERT INTO actors (id, name, email, type, avatar_url, workspace_role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
       type = EXCLUDED.type, avatar_url = EXCLUDED.avatar_url, workspace_role = EXCLUDED.workspace_role,
       status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
    [
      id,
      stringValue(value(payload, "name")) ?? id,
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
    await tx.execute("DELETE FROM teams WHERE id = $1", [id]);
    return;
  }
  const defaultStateId = stringValue(value(payload, "defaultStateId", "default_state_id"));
  const defaultState = defaultStateId
    ? await tx.one<{ id: string }>("SELECT id FROM workflow_states WHERE id = $1", [defaultStateId])
    : null;
  // `teams.default_state_id` and `workflow_states.team_id` form a cycle. Insert
  // the Team with a null default first, then create/update the state reference.
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
      stringValue(value(payload, "key")) ?? event.aggregateKey,
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
    await tx.execute("DELETE FROM workflow_states WHERE id = $1", [id]);
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
    await tx.execute("DELETE FROM projects WHERE id = $1", [id]);
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
    await tx.execute("DELETE FROM labels WHERE id = $1", [id]);
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
    await tx.execute("DELETE FROM cycles WHERE id = $1", [id]);
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
  const issueId = await findIssueId(tx, event, payload);
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
  const issueId = requiredString(payload, "issueId", "issue_id");
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
  const issueId = requiredString(payload, "issueId", "issue_id");
  const relatedId = requiredString(payload, "relatedId", "related_id");
  const type = relationStoredType(value(payload, "type"));
  if (!type) throw new Error(`Canonical issue relation ${id} has an invalid type`);
  if (eventType(event, "deleted")) {
    await tx.execute("DELETE FROM issue_relations WHERE id = $1", [id]);
    return;
  }
  await ensureIssueReference(tx, event, issueId);
  await ensureIssueReference(tx, event, relatedId);
  await tx.execute(
    `INSERT INTO issue_relations (id, issue_id, related_id, type, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET issue_id = EXCLUDED.issue_id,
       related_id = EXCLUDED.related_id, type = EXCLUDED.type, created_at = EXCLUDED.created_at`,
    [
      id,
      issueId,
      relatedId,
      type,
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
  const issueId = requiredString(payload, "issueId", "issue_id");
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
  if (table === "milestones" || table === "project_updates") {
    if (projectId) await ensureProject(tx, event, projectId);
  }
  if (table === "reviews") {
    const issueId = stringValue(value(payload, "issueId", "issue_id"));
    if (issueId) await ensureIssueReference(tx, event, issueId);
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
    const current = value(payload, ...aliases);
    const fallback = definition.defaults[index] ?? null;
    // A required actor field can use the event actor, including when a
    // historical payload encoded it as explicit null.
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

/** Aplica un evento canónico a la proyección PostgreSQL. */
export async function applyCanonicalEvent(
  tx: PersistenceTransaction,
  input: DomainEvent,
): Promise<void> {
  const event = validateDomainEvent(input);
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
