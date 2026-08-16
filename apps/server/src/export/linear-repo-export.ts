import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { createSourceMap, mergeSourceMap, writeSourceMap, type SourceMap } from "./source-map.ts";

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
}
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  states: LinearState[];
  defaultStateId?: string | null;
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
  return value as unknown as LinearExport;
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
  value: string | null | undefined,
  label: string,
  conflicts: MigrationFinding[],
  sourceId: string,
): boolean {
  if (!value || value.trim() === "") {
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
function issueIdentifier(
  issue: LinearIssue,
  team: LinearTeam,
  options: LinearRepoExportOptions,
): string {
  return `${targetTeamKey(team, options)}-${issue.number}`;
}
function ensureDate(
  value: string,
  label: string,
  findings: MigrationFinding[],
  sourceId: string,
): boolean {
  if (Number.isNaN(Date.parse(value))) {
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

/**
 * Convierte una captura de Linear a `.prime-board/`. La función no toca el repo
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
  const comments = source.comments ?? [];
  const relations = source.relations ?? [];

  if (!source.workspace?.id || !source.workspace.name)
    add(conflicts, "INVALID_WORKSPACE", "workspace id and name are required");
  const actorById = new Map(source.actors.map((actor) => [actor.id, actor]));
  const actorNameById = new Map<string, string>();
  const names = new Map<string, string>();
  for (const actor of source.actors) {
    if (
      !requiredString(actor.id, "actor id", conflicts, actor.id) ||
      !requiredString(actor.name, "actor name", conflicts, actor.id)
    )
      continue;
    if (names.has(actor.name) && names.get(actor.name) !== actor.id)
      add(conflicts, "AMBIGUOUS_ACTOR_NAME", `Actor name ${actor.name} is not unique`, actor.id);
    names.set(actor.name, actor.id);
    actorNameById.set(actor.id, actor.name);
  }

  const teamById = new Map(source.teams.map((team) => [team.id, team]));
  const teamKeyById = new Map<string, string>();
  const teamKeys = new Map<string, string>();
  const stateNameById = new Map<string, string>();
  const stateTypeById = new Map<string, string>();
  for (const team of source.teams) {
    if (
      !requiredString(team.id, "team id", conflicts, team.id) ||
      !requiredString(team.key, "team key", conflicts, team.id)
    )
      continue;
    const key = targetTeamKey(team, options);
    if (teamKeys.has(key) && teamKeys.get(key) !== team.id)
      add(
        conflicts,
        "DUPLICATE_TEAM_KEY",
        `Team key ${key} is used by more than one team`,
        team.id,
      );
    teamKeys.set(key, team.id);
    teamKeyById.set(team.id, key);
    const stateNames = new Set<string>();
    for (const state of team.states ?? []) {
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
    }
  }

  const labelById = new Map(source.labels.map((label) => [label.id, label]));
  const labelNames = new Map<string, string>();
  for (const label of source.labels) {
    if (
      !requiredString(label.id, "label id", conflicts, label.id) ||
      !requiredString(label.name, "label name", conflicts, label.id)
    )
      continue;
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
  const milestoneNameById = new Map<string, string>();
  for (const project of source.projects) {
    if (
      !requiredString(project.id, "project id", conflicts, project.id) ||
      !requiredString(project.name, "project name", conflicts, project.id)
    )
      continue;
    if (!VALID_PROJECT_STATES.has(project.state))
      add(
        conflicts,
        "UNSUPPORTED_PROJECT_STATE",
        `Project state ${project.state} is not supported`,
        project.id,
      );
    if (projectNames.has(project.name) && projectNames.get(project.name) !== project.id)
      add(
        conflicts,
        "DUPLICATE_PROJECT_NAME",
        `Project name ${project.name} is ambiguous`,
        project.id,
      );
    projectNames.set(project.name, project.id);
    projectNameById.set(project.id, project.name);
    for (const milestone of project.milestones ?? []) {
      const key = `${project.name}/${milestone.name}`;
      if (milestoneNameById.has(milestone.id))
        add(conflicts, "DUPLICATE_MILESTONE_ID", `Milestone ${milestone.id} repeats`, milestone.id);
      milestoneNameById.set(milestone.id, key);
    }
  }

  const issueById = new Map(source.issues.map((issue) => [issue.id, issue]));
  const issueIdentifierById = new Map<string, string>();
  const identifiers = new Map<string, string>();
  for (const issue of source.issues) {
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
    const identifier = issueIdentifier(issue, team, options);
    if (identifiers.has(identifier) && identifiers.get(identifier) !== issue.id)
      add(
        conflicts,
        "IDENTIFIER_COLLISION",
        `${identifier} is used by more than one source issue`,
        issue.id,
      );
    identifiers.set(identifier, issue.id);
    issueIdentifierById.set(issue.id, identifier);
    ensureDate(issue.createdAt, "createdAt", conflicts, issue.id);
    ensureDate(issue.updatedAt, "updatedAt", conflicts, issue.id);
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
    if (issue.parentId && !issueById.has(issue.parentId))
      add(
        conflicts,
        "UNKNOWN_PARENT",
        `Issue refers to unknown parent ${issue.parentId}`,
        issue.id,
      );
    if (issue.projectId && !projectById.has(issue.projectId))
      add(
        conflicts,
        "UNKNOWN_ISSUE_PROJECT",
        `Issue refers to unknown project ${issue.projectId}`,
        issue.id,
      );
    if (issue.milestoneId && !milestoneNameById.has(issue.milestoneId))
      add(
        conflicts,
        "UNKNOWN_ISSUE_MILESTONE",
        `Issue refers to unknown milestone ${issue.milestoneId}`,
        issue.id,
      );
    for (const labelId of issue.labelIds ?? [])
      if (!labelById.has(labelId))
        add(conflicts, "UNKNOWN_ISSUE_LABEL", `Issue refers to unknown label ${labelId}`, issue.id);
    if (issue.dueDate != null)
      add(
        losses,
        "UNREPRESENTED_DUE_DATE",
        "Due date is not part of the prime-board issue model",
        issue.id,
      );
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
  for (const project of source.projects) {
    if (project.documents?.length)
      add(
        warnings,
        "LINKED_PROJECT_DOCUMENTS",
        "Project documents are converted to links in the project description",
        project.id,
      );
    if (project.statusUpdates?.length || project.initiativeId)
      add(
        losses,
        "UNREPRESENTED_PROJECT_CONTEXT",
        "Project status updates/initiatives have no prime-board entity",
        project.id,
      );
  }
  for (const comment of comments) {
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
    if (comment.parentId || comment.quotedText)
      add(
        losses,
        "COMMENT_THREAD_OR_INLINE",
        "Comment thread/inline anchor is flattened to an issue comment",
        comment.id,
      );
  }
  for (const relation of relations) {
    if (!issueById.has(relation.issueId) || !issueById.has(relation.relatedIssueId))
      add(conflicts, "UNKNOWN_RELATION_ISSUE", "Relation refers to an unknown issue", relation.id);
  }

  let sourceMap = createSourceMap(source.workspace.id);
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
        `${teamKeyById.get(source.teams.find((team) => team.states.some((state) => state.id === id))?.id ?? "") ?? "?"}/${name}`,
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
  write("meta/export.json", json({ scope: "workspace" }));
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
        .map((team) => ({
          key: teamKeyById.get(team.id),
          name: team.name,
          description: team.description ?? null,
          defaultState: team.defaultStateId
            ? (stateNameById.get(team.defaultStateId) ?? null)
            : team.states[0]
              ? (stateNameById.get(team.states[0].id) ?? null)
              : null,
          states: team.states.map((state) => ({
            name: state.name,
            type: stateTypeById.get(state.id),
            color: state.color ?? "#95a2b3",
            position: state.position ?? 0,
          })),
          labels: source.labels
            .filter((label) => label.teamId === team.id)
            .map((label) => ({ name: label.name, color: label.color ?? "#95a2b3" }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
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
          teams: (project.teamIds.length ? project.teamIds : source.teams.map((team) => team.id))
            .map((id) => teamKeyById.get(id))
            .filter(Boolean)
            .sort(),
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
      .map((label) => label!.name)
      .sort();
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
      milestone: issue.milestoneId
        ? projectNameById.get(issue.projectId ?? "")
          ? (source.projects.find((project) => project.id === issue.projectId)?.name ?? "") +
            "/" +
            (
              source.projects.find((project) => project.id === issue.projectId)?.milestones ?? []
            ).find((milestone) => milestone.id === issue.milestoneId)?.name
          : null
        : null,
      labels: labelNamesForIssue,
      ...(fields.blockedBy.size ? { blockedBy: [...fields.blockedBy].sort() } : {}),
      ...(fields.related.size ? { related: [...fields.related].sort() } : {}),
      ...(fields.duplicateOf.size ? { duplicateOf: [...fields.duplicateOf].sort() } : {}),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      archivedAt: issue.archivedAt ?? null,
    };
    const artifactLinks = [...(issue.attachments ?? []), ...(issue.documents ?? [])].map(
      (link) => `- [${link.title ?? link.filename ?? link.url}](${link.url})`,
    );
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
    const history = issue.stateHistory ?? [];
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
  writeSourceMap(rootDir, sourceMap);
  return result;
}
