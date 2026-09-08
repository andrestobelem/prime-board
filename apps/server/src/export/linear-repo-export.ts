import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { createSourceMap, mergeSourceMap, writeSourceMap, type SourceMap } from "./source-map.ts";
import { createReplicaMetadata } from "./replica-metadata.ts";

export interface LinearWorkspace {
  id: string;
  name: string;
  urlKey?: string | null;
}
export interface LinearActor {
  id: string;
  name: string;
  email?: string | null;
  type?: "human" | "agent" | null;
}
export interface LinearState {
  id: string;
  name: string;
  type: string;
  color?: string | null;
  position?: number | null;
  description?: string | null;
}
export interface LinearTeamMember {
  actorId: string;
  role: "member" | "owner";
}
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  states: LinearState[];
  /** Memberships are required to avoid inferring every actor as an owner. */
  members?: LinearTeamMember[];
  defaultStateId?: string | null;
  autoClosePeriod?: number | null;
  autoArchivePeriod?: number | null;
  autoCloseStateId?: string | null;
  autoCloseParentIssues?: boolean | null;
  autoCloseChildIssues?: boolean | null;
}
export interface LinearLabel {
  id: string;
  name: string;
  color?: string | null;
  teamId?: string | null;
}
export interface LinearMilestone {
  id: string;
  name: string;
  description?: string | null;
  targetDate?: string | null;
  position?: number | null;
}
export interface LinearLink {
  id?: string;
  url: string;
  title?: string | null;
  filename?: string | null;
}
export interface LinearProject {
  id: string;
  name: string;
  description?: string | null;
  state: string;
  leadId?: string | null;
  targetDate?: string | null;
  archivedAt?: string | null;
  teamIds: string[];
  milestones?: LinearMilestone[];
  documents?: LinearLink[];
  statusUpdates?: LinearLink[];
  initiativeId?: string | null;
}
export interface LinearStateHistory {
  stateId: string;
  startedAt: string;
}
export interface LinearIssue {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description?: string | null;
  teamId: string;
  stateId: string;
  priority?: number | null;
  assigneeId?: string | null;
  creatorId: string;
  parentId?: string | null;
  projectId?: string | null;
  milestoneId?: string | null;
  labelIds?: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  stateHistory?: LinearStateHistory[];
  attachments?: LinearLink[];
  documents?: LinearLink[];
  dueDate?: string | null;
  estimate?: number | null;
  cycleId?: string | null;
}
export interface LinearComment {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  createdAt: string;
  parentId?: string | null;
  quotedText?: string | null;
}
export type LinearRelationType =
  "blocks" | "blocked_by" | "related" | "duplicate_of" | "duplicated_by";
export interface LinearRelation {
  id?: string;
  issueId: string;
  relatedIssueId: string;
  type: LinearRelationType;
  createdAt?: string | null;
}
export interface LinearExport {
  workspace: LinearWorkspace;
  actors: LinearActor[];
  teams: LinearTeam[];
  labels: LinearLabel[];
  projects: LinearProject[];
  issues: LinearIssue[];
  comments?: LinearComment[];
  relations?: LinearRelation[];
}

export interface MigrationFinding {
  code: string;
  message: string;
  sourceId?: string;
}
export interface LinearRepoExportResult {
  issues: number;
  comments: number;
  events: number;
  files: number;
  conflicts: MigrationFinding[];
  losses: MigrationFinding[];
  warnings: MigrationFinding[];
  sourceMap: SourceMap;
}
export interface LinearRepoExportOptions {
  dryRun?: boolean;
  allowLosses?: boolean;
  teamKeyMap?: Record<string, string>;
}

const VALID_PROJECT_STATES = new Set([
  "backlog",
  "planned",
  "started",
  "paused",
  "completed",
  "canceled",
]);
const VALID_STATE_TYPES = new Set([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertLinearExportShape(source: LinearExport): void {
  const collections: Array<[string, unknown]> = [
    ["actors", source.actors],
    ["teams", source.teams],
    ["labels", source.labels],
    ["projects", source.projects],
    ["issues", source.issues],
  ];
  for (const [name, values] of collections) {
    if (!Array.isArray(values)) throw new Error(`Invalid Linear export ${name}: expected array`);
    values.forEach((value, index) => {
      if (!record(value))
        throw new Error(`Invalid Linear export ${name}[${index}]: expected object`);
    });
  }
  const assertArray = (value: unknown, label: string): void => {
    if (!Array.isArray(value)) throw new Error(`Invalid Linear export ${label}: expected array`);
    value.forEach((item, index) => {
      if (!record(item))
        throw new Error(`Invalid Linear export ${label}[${index}]: expected object`);
    });
  };
  for (const [index, team] of source.teams.entries()) {
    assertArray(team.states, `teams[${index}].states`);
    if (team.members != null) assertArray(team.members, `teams[${index}].members`);
  }
  for (const [index, project] of source.projects.entries()) {
    if (!Array.isArray(project.teamIds))
      throw new Error(`Invalid Linear export projects[${index}].teamIds: expected array`);
    if (project.milestones != null)
      assertArray(project.milestones, `projects[${index}].milestones`);
    for (const field of ["documents", "statusUpdates"] as const)
      if (project[field] != null) assertArray(project[field], `projects[${index}].${field}`);
  }
  for (const [index, issue] of source.issues.entries()) {
    for (const field of ["labelIds", "stateHistory", "attachments", "documents"] as const)
      if (issue[field] != null && !Array.isArray(issue[field]))
        throw new Error(`Invalid Linear export issues[${index}].${field}: expected array`);
    if (Array.isArray(issue.stateHistory))
      issue.stateHistory.forEach((entry, entryIndex) => {
        if (!record(entry))
          throw new Error(
            `Invalid Linear export issues[${index}].stateHistory[${entryIndex}]: expected object`,
          );
      });
    for (const field of ["attachments", "documents"] as const)
      if (Array.isArray(issue[field]))
        issue[field].forEach((link, linkIndex) => {
          if (!record(link))
            throw new Error(
              `Invalid Linear export issues[${index}].${field}[${linkIndex}]: expected object`,
            );
        });
  }
  if (source.comments != null) assertArray(source.comments, "comments");
  if (source.relations != null) assertArray(source.relations, "relations");
}

/** Valida la envoltura mínima del JSON recibido antes de planificar la escritura. */
export function parseLinearExport(value: unknown): LinearExport {
  if (!record(value)) throw new Error("Invalid Linear export: expected an object");
  for (const field of ["workspace", "actors", "teams", "labels", "projects", "issues"]) {
    if (!(field in value)) throw new Error(`Invalid Linear export: missing ${field}`);
  }
  if (
    !record(value.workspace) ||
    typeof value.workspace.id !== "string" ||
    typeof value.workspace.name !== "string"
  ) {
    throw new Error("Invalid Linear export workspace");
  }
  for (const field of ["actors", "teams", "labels", "projects", "issues"]) {
    if (!Array.isArray(value[field]))
      throw new Error(`Invalid Linear export ${field}: expected array`);
  }
  if (value.comments !== undefined && !Array.isArray(value.comments))
    throw new Error("Invalid Linear export comments: expected array");
  if (value.relations !== undefined && !Array.isArray(value.relations))
    throw new Error("Invalid Linear export relations: expected array");
  const source = value as unknown as LinearExport;
  assertLinearExportShape(source);
  return source;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}
function json(value: unknown): string {
  return JSON.stringify(stable(value), null, 2) + "\n";
}
function add(findings: MigrationFinding[], code: string, message: string, sourceId?: string): void {
  findings.push(sourceId ? { code, message, sourceId } : { code, message });
}
function requiredString(
  value: unknown,
  label: string,
  conflicts: MigrationFinding[],
  sourceId: string,
): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    add(conflicts, "INVALID_FIELD", `${label} is required`, sourceId);
    return false;
  }
  return true;
}
function targetTeamKey(team: LinearTeam, options: LinearRepoExportOptions): string {
  return (options.teamKeyMap?.[team.id] ?? team.key).trim().toUpperCase();
}
function stateType(type: string, warnings: MigrationFinding[], sourceId: string): string | null {
  const normalized = type.toLowerCase();
  if (normalized === "duplicate") {
    add(
      warnings,
      "STATE_TYPE_MAPPED",
      "Linear duplicate state is represented as canceled while keeping its name",
      sourceId,
    );
    return "canceled";
  }
  if (!VALID_STATE_TYPES.has(normalized)) return null;
  return normalized;
}
export function issueIdentifierForExport(
  issue: LinearIssue,
  team: LinearTeam,
  options: LinearRepoExportOptions = {},
): string {
  return `${targetTeamKey(team, options)}-${issue.number}`;
}
function ensureDate(
  value: unknown,
  label: string,
  findings: MigrationFinding[],
  sourceId: string,
): boolean {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    add(findings, "INVALID_DATE", `${label} must be ISO-8601`, sourceId);
    return false;
  }
  return true;
}
function addSourceMapping(
  map: SourceMap,
  type: Parameters<typeof mergeSourceMap>[1],
  values: Record<string, string>,
): SourceMap {
  return Object.keys(values)
    .sort()
    .reduce(
      (current, sourceId) => mergeSourceMap(current, type, { [sourceId]: values[sourceId]! }),
      map,
    );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEAM_KEY_RE = /^[A-Z][A-Z0-9]{0,7}$/;
const ISSUE_IDENTIFIER_RE = /^([A-Z][A-Z0-9]{0,7})-([1-9][0-9]*)$/;
const RELATION_TYPES = new Set<LinearRelationType>([
  "blocks",
  "blocked_by",
  "related",
  "duplicate_of",
  "duplicated_by",
]);

function normalizeAutomationPeriod(
  value: unknown,
  field: string,
  conflicts: MigrationFinding[],
  sourceId: string,
): number | null {
  // Linear usa cero para deshabilitar la automatización. El esquema local usa NULL.
  if (value == null || value === 0) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    add(
      conflicts,
      "INVALID_AUTOMATION_PERIOD",
      `${field} must be zero or a positive number`,
      sourceId,
    );
    return null;
  }
  return value;
}

function recordDuplicateIds(
  values: Array<{ id?: unknown }>,
  kind: string,
  conflicts: MigrationFinding[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!record(value)) {
      add(conflicts, "INVALID_FIELD", `${kind} must be an object`);
      continue;
    }
    if (typeof value.id !== "string" || value.id.length === 0) continue;
    if (seen.has(value.id))
      add(conflicts, "DUPLICATE_SOURCE_ID", `${kind} id ${value.id} repeats`, value.id);
    seen.add(value.id);
  }
}

function recordGraphCycles(
  graph: Map<string, Set<string>>,
  code: string,
  message: string,
  conflicts: MigrationFinding[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) {
      add(conflicts, code, message, node);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
}

/** Valida que una captura real no haya sustituido UUIDs por identificadores legibles. */
export function validateLinearExportUuidIds(source: LinearExport): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const check = (id: string | null | undefined, kind: string, owner: string) => {
    if (id && !UUID_RE.test(id))
      findings.push({
        code: "NON_UUID_SOURCE_ID",
        message: `${kind} ${owner} has non-UUID source id ${id}`,
        sourceId: id,
      });
  };
  check(source.workspace.id, "workspace", source.workspace.name);
  for (const actor of source.actors) check(actor.id, "actor", actor.name);
  for (const team of source.teams) {
    check(team.id, "team", team.key);
    check(team.defaultStateId, "team.defaultStateId", team.key);
    check(team.autoCloseStateId, "team.autoCloseStateId", team.key);
    for (const member of Array.isArray(team.members) ? team.members : [])
      check(member.actorId, "team.member.actorId", team.key);
    for (const state of Array.isArray(team.states) ? team.states : [])
      check(state.id, "state", state.name);
  }
  for (const label of source.labels) {
    check(label.id, "label", label.name);
    check(label.teamId, "label.teamId", label.name);
  }
  for (const project of source.projects) {
    check(project.id, "project", project.name);
    check(project.leadId, "project.leadId", project.name);
    check(project.initiativeId, "project.initiativeId", project.name);
    for (const teamId of Array.isArray(project.teamIds) ? project.teamIds : [])
      check(teamId, "project.teamId", project.name);
    for (const milestone of Array.isArray(project.milestones) ? project.milestones : [])
      check(milestone.id, "milestone", milestone.name);
  }
  for (const issue of source.issues) {
    check(issue.id, "issue", issue.identifier);
    check(issue.teamId, "issue.teamId", issue.identifier);
    check(issue.stateId, "issue.stateId", issue.identifier);
    check(issue.creatorId, "issue.creatorId", issue.identifier);
    check(issue.assigneeId, "issue.assigneeId", issue.identifier);
    check(issue.parentId, "issue.parentId", issue.identifier);
    check(issue.projectId, "issue.projectId", issue.identifier);
    check(issue.milestoneId, "issue.milestoneId", issue.identifier);
    check(issue.cycleId, "issue.cycleId", issue.identifier);
    for (const labelId of Array.isArray(issue.labelIds) ? issue.labelIds : [])
      check(labelId, "issue.labelId", issue.identifier);
    for (const history of Array.isArray(issue.stateHistory) ? issue.stateHistory : [])
      check(history.stateId, "history.stateId", issue.identifier);
  }
  for (const comment of source.comments ?? []) {
    check(comment.id, "comment", comment.id);
    check(comment.issueId, "comment.issueId", comment.id);
    check(comment.authorId, "comment.authorId", comment.id);
    check(comment.parentId, "comment.parentId", comment.id);
  }
  for (const relation of source.relations ?? []) {
    check(relation.id, "relation", relation.id ?? `${relation.issueId}/${relation.relatedIssueId}`);
    check(relation.issueId, "relation.issueId", relation.id ?? "relation");
    check(relation.relatedIssueId, "relation.relatedIssueId", relation.id ?? "relation");
  }
  recordDuplicateIds(source.actors, "actor", findings);
  recordDuplicateIds(source.teams, "team", findings);
  recordDuplicateIds(source.labels, "label", findings);
  recordDuplicateIds(source.projects, "project", findings);
  recordDuplicateIds(
    source.teams.flatMap((team) => (Array.isArray(team.states) ? team.states : [])),
    "state",
    findings,
  );
  recordDuplicateIds(
    source.projects.flatMap((project) =>
      Array.isArray(project.milestones) ? project.milestones : [],
    ),
    "milestone",
    findings,
  );
  recordDuplicateIds(source.issues, "issue", findings);
  recordDuplicateIds(source.comments ?? [], "comment", findings);
  recordDuplicateIds(
    (source.relations ?? []).filter((relation) => relation.id),
    "relation",
    findings,
  );
  return findings;
}
/**
 * Convierte una captura de Linear a `.prime-board`. La función no toca el repo
 * cuando `dryRun` está activo; así el reporte es la seam segura del cutover.
 */
export function writeLinearExportToRepo(
  source: LinearExport,
  rootDir: string,
  options: LinearRepoExportOptions = {},
): LinearRepoExportResult {
  const conflicts: MigrationFinding[] = [];
  const losses: MigrationFinding[] = [];
  const warnings: MigrationFinding[] = [];
  assertLinearExportShape(source);
  conflicts.push(...validateLinearExportUuidIds(source));
  const comments = Array.isArray(source.comments) ? source.comments : [];
  const relations = Array.isArray(source.relations) ? source.relations : [];
  if (source.comments != null && !Array.isArray(source.comments))
    add(conflicts, "INVALID_FIELD", "comments must be an array");
  if (source.relations != null && !Array.isArray(source.relations))
    add(conflicts, "INVALID_FIELD", "relations must be an array");
  for (const team of source.teams) {
    if (!Array.isArray(team.states))
      add(
        conflicts,
        "INVALID_FIELD",
        `Team ${String(team.key)} states must be an array`,
        String(team.id ?? ""),
      );
  }
  for (const project of source.projects) {
    if (!Array.isArray(project.teamIds))
      add(
        conflicts,
        "INVALID_PROJECT_TEAMS",
        `Project ${String(project.name)} teamIds must be an array`,
        String(project.id ?? ""),
      );
    if (project.milestones != null && !Array.isArray(project.milestones))
      add(
        conflicts,
        "INVALID_FIELD",
        `Project ${String(project.name)} milestones must be an array`,
        String(project.id ?? ""),
      );
    if (project.documents != null && !Array.isArray(project.documents))
      add(
        conflicts,
        "INVALID_FIELD",
        `Project ${String(project.name)} documents must be an array`,
        String(project.id ?? ""),
      );
    if (project.statusUpdates != null && !Array.isArray(project.statusUpdates))
      add(
        conflicts,
        "INVALID_FIELD",
        `Project ${String(project.name)} statusUpdates must be an array`,
        String(project.id ?? ""),
      );
  }
  for (const issue of source.issues) {
    if (issue.labelIds != null && !Array.isArray(issue.labelIds))
      add(
        conflicts,
        "INVALID_ISSUE_LABELS",
        `Issue ${String(issue.id)} labelIds must be an array`,
        String(issue.id ?? ""),
      );
    if (issue.stateHistory != null && !Array.isArray(issue.stateHistory))
      add(
        conflicts,
        "INVALID_FIELD",
        `Issue ${String(issue.id)} stateHistory must be an array`,
        String(issue.id ?? ""),
      );
    if (issue.attachments != null && !Array.isArray(issue.attachments))
      add(
        conflicts,
        "INVALID_FIELD",
        `Issue ${String(issue.id)} attachments must be an array`,
        String(issue.id ?? ""),
      );
    if (issue.documents != null && !Array.isArray(issue.documents))
      add(
        conflicts,
        "INVALID_FIELD",
        `Issue ${String(issue.id)} documents must be an array`,
        String(issue.id ?? ""),
      );
  }

  if (
    !source.workspace ||
    !requiredString(
      source.workspace.id,
      "workspace id",
      conflicts,
      String(source.workspace?.id ?? ""),
    ) ||
    !requiredString(
      source.workspace.name,
      "workspace name",
      conflicts,
      String(source.workspace?.id ?? ""),
    )
  ) {
    add(conflicts, "INVALID_WORKSPACE", "workspace id and name are required");
  }
  recordDuplicateIds(source.actors, "actor", conflicts);
  recordDuplicateIds(source.teams, "team", conflicts);
  recordDuplicateIds(source.labels, "label", conflicts);
  recordDuplicateIds(source.projects, "project", conflicts);
  recordDuplicateIds(
    source.teams.flatMap((team) => (Array.isArray(team.states) ? team.states : [])),
    "state",
    conflicts,
  );
  recordDuplicateIds(
    source.projects.flatMap((project) =>
      Array.isArray(project.milestones) ? project.milestones : [],
    ),
    "milestone",
    conflicts,
  );
  recordDuplicateIds(source.issues, "issue", conflicts);
  recordDuplicateIds(comments, "comment", conflicts);
  recordDuplicateIds(
    relations.filter((relation) => relation.id),
    "relation",
    conflicts,
  );

  const actorById = new Map(source.actors.map((actor) => [actor.id, actor]));
  const actorNameById = new Map<string, string>();
  const names = new Map<string, string>();
  for (const actor of source.actors) {
    if (
      !requiredString(actor.id, "actor id", conflicts, String(actor.id ?? "")) ||
      !requiredString(actor.name, "actor name", conflicts, String(actor.id ?? ""))
    )
      continue;
    if (actor.email != null && typeof actor.email !== "string")
      add(conflicts, "INVALID_FIELD", "actor email must be a string", actor.id);
    if (actor.type != null && actor.type !== "human" && actor.type !== "agent")
      add(
        conflicts,
        "INVALID_ACTOR_TYPE",
        `Actor type ${String(actor.type)} is not supported`,
        actor.id,
      );
    if (names.has(actor.name) && names.get(actor.name) !== actor.id)
      add(conflicts, "AMBIGUOUS_ACTOR_NAME", `Actor name ${actor.name} is not unique`, actor.id);
    names.set(actor.name, actor.id);
    actorNameById.set(actor.id, actor.name);
  }

  const issueById = new Map(source.issues.map((issue) => [issue.id, issue]));
  const duplicateTeamIds = new Set<string>();
  for (const relation of relations) {
    const duplicateId =
      relation.type === "duplicate_of"
        ? relation.issueId
        : relation.type === "duplicated_by"
          ? relation.relatedIssueId
          : null;
    if (duplicateId) {
      const duplicateIssue = issueById.get(duplicateId);
      if (duplicateIssue) duplicateTeamIds.add(duplicateIssue.teamId);
    }
  }

  const teamById = new Map(source.teams.map((team) => [team.id, team]));
  const teamKeyById = new Map<string, string>();
  const teamMembersById = new Map<string, LinearTeamMember[]>();
  const teamKeys = new Map<string, string>();
  const stateNameById = new Map<string, string>();
  const stateTypeById = new Map<string, string>();
  const stateTeamById = new Map<string, string>();
  const exportStatesByTeam = new Map<string, LinearState[]>();
  const automationByTeam = new Map<
    string,
    {
      autoClosePeriod: number | null;
      autoArchivePeriod: number | null;
      autoCloseState: string | null;
      autoCloseParentIssues: boolean | null;
      autoCloseChildIssues: boolean | null;
    }
  >();
  for (const team of source.teams) {
    if (
      !requiredString(team.id, "team id", conflicts, String(team.id ?? "")) ||
      !requiredString(team.key, "team key", conflicts, String(team.id ?? "")) ||
      !requiredString(team.name, "team name", conflicts, String(team.id ?? ""))
    )
      continue;
    const key = targetTeamKey(team, options);
    if (!TEAM_KEY_RE.test(key))
      add(conflicts, "INVALID_TEAM_KEY", `Team key ${key} must match [A-Z][A-Z0-9]{0,7}`, team.id);
    if (teamKeys.has(key) && teamKeys.get(key) !== team.id)
      add(
        conflicts,
        "DUPLICATE_TEAM_KEY",
        `Team key ${key} is used by more than one team`,
        team.id,
      );
    teamKeys.set(key, team.id);
    teamKeyById.set(team.id, key);
    const members = team.members;
    const validMembers: LinearTeamMember[] = [];
    if (!Array.isArray(members)) {
      add(
        conflicts,
        "MISSING_TEAM_MEMBERSHIPS",
        `Team ${key} must declare memberships instead of inferring owners`,
        team.id,
      );
    } else if (members.length === 0) {
      add(conflicts, "EMPTY_TEAM_MEMBERSHIPS", `Team ${key} must have members`, team.id);
    } else {
      const memberActorIds = new Set<string>();
      for (const member of members) {
        if (!requiredString(member.actorId, "team member actorId", conflicts, team.id)) continue;
        if (!actorNameById.has(member.actorId)) {
          add(
            conflicts,
            "UNKNOWN_TEAM_MEMBER",
            `Team ${key} refers to unknown member ${member.actorId}`,
            team.id,
          );
          continue;
        }
        if (member.role !== "member" && member.role !== "owner") {
          add(
            conflicts,
            "INVALID_TEAM_MEMBER_ROLE",
            `Team ${key} member ${member.actorId} has invalid role ${String(member.role)}`,
            team.id,
          );
          continue;
        }
        if (memberActorIds.has(member.actorId)) {
          add(
            conflicts,
            "DUPLICATE_TEAM_MEMBER",
            `Team ${key} repeats member ${member.actorId}`,
            team.id,
          );
          continue;
        }
        memberActorIds.add(member.actorId);
        validMembers.push(member);
      }
      if (!validMembers.some((member) => member.role === "owner"))
        add(conflicts, "MISSING_TEAM_OWNER", `Team ${key} must have an owner`, team.id);
    }
    teamMembersById.set(team.id, validMembers);
    if (!Array.isArray(team.states)) {
      add(conflicts, "INVALID_FIELD", `Team ${key} states must be an array`, team.id);
      continue;
    }
    const stateNames = new Set<string>();
    const exportedStates: LinearState[] = [];
    const existingCanceled = team.states.find(
      (state) => typeof state.type === "string" && state.type.toLowerCase() === "canceled",
    );
    let canceledStateName = existingCanceled?.name ?? null;
    for (const state of team.states) {
      if (
        !requiredString(state.id, "state id", conflicts, String(state.id ?? "")) ||
        !requiredString(state.name, "state name", conflicts, String(state.id ?? "")) ||
        !requiredString(state.type, "state type", conflicts, String(state.id ?? ""))
      )
        continue;
      stateTeamById.set(state.id, team.id);
      const mapped = stateType(state.type, warnings, state.id);
      if (!mapped) {
        add(
          conflicts,
          "UNSUPPORTED_STATE_TYPE",
          `State type ${state.type} is not supported`,
          state.id,
        );
        continue;
      }
      if (state.color != null && typeof state.color !== "string")
        add(conflicts, "INVALID_FIELD", `State ${state.name} color must be a string`, state.id);
      if (
        state.position != null &&
        (typeof state.position !== "number" || !Number.isFinite(state.position))
      )
        add(conflicts, "INVALID_FIELD", `State ${state.name} position must be finite`, state.id);
      if (state.type.toLowerCase() === "duplicate") {
        if (!canceledStateName) {
          canceledStateName = "Canceled";
          if ([...stateNames].some((name) => name.toLowerCase() === "canceled")) {
            add(
              conflicts,
              "DUPLICATE_CANCELED_STATE",
              `Team ${key} has a custom Canceled state and a Duplicate state`,
              state.id,
            );
          } else {
            stateNames.add(canceledStateName);
            exportedStates.push({
              id: `${team.id}:canceled`,
              name: canceledStateName,
              type: "canceled",
              color: state.color ?? null,
              position: state.position ?? 0,
              description: "Work that will not be completed.",
            });
          }
        }
        stateNameById.set(state.id, canceledStateName);
        stateTypeById.set(state.id, "canceled");
        continue;
      }
      if (stateNames.has(state.name))
        add(
          conflicts,
          "DUPLICATE_STATE_NAME",
          `State ${state.name} repeats in team ${key}`,
          state.id,
        );
      stateNames.add(state.name);
      stateNameById.set(state.id, state.name);
      stateTypeById.set(state.id, mapped);
      if (mapped === "canceled") {
        canceledStateName = state.name;
      }
      exportedStates.push({ ...state, type: mapped });
    }
    if (duplicateTeamIds.has(team.id) && !canceledStateName) {
      canceledStateName = "Canceled";
      if ([...stateNames].some((name) => name.toLowerCase() === "canceled")) {
        add(
          conflicts,
          "DUPLICATE_CANCELED_STATE",
          `Team ${key} has a custom Canceled state that conflicts with duplicate-of`,
          team.id,
        );
      } else {
        stateNames.add(canceledStateName);
        exportedStates.push({
          id: `${team.id}:canceled`,
          name: canceledStateName,
          type: "canceled",
          color: "#95a2b3",
          position: exportedStates.length,
          description: "Work that will not be completed.",
        });
      }
    }
    exportStatesByTeam.set(team.id, exportedStates);
    if (team.defaultStateId != null && !stateNameById.has(team.defaultStateId))
      add(
        conflicts,
        "UNKNOWN_DEFAULT_STATE",
        `Team ${key} refers to unknown default state ${team.defaultStateId}`,
        team.id,
      );
    else if (team.defaultStateId != null && stateTeamById.get(team.defaultStateId) !== team.id)
      add(
        conflicts,
        "CROSS_TEAM_DEFAULT_STATE",
        `Team ${key} default state ${team.defaultStateId} belongs to another team`,
        team.id,
      );
    if (team.autoCloseStateId != null) {
      const closeState = team.states.find((state) => state.id === team.autoCloseStateId);
      if (!closeState) {
        add(
          conflicts,
          "UNKNOWN_AUTO_CLOSE_STATE",
          `Team ${key} refers to unknown auto-close state ${team.autoCloseStateId}`,
          team.id,
        );
      } else if (stateTypeById.get(closeState.id) !== "completed") {
        add(
          conflicts,
          "INVALID_AUTO_CLOSE_STATE",
          `Team ${key} auto-close state must be completed`,
          team.id,
        );
      }
    }
    for (const field of ["autoCloseParentIssues", "autoCloseChildIssues"] as const) {
      const value = team[field];
      if (value != null && typeof value !== "boolean")
        add(conflicts, "INVALID_FIELD", `Team ${key} ${field} must be a boolean`, team.id);
    }
    automationByTeam.set(team.id, {
      autoClosePeriod: normalizeAutomationPeriod(
        team.autoClosePeriod,
        "autoClosePeriod",
        conflicts,
        team.id,
      ),
      autoArchivePeriod: normalizeAutomationPeriod(
        team.autoArchivePeriod,
        "autoArchivePeriod",
        conflicts,
        team.id,
      ),
      autoCloseState: team.autoCloseStateId
        ? (stateNameById.get(team.autoCloseStateId) ?? null)
        : null,
      autoCloseParentIssues:
        team.autoCloseParentIssues == null ? null : Boolean(team.autoCloseParentIssues),
      autoCloseChildIssues:
        team.autoCloseChildIssues == null ? null : Boolean(team.autoCloseChildIssues),
    });
  }

  const labelById = new Map(source.labels.map((label) => [label.id, label]));
  const labelNames = new Map<string, string>();
  for (const label of source.labels) {
    if (
      !requiredString(label.id, "label id", conflicts, String(label.id ?? "")) ||
      !requiredString(label.name, "label name", conflicts, String(label.id ?? ""))
    )
      continue;
    if (label.color != null && typeof label.color !== "string")
      add(conflicts, "INVALID_FIELD", `Label ${label.name} color must be a string`, label.id);
    const scope = label.teamId ? teamKeyById.get(label.teamId) : "workspace";
    if (!scope) {
      add(
        conflicts,
        "UNKNOWN_LABEL_TEAM",
        `Label ${label.name} refers to an unknown team`,
        label.id,
      );
      continue;
    }
    const key = `${scope}/${label.name}`;
    if (labelNames.has(key) && labelNames.get(key) !== label.id)
      add(conflicts, "DUPLICATE_LABEL", `Label ${key} is ambiguous`, label.id);
    labelNames.set(key, label.id);
  }

  const projectById = new Map(source.projects.map((project) => [project.id, project]));
  const projectNameById = new Map<string, string>();
  const projectNames = new Map<string, string>();
  const projectTeamsById = new Map<string, Set<string>>();
  const milestoneNameById = new Map<string, string>();
  const milestoneProjectById = new Map<string, string>();
  for (const project of source.projects) {
    if (
      !requiredString(project.id, "project id", conflicts, String(project.id ?? "")) ||
      !requiredString(project.name, "project name", conflicts, String(project.id ?? "")) ||
      !requiredString(project.state, "project state", conflicts, String(project.id ?? ""))
    )
      continue;
    if (!VALID_PROJECT_STATES.has(project.state))
      add(
        conflicts,
        "UNSUPPORTED_PROJECT_STATE",
        `Project state ${project.state} is not supported`,
        project.id,
      );
    if (project.description != null && typeof project.description !== "string")
      add(
        conflicts,
        "INVALID_FIELD",
        `Project ${project.name} description must be a string`,
        project.id,
      );
    if (project.targetDate != null)
      ensureDate(project.targetDate, "project.targetDate", conflicts, project.id);
    if (project.archivedAt != null)
      ensureDate(project.archivedAt, "project.archivedAt", conflicts, project.id);
    if (project.leadId != null && !actorNameById.has(project.leadId))
      add(
        conflicts,
        "UNKNOWN_PROJECT_LEAD",
        `Project refers to unknown lead ${project.leadId}`,
        project.id,
      );
    if (!Array.isArray(project.teamIds))
      add(
        conflicts,
        "INVALID_PROJECT_TEAMS",
        `Project ${project.name} must declare teamIds`,
        project.id,
      );
    else if (project.teamIds.length === 0)
      add(
        conflicts,
        "EMPTY_PROJECT_TEAMS",
        `Project ${project.name} must belong to at least one team`,
        project.id,
      );
    const projectTeams = new Set<string>();
    for (const teamId of project.teamIds ?? []) {
      if (!teamById.has(teamId)) {
        add(
          conflicts,
          "UNKNOWN_PROJECT_TEAM",
          `Project ${project.name} refers to unknown team ${teamId}`,
          project.id,
        );
        continue;
      }
      if (projectTeams.has(teamId))
        add(
          conflicts,
          "DUPLICATE_PROJECT_TEAM",
          `Project ${project.name} repeats team ${teamId}`,
          project.id,
        );
      projectTeams.add(teamId);
    }
    projectTeamsById.set(project.id, projectTeams);
    if (projectNames.has(project.name) && projectNames.get(project.name) !== project.id)
      add(
        conflicts,
        "DUPLICATE_PROJECT_NAME",
        `Project name ${project.name} is ambiguous`,
        project.id,
      );
    projectNames.set(project.name, project.id);
    projectNameById.set(project.id, project.name);
    const milestoneNames = new Set<string>();
    for (const milestone of Array.isArray(project.milestones) ? project.milestones : []) {
      if (
        !requiredString(milestone.id, "milestone id", conflicts, String(milestone.id ?? "")) ||
        !requiredString(milestone.name, "milestone name", conflicts, String(milestone.id ?? ""))
      )
        continue;
      if (milestone.description != null && typeof milestone.description !== "string")
        add(
          conflicts,
          "INVALID_FIELD",
          `Milestone ${milestone.name} description must be a string`,
          milestone.id,
        );
      if (milestone.targetDate != null)
        ensureDate(milestone.targetDate, "milestone.targetDate", conflicts, milestone.id);
      if (
        milestone.position != null &&
        (typeof milestone.position !== "number" || !Number.isFinite(milestone.position))
      )
        add(
          conflicts,
          "INVALID_FIELD",
          `Milestone ${milestone.name} position must be finite`,
          milestone.id,
        );
      if (milestoneNames.has(milestone.name))
        add(
          conflicts,
          "DUPLICATE_MILESTONE_NAME",
          `Milestone ${project.name}/${milestone.name} is ambiguous`,
          milestone.id,
        );
      milestoneNames.add(milestone.name);
      const key = `${project.name}/${milestone.name}`;
      if (milestoneNameById.has(milestone.id))
        add(conflicts, "DUPLICATE_MILESTONE_ID", `Milestone ${milestone.id} repeats`, milestone.id);
      milestoneNameById.set(milestone.id, key);
      milestoneProjectById.set(milestone.id, project.id);
    }
  }
  const issueIdentifierById = new Map<string, string>();
  const identifiers = new Map<string, string>();
  const parentGraph = new Map<string, Set<string>>();
  for (const issue of source.issues) parentGraph.set(issue.id, new Set());
  for (const issue of source.issues) {
    if (
      !requiredString(issue.id, "issue id", conflicts, String(issue.id ?? "")) ||
      !requiredString(issue.identifier, "issue identifier", conflicts, String(issue.id ?? "")) ||
      !requiredString(issue.title, "issue title", conflicts, String(issue.id ?? "")) ||
      !requiredString(issue.teamId, "issue teamId", conflicts, String(issue.id ?? "")) ||
      !requiredString(issue.stateId, "issue stateId", conflicts, String(issue.id ?? "")) ||
      !requiredString(issue.creatorId, "issue creatorId", conflicts, String(issue.id ?? ""))
    )
      continue;
    const team = teamById.get(issue.teamId);
    if (!team) {
      add(
        conflicts,
        "UNKNOWN_ISSUE_TEAM",
        `Issue refers to unknown team ${issue.teamId}`,
        issue.id,
      );
      continue;
    }
    if (!Number.isInteger(issue.number) || issue.number < 1)
      add(
        conflicts,
        "INVALID_ISSUE_NUMBER",
        `Issue number ${issue.number} must be a positive integer`,
        issue.id,
      );
    const sourceTeamKey = team.key.trim().toUpperCase();
    const parsedIdentifier = ISSUE_IDENTIFIER_RE.exec(issue.identifier.trim());
    if (
      !parsedIdentifier ||
      parsedIdentifier[1] !== sourceTeamKey ||
      Number(parsedIdentifier[2]) !== issue.number
    )
      add(
        conflicts,
        "INVALID_ISSUE_IDENTIFIER",
        `Issue identifier ${issue.identifier} does not match ${sourceTeamKey}-${issue.number}`,
        issue.id,
      );
    const identifier = issueIdentifierForExport(issue, team, options);
    if (identifiers.has(identifier) && identifiers.get(identifier) !== issue.id)
      add(
        conflicts,
        "IDENTIFIER_COLLISION",
        `${identifier} is used by more than one source issue`,
        issue.id,
      );
    identifiers.set(identifier, issue.id);
    issueIdentifierById.set(issue.id, identifier);
    if (issue.description != null && typeof issue.description !== "string")
      add(conflicts, "INVALID_FIELD", `Issue ${issue.id} description must be a string`, issue.id);
    ensureDate(issue.createdAt, "createdAt", conflicts, issue.id);
    ensureDate(issue.updatedAt, "updatedAt", conflicts, issue.id);
    if (issue.archivedAt != null) ensureDate(issue.archivedAt, "archivedAt", conflicts, issue.id);
    if (
      issue.priority != null &&
      (!Number.isInteger(issue.priority) || issue.priority < 0 || issue.priority > 4)
    )
      add(conflicts, "INVALID_PRIORITY", `Priority ${issue.priority} is outside 0..4`, issue.id);
    if (!stateNameById.has(issue.stateId))
      add(
        conflicts,
        "UNKNOWN_ISSUE_STATE",
        `Issue refers to unknown state ${issue.stateId}`,
        issue.id,
      );
    else if (stateTeamById.get(issue.stateId) !== issue.teamId)
      add(
        conflicts,
        "CROSS_TEAM_ISSUE_STATE",
        `Issue state ${issue.stateId} does not belong to team ${issue.teamId}`,
        issue.id,
      );
    if (!actorNameById.has(issue.creatorId))
      add(
        conflicts,
        "UNKNOWN_ISSUE_CREATOR",
        `Issue refers to unknown creator ${issue.creatorId}`,
        issue.id,
      );
    if (issue.assigneeId && !actorNameById.has(issue.assigneeId))
      add(
        conflicts,
        "UNKNOWN_ISSUE_ASSIGNEE",
        `Issue refers to unknown assignee ${issue.assigneeId}`,
        issue.id,
      );
    if (issue.parentId) {
      const parent = issueById.get(issue.parentId);
      if (!parent)
        add(
          conflicts,
          "UNKNOWN_PARENT",
          `Issue refers to unknown parent ${issue.parentId}`,
          issue.id,
        );
      else if (parent.teamId !== issue.teamId)
        add(
          conflicts,
          "CROSS_TEAM_PARENT",
          `Issue parent ${issue.parentId} does not belong to team ${issue.teamId}`,
          issue.id,
        );
      else parentGraph.get(issue.id)?.add(issue.parentId);
    }
    if (issue.projectId) {
      const project = projectById.get(issue.projectId);
      if (!project)
        add(
          conflicts,
          "UNKNOWN_ISSUE_PROJECT",
          `Issue refers to unknown project ${issue.projectId}`,
          issue.id,
        );
      else if (!projectTeamsById.get(project.id)?.has(issue.teamId))
        add(
          conflicts,
          "CROSS_TEAM_ISSUE_PROJECT",
          `Project ${issue.projectId} does not include issue team ${issue.teamId}`,
          issue.id,
        );
    }
    if (issue.milestoneId) {
      if (!milestoneNameById.has(issue.milestoneId))
        add(
          conflicts,
          "UNKNOWN_ISSUE_MILESTONE",
          `Issue refers to unknown milestone ${issue.milestoneId}`,
          issue.id,
        );
      else if (!issue.projectId)
        add(
          conflicts,
          "MILESTONE_WITHOUT_PROJECT",
          `Issue milestone ${issue.milestoneId} requires a project`,
          issue.id,
        );
      else if (milestoneProjectById.get(issue.milestoneId) !== issue.projectId)
        add(
          conflicts,
          "CROSS_PROJECT_ISSUE_MILESTONE",
          `Issue milestone ${issue.milestoneId} does not belong to project ${issue.projectId}`,
          issue.id,
        );
    }
    if (issue.labelIds != null && !Array.isArray(issue.labelIds))
      add(
        conflicts,
        "INVALID_ISSUE_LABELS",
        `Issue ${issue.id} labelIds must be an array`,
        issue.id,
      );
    const issueLabels = new Set<string>();
    for (const labelId of Array.isArray(issue.labelIds) ? issue.labelIds : []) {
      if (issueLabels.has(labelId))
        add(conflicts, "DUPLICATE_ISSUE_LABEL", `Issue repeats label ${labelId}`, issue.id);
      issueLabels.add(labelId);
      const label = labelById.get(labelId);
      if (!label)
        add(conflicts, "UNKNOWN_ISSUE_LABEL", `Issue refers to unknown label ${labelId}`, issue.id);
      else if (label.teamId != null && label.teamId !== issue.teamId)
        add(
          conflicts,
          "CROSS_TEAM_ISSUE_LABEL",
          `Issue label ${labelId} does not belong to team ${issue.teamId}`,
          issue.id,
        );
    }
    const history = Array.isArray(issue.stateHistory) ? issue.stateHistory : [];
    let previousStartedAt: number | null = null;
    for (const entry of history) {
      if (!requiredString(entry.stateId, "stateHistory.stateId", conflicts, issue.id)) continue;
      if (!ensureDate(entry.startedAt, "stateHistory.startedAt", conflicts, issue.id)) continue;
      const startedAt = Date.parse(entry.startedAt);
      if (previousStartedAt != null && startedAt < previousStartedAt)
        add(
          conflicts,
          "UNORDERED_STATE_HISTORY",
          `Issue ${issue.id} state history is not chronological`,
          issue.id,
        );
      previousStartedAt = startedAt;
      if (!stateNameById.has(entry.stateId))
        add(
          conflicts,
          "UNKNOWN_STATE_HISTORY_STATE",
          `Issue history refers to unknown state ${entry.stateId}`,
          issue.id,
        );
      else if (stateTeamById.get(entry.stateId) !== issue.teamId)
        add(
          conflicts,
          "CROSS_TEAM_STATE_HISTORY",
          `Issue history state ${entry.stateId} is outside its team`,
          issue.id,
        );
    }
    const lastHistory = history.at(-1);
    if (lastHistory && lastHistory.stateId !== issue.stateId)
      add(
        conflicts,
        "STATE_HISTORY_FINAL_MISMATCH",
        `Issue ${issue.id} state history does not end at its current state`,
        issue.id,
      );
    if (issue.dueDate != null) {
      ensureDate(issue.dueDate, "dueDate", conflicts, issue.id);
      add(
        losses,
        "UNREPRESENTED_DUE_DATE",
        "Due date is not part of the prime-board issue model",
        issue.id,
      );
    }
    if (issue.estimate != null)
      add(
        losses,
        "UNREPRESENTED_ESTIMATE",
        "Estimate is not part of the prime-board issue model",
        issue.id,
      );
    if (issue.cycleId != null)
      add(
        losses,
        "UNREPRESENTED_CYCLE",
        "Cycle is not part of the prime-board issue model",
        issue.id,
      );
    if (issue.attachments?.length || issue.documents?.length)
      add(
        warnings,
        "LINKED_ISSUE_ARTIFACTS",
        "Issue attachments/documents are converted to links in the description",
        issue.id,
      );
  }
  recordGraphCycles(
    parentGraph,
    "PARENT_CYCLE",
    "Issue parent relationships contain a cycle",
    conflicts,
  );
  for (const project of source.projects) {
    if (Array.isArray(project.documents) && project.documents.length)
      add(
        warnings,
        "LINKED_PROJECT_DOCUMENTS",
        "Project documents are converted to links in the project description",
        project.id,
      );
    for (const link of [
      ...(Array.isArray(project.documents) ? project.documents : []),
      ...(Array.isArray(project.statusUpdates) ? project.statusUpdates : []),
    ]) {
      if (!requiredString(link.url, "project link url", conflicts, project.id)) continue;
      if (link.title != null && typeof link.title !== "string")
        add(conflicts, "INVALID_FIELD", "project link title must be a string", project.id);
    }
    if (
      (Array.isArray(project.statusUpdates) && project.statusUpdates.length) ||
      project.initiativeId
    )
      add(
        losses,
        "UNREPRESENTED_PROJECT_CONTEXT",
        "Project status updates/initiatives have no prime-board entity",
        project.id,
      );
  }
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  for (const comment of comments) {
    if (
      !requiredString(comment.id, "comment id", conflicts, String(comment.id ?? "")) ||
      !requiredString(comment.issueId, "comment issueId", conflicts, String(comment.id ?? "")) ||
      !requiredString(comment.authorId, "comment authorId", conflicts, String(comment.id ?? "")) ||
      !requiredString(comment.body, "comment body", conflicts, String(comment.id ?? ""))
    )
      continue;
    if (!issueById.has(comment.issueId))
      add(
        conflicts,
        "UNKNOWN_COMMENT_ISSUE",
        `Comment refers to unknown issue ${comment.issueId}`,
        comment.id,
      );
    if (!actorNameById.has(comment.authorId))
      add(
        conflicts,
        "UNKNOWN_COMMENT_AUTHOR",
        `Comment refers to unknown actor ${comment.authorId}`,
        comment.id,
      );
    ensureDate(comment.createdAt, "comment.createdAt", conflicts, comment.id);
    if (comment.parentId) {
      const parent = commentsById.get(comment.parentId);
      if (!parent)
        add(
          conflicts,
          "UNKNOWN_COMMENT_PARENT",
          `Comment refers to unknown parent comment ${comment.parentId}`,
          comment.id,
        );
      else if (parent.issueId !== comment.issueId)
        add(
          conflicts,
          "CROSS_ISSUE_COMMENT_PARENT",
          `Comment parent ${comment.parentId} belongs to another issue`,
          comment.id,
        );
    }
    if (comment.quotedText != null && typeof comment.quotedText !== "string")
      add(conflicts, "INVALID_FIELD", "comment quotedText must be a string", comment.id);
    if (comment.parentId || comment.quotedText)
      add(
        losses,
        "COMMENT_THREAD_OR_INLINE",
        "Comment thread/inline anchor is flattened to an issue comment",
        comment.id,
      );
  }
  const blockGraph = new Map<string, Set<string>>();
  for (const issue of source.issues) blockGraph.set(issue.id, new Set());
  const relationKeys = new Set<string>();
  for (const relation of relations) {
    const sourceId = String(relation.issueId ?? "");
    const targetId = String(relation.relatedIssueId ?? "");
    if (
      !requiredString(relation.issueId, "relation issueId", conflicts, relation.id ?? sourceId) ||
      !requiredString(
        relation.relatedIssueId,
        "relation relatedIssueId",
        conflicts,
        relation.id ?? targetId,
      )
    )
      continue;
    if (!RELATION_TYPES.has(relation.type)) {
      add(
        conflicts,
        "UNKNOWN_RELATION_TYPE",
        `Relation type ${String(relation.type)} is not supported`,
        relation.id,
      );
      continue;
    }
    if (!issueById.has(sourceId) || !issueById.has(targetId)) {
      add(conflicts, "UNKNOWN_RELATION_ISSUE", "Relation refers to an unknown issue", relation.id);
      continue;
    }
    if (sourceId === targetId) {
      add(conflicts, "SELF_RELATION", "An issue cannot be related to itself", relation.id);
      continue;
    }
    if (relation.createdAt != null)
      ensureDate(relation.createdAt, "relation.createdAt", conflicts, relation.id ?? sourceId);
    let canonicalSource = sourceId;
    let canonicalTarget = targetId;
    let canonicalType: "blocks" | "related" | "duplicate_of" = "blocks";
    if (relation.type === "blocked_by") {
      canonicalSource = targetId;
      canonicalTarget = sourceId;
    } else if (relation.type === "related") {
      canonicalType = "related";
      if (canonicalSource > canonicalTarget)
        [canonicalSource, canonicalTarget] = [canonicalTarget, canonicalSource];
    } else if (relation.type === "duplicated_by") {
      canonicalSource = targetId;
      canonicalTarget = sourceId;
      canonicalType = "duplicate_of";
    } else if (relation.type === "duplicate_of") canonicalType = "duplicate_of";
    const key = `${canonicalType}:${canonicalSource}:${canonicalTarget}`;
    if (relationKeys.has(key))
      add(conflicts, "DUPLICATE_RELATION", `Relation ${key} repeats`, relation.id);
    relationKeys.add(key);
    if (canonicalType === "blocks") blockGraph.get(canonicalSource)?.add(canonicalTarget);
  }
  recordGraphCycles(
    blockGraph,
    "BLOCKING_RELATION_CYCLE",
    "Blocking relations contain a cycle",
    conflicts,
  );
  let sourceMap = createSourceMap(source.workspace?.id ?? "");
  sourceMap = addSourceMapping(
    sourceMap,
    "actors",
    Object.fromEntries([...actorNameById].map(([id, name]) => [id, `name:${name}`])),
  );
  sourceMap = addSourceMapping(sourceMap, "teams", Object.fromEntries(teamKeyById));
  sourceMap = addSourceMapping(
    sourceMap,
    "states",
    Object.fromEntries(
      [...stateNameById].map(([id, name]) => [
        id,
        `${teamKeyById.get(source.teams.find((team) => Array.isArray(team.states) && team.states.some((state) => state.id === id))?.id ?? "") ?? "?"}/${name}`,
      ]),
    ),
  );
  sourceMap = addSourceMapping(
    sourceMap,
    "labels",
    Object.fromEntries(
      [...labelById].map(([id, label]) => [
        id,
        `${label.teamId ? teamKeyById.get(label.teamId) : "workspace"}/${label.name}`,
      ]),
    ),
  );
  sourceMap = addSourceMapping(sourceMap, "projects", Object.fromEntries(projectNameById));
  sourceMap = addSourceMapping(sourceMap, "milestones", Object.fromEntries(milestoneNameById));
  sourceMap = addSourceMapping(sourceMap, "issues", Object.fromEntries(issueIdentifierById));
  sourceMap = addSourceMapping(
    sourceMap,
    "comments",
    Object.fromEntries(
      comments.map((comment) => [
        comment.id,
        `${issueIdentifierById.get(comment.issueId) ?? "?"}#${comment.id}`,
      ]),
    ),
  );
  sourceMap = addSourceMapping(
    sourceMap,
    "relations",
    Object.fromEntries(
      relations
        .filter((relation) => relation.id)
        .map((relation) => [
          relation.id!,
          `${issueIdentifierById.get(relation.issueId) ?? "?"}|${relation.type}|${issueIdentifierById.get(relation.relatedIssueId) ?? "?"}`,
        ]),
    ),
  );

  const result: LinearRepoExportResult = {
    issues: source.issues.length,
    comments: comments.length,
    events: 0,
    files: 0,
    conflicts,
    losses,
    warnings,
    sourceMap,
  };
  if (options.dryRun) return result;
  if (conflicts.length > 0) throw new Error(`Linear import has ${conflicts.length} conflict(s)`);
  if (losses.length > 0 && !options.allowLosses)
    throw new Error(`Linear import has ${losses.length} unapproved loss(es)`);

  const base = join(rootDir, ".prime-board");
  for (const folder of ["meta", "issues", "log"])
    mkdirSync(join(base, folder), { recursive: true });
  const write = (relative: string, content: string) => {
    writeFileSync(join(base, relative), content, "utf8");
    result.files += 1;
  };
  write("meta/export.json", json(createReplicaMetadata(source.workspace.id)));
  write(
    "meta/workspace.json",
    json({ name: source.workspace.name, urlKey: source.workspace.urlKey ?? "prime-board" }),
  );
  write(
    "meta/actors.json",
    json(
      source.actors
        .map((actor) => ({
          name: actor.name,
          email: actor.email ?? null,
          type: actor.type === "agent" ? "agent" : "human",
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ),
  );
  write(
    "meta/workspace-labels.json",
    json(
      source.labels
        .filter((label) => !label.teamId)
        .map((label) => ({ name: label.name, color: label.color ?? "#95a2b3" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ),
  );
  write(
    "meta/teams.json",
    json(
      source.teams
        .map((team) => {
          const automation = automationByTeam.get(team.id)!;
          const states = exportStatesByTeam.get(team.id) ?? [];
          return {
            key: teamKeyById.get(team.id),
            name: team.name,
            description: team.description ?? null,
            autoClosePeriod: automation.autoClosePeriod,
            autoArchivePeriod: automation.autoArchivePeriod,
            autoCloseState: automation.autoCloseState,
            autoCloseParentIssues: automation.autoCloseParentIssues,
            autoCloseChildIssues: automation.autoCloseChildIssues,
            defaultState: team.defaultStateId
              ? (stateNameById.get(team.defaultStateId) ?? null)
              : (states[0]?.name ?? null),
            states: states.map((state) => ({
              name: state.name,
              type: stateTypeById.get(state.id) ?? state.type,
              color: state.color ?? "#95a2b3",
              position: state.position ?? 0,
              description: state.description ?? null,
            })),
            labels: source.labels
              .filter((label) => label.teamId === team.id)
              .map((label) => ({ name: label.name, color: label.color ?? "#95a2b3" }))
              .sort((a, b) => a.name.localeCompare(b.name)),
            members: (teamMembersById.get(team.id) ?? [])
              .map((member) => ({
                actor: actorNameById.get(member.actorId)!,
                role: member.role,
              }))
              .sort((a, b) => a.actor.localeCompare(b.actor) || a.role.localeCompare(b.role)),
          };
        })
        .sort((a, b) => a.key!.localeCompare(b.key!)),
    ),
  );
  const projectDescription = (project: LinearProject): string | null => {
    const links = (project.documents ?? []).map(
      (link) => `- [${link.title ?? link.url}](${link.url})`,
    );
    if (links.length === 0) return project.description ?? null;
    return `${project.description ? `${project.description}\n\n` : ""}## Linear documents\n${links.join("\n")}`;
  };
  write(
    "meta/projects.json",
    json(
      source.projects
        .map((project) => ({
          name: project.name,
          description: projectDescription(project),
          state: project.state,
          lead: project.leadId ? (actorNameById.get(project.leadId) ?? null) : null,
          targetDate: project.targetDate ?? null,
          archived: Boolean(project.archivedAt),
          teams: (project.teamIds ?? []).map((id) => teamKeyById.get(id)!).sort(),
          milestones: (project.milestones ?? [])
            .map((milestone) => ({
              name: milestone.name,
              description: milestone.description ?? null,
              targetDate: milestone.targetDate ?? null,
              position: milestone.position ?? 0,
            }))
            .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ),
  );

  const relationFields = new Map<
    string,
    { blockedBy: Set<string>; related: Set<string>; duplicateOf: Set<string> }
  >();
  for (const issue of source.issues)
    relationFields.set(issue.id, {
      blockedBy: new Set(),
      related: new Set(),
      duplicateOf: new Set(),
    });
  for (const relation of relations) {
    const sourceFields = relationFields.get(relation.issueId);
    const targetFields = relationFields.get(relation.relatedIssueId);
    if (!sourceFields || !targetFields) continue;
    if (relation.type === "blocked_by")
      sourceFields.blockedBy.add(issueIdentifierById.get(relation.relatedIssueId)!);
    if (relation.type === "blocks")
      targetFields.blockedBy.add(issueIdentifierById.get(relation.issueId)!);
    if (relation.type === "related") {
      const a = issueIdentifierById.get(relation.issueId)!;
      const b = issueIdentifierById.get(relation.relatedIssueId)!;
      if (a < b) sourceFields.related.add(b);
      else targetFields.related.add(a);
    }
    if (relation.type === "duplicate_of")
      sourceFields.duplicateOf.add(issueIdentifierById.get(relation.relatedIssueId)!);
    if (relation.type === "duplicated_by")
      targetFields.duplicateOf.add(issueIdentifierById.get(relation.issueId)!);
  }
  const commentsByIssue = new Map<string, LinearComment[]>();
  for (const comment of comments) {
    const list = commentsByIssue.get(comment.issueId) ?? [];
    list.push(comment);
    commentsByIssue.set(comment.issueId, list);
  }
  for (const issue of [...source.issues].sort((a, b) =>
    issueIdentifierById.get(a.id)!.localeCompare(issueIdentifierById.get(b.id)!),
  )) {
    const team = teamById.get(issue.teamId)!;
    const identifier = issueIdentifierById.get(issue.id)!;
    const fields = relationFields.get(issue.id)!;
    const labelNamesForIssue = (issue.labelIds ?? [])
      .map((id) => labelById.get(id))
      .filter(Boolean)
      .map((label) => ({
        name: label!.name,
        team: label!.teamId ? (teamKeyById.get(label!.teamId) ?? null) : null,
      }))
      .sort((a, b) =>
        `${a.team ?? "workspace"}/${a.name}`.localeCompare(`${b.team ?? "workspace"}/${b.name}`),
      );
    const frontMatter = {
      id: identifier,
      title: issue.title,
      team: teamKeyById.get(team.id),
      state: stateNameById.get(issue.stateId) ?? null,
      priority: issue.priority ?? 0,
      assignee: issue.assigneeId ? (actorNameById.get(issue.assigneeId) ?? null) : null,
      creator: actorNameById.get(issue.creatorId) ?? null,
      parent: issue.parentId ? (issueIdentifierById.get(issue.parentId) ?? null) : null,
      project: issue.projectId ? (projectNameById.get(issue.projectId) ?? null) : null,
      milestone: issue.milestoneId ? (milestoneNameById.get(issue.milestoneId) ?? null) : null,
      labels: labelNamesForIssue,
      ...(fields.blockedBy.size ? { blockedBy: [...fields.blockedBy].sort() } : {}),
      ...(fields.related.size ? { related: [...fields.related].sort() } : {}),
      ...(fields.duplicateOf.size ? { duplicateOf: [...fields.duplicateOf].sort() } : {}),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      archivedAt: issue.archivedAt ?? null,
    };
    const artifactLinks = [
      ...(Array.isArray(issue.attachments) ? issue.attachments : []),
      ...(Array.isArray(issue.documents) ? issue.documents : []),
    ].map((link) => `- [${link.title ?? link.filename ?? link.url}](${link.url})`);
    const description =
      artifactLinks.length > 0
        ? `${issue.description ? `${issue.description}\n\n` : ""}## Linear artifacts\n${artifactLinks.join("\n")}`
        : issue.description;
    const body = description ? `\n${description.replace(/\s*$/, "")}\n` : "";
    write(
      `issues/${identifier}.md`,
      `---\n${toYaml(frontMatter, { sortMapEntries: true, lineWidth: 0 })}---\n\n# ${issue.title}\n${body}`,
    );
    const events: Array<{
      actor: string;
      issue: string;
      payload: Record<string, unknown>;
      ts: string;
      type: string;
      order: number;
    }> = [];
    events.push({
      actor: actorNameById.get(issue.creatorId)!,
      issue: identifier,
      ts: issue.createdAt,
      type: "created",
      order: 0,
      payload: {
        title: issue.title,
        description: description ?? null,
        team: teamKeyById.get(team.id),
        number: issue.number,
        priority: issue.priority ?? 0,
        state: stateNameById.get(issue.stateId) ?? null,
        assignee: issue.assigneeId ? (actorNameById.get(issue.assigneeId) ?? null) : null,
        parent: issue.parentId ? (issueIdentifierById.get(issue.parentId) ?? null) : null,
        project: issue.projectId ? (projectNameById.get(issue.projectId) ?? null) : null,
        milestone: issue.milestoneId ? (milestoneNameById.get(issue.milestoneId) ?? null) : null,
      },
    });
    const history = Array.isArray(issue.stateHistory) ? issue.stateHistory : [];
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1]!;
      const current = history[index]!;
      events.push({
        actor: actorNameById.get(issue.creatorId)!,
        issue: identifier,
        ts: current.startedAt,
        type: "state_changed",
        order: index,
        payload: {
          from: stateNameById.get(previous.stateId) ?? previous.stateId,
          to: stateNameById.get(current.stateId) ?? current.stateId,
        },
      });
    }
    for (const comment of (commentsByIssue.get(issue.id) ?? []).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )) {
      events.push({
        actor: actorNameById.get(comment.authorId)!,
        issue: identifier,
        ts: comment.createdAt,
        type: "commented",
        order: 1000,
        payload: { body: comment.body },
      });
    }
    if (issue.archivedAt)
      events.push({
        actor: actorNameById.get(issue.creatorId)!,
        issue: identifier,
        ts: issue.archivedAt,
        type: "archived",
        order: 2000,
        payload: {},
      });
    events.sort((a, b) => a.ts.localeCompare(b.ts) || a.order - b.order);
    write(
      `log/${identifier}.jsonl`,
      events.map(({ order: _order, ...event }) => JSON.stringify(event)).join("\n") + "\n",
    );
    result.events += events.length;
  }
  write(
    "meta/migration-report.json",
    json({
      source: "linear",
      workspaceId: source.workspace.id,
      entities: {
        actors: source.actors.length,
        teams: source.teams.length,
        states: source.teams.reduce((count, team) => count + team.states.length, 0),
        labels: source.labels.length,
        projects: source.projects.length,
        milestones: source.projects.reduce(
          (count, project) => count + (project.milestones?.length ?? 0),
          0,
        ),
        issues: source.issues.length,
        comments: (source.comments ?? []).length,
        relations: (source.relations ?? []).length,
      },
      issues: result.issues,
      comments: result.comments,
      events: result.events,
      conflicts: result.conflicts,
      losses: result.losses,
      warnings: result.warnings,
    }),
  );
  writeSourceMap(rootDir, sourceMap);
  return result;
}
