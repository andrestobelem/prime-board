import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { createReplicaMetadata, type ReplicaScope } from "./replica-metadata.ts";
import {
  EventLogConflictError,
  EventLogReader,
  areDomainEventsEquivalent,
  type DomainEvent,
  type EventLogOptions,
  type JsonObject,
  validateDomainEvent,
} from "./event-log.ts";

export interface CanonicalIssueProjection {
  readonly identifier: string;
  readonly id: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly team: string | null;
  readonly state: string | null;
  readonly priority: number;
  readonly assignee: string | null;
  readonly creator: string | null;
  readonly parent: string | null;
  readonly project: string | null;
  readonly milestone: string | null;
  readonly cycle: string | null;
  readonly sortOrder: number;
  readonly labels: readonly { name: string; team: string | null }[];
  readonly blockedBy: readonly string[];
  readonly related: readonly string[];
  readonly duplicateOf: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface CanonicalAggregateProjection {
  readonly aggregate: string;
  readonly aggregateKey: string;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: JsonObject;
}

export interface CanonicalEventProjection {
  readonly events: readonly DomainEvent[];
  readonly issues: readonly CanonicalIssueProjection[];
  readonly aggregates: readonly CanonicalAggregateProjection[];
}

export interface RegenerateCanonicalProjectionsOptions extends EventLogOptions {
  /** Eventos ya leídos. Permite reducir una captura sin volver a abrir el archivo. */
  readonly events?: readonly unknown[];
  /** Alcance que se escribe en meta/export.json. */
  readonly scope?: ReplicaScope;
  /** Evita escribir los logs derivados por Issue cuando solo se necesita Markdown. */
  readonly writeIssueLogs?: boolean;
}

export interface RegenerateCanonicalProjectionsResult {
  readonly issues: number;
  readonly events: number;
  readonly files: number;
  readonly removedIssues: number;
}

type RecordValue = Record<string, unknown>;

interface MutableIssueProjection {
  readonly identifier: string;
  fields: RecordValue;
  readonly labels: Map<string, { name: string; team: string | null }>;
  readonly relations: Map<string, { type: "blockedBy" | "related" | "duplicateOf"; issue: string }>;
  readonly eventIds: string[];
  deleted: boolean;
  lastEventAt: string;
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function field(record: RecordValue, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  }
  return undefined;
}

function setField(state: MutableIssueProjection, key: string, value: unknown): void {
  if (value !== undefined) state.fields[key] = value;
}

function applyChange(state: MutableIssueProjection, key: string, change: unknown): void {
  if (!isRecord(change)) return;
  if (Object.prototype.hasOwnProperty.call(change, "to")) setField(state, key, change.to);
}

function normalizeLabel(value: unknown): { name: string; team: string | null } | null {
  if (typeof value === "string" && value.trim()) return { name: value, team: null };
  if (!isRecord(value)) return null;
  const name = stringValue(field(value, "name", "label", "labelName"));
  if (!name) return null;
  return { name, team: stringValue(field(value, "team", "teamKey", "team_key")) };
}

function labelKey(label: { name: string; team: string | null }): string {
  return `${label.team ?? ""}\u0000${label.name}`;
}

function isSnapshotEvent(event: DomainEvent): boolean {
  return (
    event.type === "snapshot_imported" || event.type === `${event.aggregate}.snapshot_imported`
  );
}

function relationType(value: unknown): "blockedBy" | "related" | "duplicateOf" | null {
  if (value === "blocked_by" || value === "blockedBy") return "blockedBy";
  if (value === "related") return "related";
  if (value === "duplicate_of" || value === "duplicateOf") return "duplicateOf";
  return null;
}

function relationKey(type: string, issue: string): string {
  return `${type}\u0000${issue}`;
}

function applyRelation(state: MutableIssueProjection, value: unknown): void {
  if (!isRecord(value)) return;
  const relation = relationType(field(value, "type"));
  const issue = stringValue(field(value, "issue", "relatedIssue", "relatedIssueId"));
  if (!relation || !issue) return;
  state.relations.set(relationKey(relation, issue), { type: relation, issue });
}

function removeRelation(state: MutableIssueProjection, value: unknown): void {
  if (!isRecord(value)) return;
  const relation = relationType(field(value, "type"));
  const issue = stringValue(field(value, "issue", "relatedIssue", "relatedIssueId"));
  if (!relation || !issue) return;
  state.relations.delete(relationKey(relation, issue));
}

function applyRelationChange(state: MutableIssueProjection, value: unknown): void {
  if (!isRecord(value)) return;
  const to = field(value, "to");
  if (to === null) {
    removeRelation(state, field(value, "from"));
  } else {
    applyRelation(state, to);
  }
}

function applyLabels(state: MutableIssueProjection, values: unknown): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    const label = normalizeLabel(value);
    if (label) state.labels.set(labelKey(label), label);
  }
}

function removeLabel(state: MutableIssueProjection, value: unknown): void {
  const label = normalizeLabel(value);
  if (!label) return;
  state.labels.delete(labelKey(label));
  // Los eventos históricos solo llevaban el nombre. También elimina una
  // variante scoped cuando el team no venía en el payload.
  if (label.team === null) {
    for (const [key, current] of state.labels) {
      if (current.name === label.name) state.labels.delete(key);
    }
  }
}

function copySnapshotFields(state: MutableIssueProjection, payload: RecordValue): void {
  state.fields = { ...state.fields, ...payload };
  const aliases: Record<string, string> = {
    team_id: "teamId",
    state_id: "stateId",
    assignee_id: "assigneeId",
    parent_id: "parentId",
    project_id: "projectId",
    milestone_id: "milestoneId",
    cycle_id: "cycleId",
    creator_id: "creatorId",
    sort_order: "sortOrder",
    created_at: "createdAt",
    updated_at: "updatedAt",
    archived_at: "archivedAt",
    team_key: "teamKey",
  };
  for (const [source, target] of Object.entries(aliases)) {
    if (
      Object.prototype.hasOwnProperty.call(payload, source) &&
      !Object.prototype.hasOwnProperty.call(payload, target)
    ) {
      state.fields[target] = payload[source];
    }
  }
}

function applyLegacyIssueEvent(state: MutableIssueProjection, event: DomainEvent): void {
  const payload = event.payload;
  const to = field(payload, "to");
  switch (event.type) {
    case "created":
      state.fields = { ...state.fields, ...payload };
      return;
    case "title_changed":
      setField(state, "title", to);
      return;
    case "description_changed":
      setField(state, "description", to);
      return;
    case "state_changed":
      setField(state, "stateId", to);
      setField(state, "state", to);
      return;
    case "priority_changed":
      setField(state, "priority", to);
      return;
    case "assigned":
      setField(state, "assigneeId", to);
      setField(state, "assignee", to);
      return;
    case "parent_changed":
      setField(state, "parentId", to);
      setField(state, "parent", to);
      return;
    case "project_changed":
      setField(state, "projectId", to);
      setField(state, "project", to);
      return;
    case "milestone_changed":
      setField(state, "milestoneId", to);
      setField(state, "milestone", to);
      return;
    case "cycle_changed":
      setField(state, "cycleId", to);
      setField(state, "cycle", to);
      return;
    case "sort_order_changed":
      setField(state, "sortOrder", to);
      return;
    case "labeled":
      applyLabels(state, [field(payload, "label", "name", "labelId")]);
      return;
    case "unlabeled":
      removeLabel(state, field(payload, "label", "name", "labelId"));
      return;
    case "relation_added":
      applyRelation(state, payload);
      return;
    case "relation_removed":
      removeRelation(state, payload);
      return;
    case "archived":
      setField(state, "archivedAt", to ?? event.occurredAt);
      return;
    case "unarchived":
      setField(state, "archivedAt", null);
      return;
    default:
      return;
  }
}

function applyIssueEvent(state: MutableIssueProjection, event: DomainEvent): void {
  state.eventIds.push(event.eventId);
  state.lastEventAt = event.occurredAt;
  const payload = event.payload;
  if (event.type === "issue.deleted" || event.type === "deleted") {
    state.deleted = true;
    return;
  }
  if (isSnapshotEvent(event)) {
    copySnapshotFields(state, payload);
    applyLabels(state, field(payload, "labels"));
    return;
  }
  if (event.type === "issue.created" || event.type === "created") {
    state.fields = { ...state.fields, ...payload };
    applyLabels(state, field(payload, "labels"));
    return;
  }
  if (
    event.type === "issue.updated" ||
    event.type === "issue.archived" ||
    event.type === "issue.unarchived"
  ) {
    state.fields = { ...state.fields, ...payload };
    const changes = field(payload, "changes");
    if (isRecord(changes)) {
      for (const [key, change] of Object.entries(changes)) {
        if (key === "relations") applyRelationChange(state, change);
        else applyChange(state, key, change);
      }
    }
    if (event.type === "issue.archived")
      setField(state, "archivedAt", field(payload, "archivedAt") ?? event.occurredAt);
    if (event.type === "issue.unarchived") setField(state, "archivedAt", null);
    applyLabels(state, field(payload, "labels"));
    return;
  }
  if (event.type === "relation_added") {
    applyRelation(state, payload);
    return;
  }
  if (event.type === "relation_removed") {
    removeRelation(state, payload);
    return;
  }
  applyLegacyIssueEvent(state, event);
}

function createIssueState(identifier: string, event: DomainEvent): MutableIssueProjection {
  const state: MutableIssueProjection = {
    identifier,
    fields: {},
    labels: new Map(),
    relations: new Map(),
    eventIds: [],
    deleted: false,
    lastEventAt: event.occurredAt,
  };
  applyIssueEvent(state, event);
  return state;
}

function asIssueProjection(state: MutableIssueProjection): CanonicalIssueProjection {
  const fields = state.fields;
  const labels = [...state.labels.values()].sort((left, right) =>
    labelKey(left).localeCompare(labelKey(right)),
  );
  const relations = [...state.relations.values()].sort((left, right) =>
    relationKey(left.type, left.issue).localeCompare(relationKey(right.type, right.issue)),
  );
  const id = stringValue(field(fields, "id"));
  const title = stringValue(field(fields, "title")) ?? state.identifier;
  const description = stringValue(field(fields, "description"));
  const team = stringValue(field(fields, "team", "teamKey", "team_key"));
  const stateRef = stringValue(field(fields, "state", "stateId", "state_id"));
  const assignee = stringValue(field(fields, "assignee", "assigneeId", "assignee_id"));
  const creator = stringValue(field(fields, "creator", "creatorId", "creator_id"));
  const parent = stringValue(field(fields, "parent", "parentId", "parent_id"));
  const project = stringValue(field(fields, "project", "projectId", "project_id"));
  const milestone = stringValue(field(fields, "milestone", "milestoneId", "milestone_id"));
  const cycle = stringValue(field(fields, "cycle", "cycleId", "cycle_id"));
  const archivedAt = stringValue(field(fields, "archivedAt", "archived_at"));
  const createdAt = stringValue(field(fields, "createdAt", "created_at")) ?? state.lastEventAt;
  const updatedAt = stringValue(field(fields, "updatedAt", "updated_at")) ?? state.lastEventAt;
  const blockedBy = relations
    .filter((relation) => relation.type === "blockedBy")
    .map((r) => r.issue);
  const related = relations.filter((relation) => relation.type === "related").map((r) => r.issue);
  const duplicateOf = relations
    .filter((relation) => relation.type === "duplicateOf")
    .map((r) => r.issue);
  return {
    identifier: state.identifier,
    id,
    title,
    description,
    team,
    state: stateRef,
    priority: numberValue(field(fields, "priority"), 0),
    assignee,
    creator,
    parent,
    project,
    milestone,
    cycle,
    sortOrder: numberValue(field(fields, "sortOrder", "sort_order"), 0),
    labels,
    blockedBy,
    related,
    duplicateOf,
    createdAt,
    updatedAt,
    archivedAt,
  };
}

function naturalActor(actor: unknown): unknown {
  if (!isRecord(actor)) return actor;
  return field(actor, "name", "id") ?? actor;
}

function issueLogRecord(event: DomainEvent, identifier: string): RecordValue {
  return {
    actor: naturalActor(event.actor),
    issue: identifier,
    payload: event.payload,
    ts: event.occurredAt,
    type: event.type,
  };
}

function stableJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (isRecord(input)) {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, sort(item)]),
      );
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  Bun.write(path, content);
  return true;
}

function frontMatter(issue: CanonicalIssueProjection): RecordValue {
  return {
    id: issue.identifier,
    title: issue.title,
    team: issue.team,
    state: issue.state,
    priority: issue.priority,
    assignee: issue.assignee,
    creator: issue.creator,
    parent: issue.parent,
    project: issue.project,
    milestone: issue.milestone,
    cycle: issue.cycle,
    sortOrder: issue.sortOrder,
    labels: issue.labels,
    ...(issue.blockedBy.length > 0 ? { blockedBy: issue.blockedBy } : {}),
    ...(issue.related.length > 0 ? { related: issue.related } : {}),
    ...(issue.duplicateOf.length > 0 ? { duplicateOf: issue.duplicateOf } : {}),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    archivedAt: issue.archivedAt,
  };
}

function eventScope(events: readonly DomainEvent[]): string | null {
  const scopes = [
    ...new Set(events.map((event) => event.workspaceId).filter((id): id is string => Boolean(id))),
  ];
  return scopes.length === 1 ? scopes[0]! : null;
}

/** Reduce el Log completo. No consulta SQLite ni PostgreSQL. */
export function reduceEventLog(input: readonly unknown[]): CanonicalEventProjection {
  const byId = new Map<string, DomainEvent>();
  for (const item of input) {
    const event = validateDomainEvent(item);
    const existing = byId.get(event.eventId);
    if (existing && !areDomainEventsEquivalent(existing, event)) {
      throw new EventLogConflictError(event.eventId);
    }
    if (!existing) byId.set(event.eventId, event);
  }
  const events = [...byId.values()].sort((left, right) => {
    const time = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
    return (
      time ||
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.eventId.localeCompare(right.eventId)
    );
  });
  const issues = new Map<string, MutableIssueProjection>();
  const latest = new Map<string, CanonicalAggregateProjection>();
  const findIssue = (reference: unknown): MutableIssueProjection | undefined => {
    const ref = stringValue(reference);
    if (!ref) return undefined;
    return [...issues.values()].find(
      (state) => state.identifier === ref || stringValue(field(state.fields, "id")) === ref,
    );
  };
  for (const event of events) {
    const aggregateKey = `${event.aggregate}\u0000${event.aggregateKey}`;
    latest.set(aggregateKey, {
      aggregate: event.aggregate,
      aggregateKey: event.aggregateKey,
      eventId: event.eventId,
      type: event.type,
      occurredAt: event.occurredAt,
      payload: event.payload,
    });
    if (event.aggregate !== "issue" && event.aggregate !== "issues") continue;
    const issuePayload = event.payload;
    const identifier =
      stringValue(field(issuePayload, "identifier", "issueIdentifier")) ?? event.aggregateKey;
    let current = issues.get(identifier) ?? findIssue(field(issuePayload, "id"));
    if (!current) {
      current = createIssueState(identifier, event);
      issues.set(identifier, current);
      continue;
    }
    // The SQLite importer keys a snapshot by source UUID while online events
    // use the natural identifier. Reuse the same state when both are present.
    if (current.eventIds.length > 0 && current.eventIds.at(-1) !== event.eventId)
      applyIssueEvent(current, event);
  }

  // Snapshot imports may contain relation rows whose eventId sorts before the
  // parent Issue row. Apply those rows only after all Issue snapshots exist.
  const labelPayload = (labelId: string): RecordValue | undefined => {
    for (const aggregate of ["label", "labels"]) {
      const current = latest.get(`${aggregate}\u0000${labelId}`);
      if (current) return current.payload;
    }
    return undefined;
  };
  for (const event of events) {
    if (!isSnapshotEvent(event)) continue;
    const payload = event.payload;
    if (event.aggregate === "issue_label" || event.aggregate === "issue_labels") {
      const issue = findIssue(field(payload, "issueId", "issue_id"));
      const labelId = stringValue(field(payload, "labelId", "label_id"));
      if (!issue || !labelId) continue;
      const label =
        normalizeLabel(labelPayload(labelId)) ??
        normalizeLabel({
          name: field(payload, "labelName", "label_name", "name", "labelId", "label_id"),
          team: field(payload, "team", "teamKey", "team_key"),
        });
      if (label) issue.labels.set(labelKey(label), label);
    }
    if (event.aggregate === "issue_relation" || event.aggregate === "issue_relations") {
      const source = findIssue(field(payload, "issueId", "issue_id"));
      const target = findIssue(field(payload, "relatedId", "related_id"));
      const type = field(payload, "type");
      if (!source || !target || typeof type !== "string") continue;
      if (type === "blocks") {
        // Stored `blocks` points from blocker to blocked issue. The
        // user-facing blockedBy field belongs to the target endpoint.
        target.relations.set(relationKey("blockedBy", source.identifier), {
          type: "blockedBy",
          issue: source.identifier,
        });
      } else if (type === "blocked_by" || type === "blockedBy") {
        source.relations.set(relationKey("blockedBy", target.identifier), {
          type: "blockedBy",
          issue: target.identifier,
        });
      } else if (type === "related") {
        for (const current of [source, target]) {
          current.relations.set(
            relationKey("related", current === source ? target.identifier : source.identifier),
            {
              type: "related",
              issue: current === source ? target.identifier : source.identifier,
            },
          );
        }
      } else if (type === "duplicate_of" || type === "duplicateOf") {
        source.relations.set(relationKey("duplicateOf", target.identifier), {
          type: "duplicateOf",
          issue: target.identifier,
        });
      } else if (type === "duplicated_by" || type === "duplicatedBy") {
        target.relations.set(relationKey("duplicateOf", source.identifier), {
          type: "duplicateOf",
          issue: source.identifier,
        });
      }
    }
  }

  return {
    events,
    issues: [...issues.values()]
      .filter((state) => !state.deleted)
      .map(asIssueProjection)
      .sort((left, right) => left.identifier.localeCompare(right.identifier)),
    aggregates: [...latest.values()].sort((left, right) =>
      `${left.aggregate}\u0000${left.aggregateKey}`.localeCompare(
        `${right.aggregate}\u0000${right.aggregateKey}`,
      ),
    ),
  };
}

/** Regenera Markdown y metadata derivados sin leer una base operativa. */
export function regenerateCanonicalProjections(
  rootDir: string,
  options: RegenerateCanonicalProjectionsOptions = {},
): RegenerateCanonicalProjectionsResult {
  const events = options.events
    ? options.events.map(validateDomainEvent)
    : new EventLogReader({ ...options, rootDir }).read();
  const projection = reduceEventLog(events);
  const base = join(rootDir, ".prime-board");
  const issuesDir = join(base, "issues");
  const logDir = join(base, "log");
  const metaDir = join(base, "meta");
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(metaDir, { recursive: true });
  let files = 0;
  for (const issue of projection.issues) {
    const body = issue.description ? `\n${issue.description.replace(/\s*$/u, "")}\n` : "";
    const content = `---\n${toYaml(frontMatter(issue), { sortMapEntries: true, lineWidth: 0 })}---\n\n# ${issue.title}${body}`;
    if (writeIfChanged(join(issuesDir, `${issue.identifier}.md`), content)) files += 1;
    if (options.writeIssueLogs !== false) {
      const issueEvents = projection.events
        .filter((event) => {
          if (event.aggregate !== "issue" && event.aggregate !== "issues") return false;
          const identifier = stringValue(field(event.payload, "identifier", "issueIdentifier"));
          return (identifier ?? event.aggregateKey) === issue.identifier;
        })
        .map((event) => issueLogRecord(event, issue.identifier));
      const logContent =
        issueEvents.length > 0
          ? `${issueEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
          : "";
      if (writeIfChanged(join(logDir, `${issue.identifier}.jsonl`), logContent)) files += 1;
    }
  }
  const workspaceId = eventScope(projection.events);
  if (workspaceId) {
    const metadata = createReplicaMetadata(workspaceId, options.scope ?? "workspace");
    if (writeIfChanged(join(metaDir, "export.json"), stableJson(metadata))) files += 1;
  }
  const canonical = {
    version: 1,
    eventCount: projection.events.length,
    eventIds: projection.events.map((event) => event.eventId),
    aggregates: projection.aggregates,
  };
  if (writeIfChanged(join(metaDir, "canonical.json"), stableJson(canonical))) files += 1;
  const currentIssueFiles = new Set(projection.issues.map((issue) => `${issue.identifier}.md`));
  let removedIssues = 0;
  if (existsSync(issuesDir)) {
    for (const file of readdirSync(issuesDir)) {
      if (!file.endsWith(".md") || currentIssueFiles.has(file)) continue;
      unlinkSync(join(issuesDir, file));
      removedIssues += 1;
    }
  }
  // A deleted Issue must not leave a derived per-Issue log that can be
  // mistaken for current state. Preserve only the canonical aggregate log.
  const currentIssueLogs = new Set(projection.issues.map((issue) => `${issue.identifier}.jsonl`));
  if (existsSync(logDir)) {
    for (const file of readdirSync(logDir)) {
      if (!file.endsWith(".jsonl") || file === "events.jsonl" || currentIssueLogs.has(file))
        continue;
      unlinkSync(join(logDir, file));
    }
  }
  return {
    issues: projection.issues.length,
    events: projection.events.length,
    files,
    removedIssues,
  };
}

export const regenerateMarkdownFromEventLog = regenerateCanonicalProjections;
export const rebuildProjectionsFromEventLog = regenerateCanonicalProjections;
