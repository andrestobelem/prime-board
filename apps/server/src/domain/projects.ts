// Dominio de proyectos (spec §3): agrupan issues, con lead, estado y fecha objetivo.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getActor } from "./actors.ts";
import { assertTeamActive } from "./teams.ts";
import { parseDateTime } from "./datetime.ts";

function workspaceClause(column: string, parameter: string): string {
  return `(${column} = ${parameter} OR (${column} IS NULL AND (SELECT count(*) FROM workspace) = 1))`;
}

export const PROJECT_STATES = [
  "backlog",
  "planned",
  "started",
  "paused",
  "completed",
  "canceled",
] as const;

export interface ProjectRow {
  id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  state: (typeof PROJECT_STATES)[number];
  lead_id: string | null;
  target_date: string | null;
  start_date: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function mapProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    leadId: row.lead_id,
    targetDate: row.target_date,
    startDate: row.start_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function getProject(db: Database, id: string, workspaceId?: string): ProjectRow | null {
  const query = workspaceId
    ? `SELECT * FROM projects WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT * FROM projects WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as ProjectRow | null;
}

export function archiveProject(
  db: Database,
  id: string,
  archived: boolean,
  workspaceId?: string,
): ProjectRow {
  const project = getProject(db, id, workspaceId);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  if (workspaceId) {
    db.query(
      `UPDATE projects SET archived_at = ?1, updated_at = ?2 WHERE id = ?3 AND ${workspaceClause("workspace_id", "?4")}`,
    ).run(archived ? now() : null, now(), id, workspaceId);
  } else {
    db.query("UPDATE projects SET archived_at = ?1, updated_at = ?2 WHERE id = ?3").run(
      archived ? now() : null,
      now(),
      id,
    );
  }
  return getProject(db, id, workspaceId)!;
}

export function listProjects(
  db: Database,
  state?: string | null,
  teamId?: string | null,
  includeArchived = false,
  workspaceId?: string,
): ProjectRow[] {
  const where: string[] = includeArchived ? [] : ["archived_at IS NULL"];
  const params: unknown[] = [];
  if (workspaceId) {
    params.push(workspaceId);
    where.push(workspaceClause("workspace_id", `?${params.length}`));
  }
  if (state) {
    params.push(state);
    where.push(`state = ?${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    where.push(`id IN (SELECT project_id FROM project_teams WHERE team_id = ?${params.length})`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return db
    .query(`SELECT * FROM projects ${clause} ORDER BY created_at`)
    .all(...(params as never[])) as ProjectRow[];
}

/** Teams asociados a un proyecto (relación N:M, paridad con Linear). */
export function listProjectTeamIds(
  db: Database,
  projectId: string,
  workspaceId?: string,
): string[] {
  const query = workspaceId
    ? `SELECT team_id FROM project_teams WHERE project_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT team_id FROM project_teams WHERE project_id = ?1";
  return (
    workspaceId ? db.query(query).values(projectId, workspaceId) : db.query(query).values(projectId)
  ).map((row) => row[0] as string);
}

export function projectIncludesTeam(
  db: Database,
  projectId: string,
  teamId: string,
  workspaceId?: string,
): boolean {
  if (workspaceId) {
    return Boolean(
      db
        .query(
          `SELECT 1 FROM project_teams
           WHERE project_id = ?1 AND team_id = ?2 AND ${workspaceClause("workspace_id", "?3")}`,
        )
        .get(projectId, teamId, workspaceId),
    );
  }
  return Boolean(
    db
      .query("SELECT 1 FROM project_teams WHERE project_id = ?1 AND team_id = ?2")
      .get(projectId, teamId),
  );
}

function setProjectTeams(
  db: Database,
  projectId: string,
  teamIds: string[],
  workspaceId?: string,
): void {
  if (teamIds.length === 0) {
    throw apiError("VALIDATION_FAILED", "A project must belong to at least one team");
  }
  for (const teamId of teamIds) {
    const team = workspaceId
      ? db
          .query(`SELECT id FROM teams WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`)
          .get(teamId, workspaceId)
      : db.query("SELECT id FROM teams WHERE id = ?1").get(teamId);
    if (!team) throw apiError("NOT_FOUND", `Team not found: ${teamId}`);
    assertTeamActive(db, teamId, workspaceId);
  }
  if (workspaceId) {
    db.query(
      `DELETE FROM project_teams WHERE project_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
    ).run(projectId, workspaceId);
  } else {
    db.query("DELETE FROM project_teams WHERE project_id = ?1").run(projectId);
  }
  for (const teamId of new Set(teamIds)) {
    db.query(
      "INSERT INTO project_teams (project_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
    ).run(projectId, teamId, workspaceId ?? null);
  }
}

function allTeamIds(db: Database, workspaceId?: string): string[] {
  const query = workspaceId
    ? `SELECT id FROM teams WHERE archived_at IS NULL AND ${workspaceClause("workspace_id", "?1")}`
    : "SELECT id FROM teams WHERE archived_at IS NULL";
  return (workspaceId ? db.query(query).values(workspaceId) : db.query(query).values()).map(
    (row) => row[0] as string,
  );
}

function validate(
  db: Database,
  input: {
    state?: string | null;
    leadId?: string | null;
    targetDate?: string | null;
    startDate?: string | null;
  },
): void {
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  if (input.startDate != null) parseDateTime(input.startDate, "startDate");
  if (input.startDate != null && input.targetDate != null && input.startDate > input.targetDate) {
    throw apiError("VALIDATION_FAILED", "Project startDate cannot be after targetDate");
  }
  if (input.state != null && !PROJECT_STATES.includes(input.state as never)) {
    throw apiError("VALIDATION_FAILED", `Invalid project state: ${input.state}`);
  }
  if (input.leadId != null && !getActor(db, input.leadId)) {
    throw apiError("NOT_FOUND", "Lead actor not found");
  }
}

export function createProject(
  db: Database,
  input: {
    name: string;
    description?: string | null;
    state?: string | null;
    leadId?: string | null;
    targetDate?: string | null;
    startDate?: string | null;
    memberIds?: string[] | null;
    teamIds?: string[] | null;
    dependencyIds?: string[] | null;
  },
  workspaceId?: string,
): ProjectRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Project name cannot be empty");
  validate(db, input);

  const id = newId();
  db.transaction(() => {
    const timestamp = now();
    db.query(
      `INSERT INTO projects (id, name, description, state, lead_id, target_date, start_date, created_at, updated_at, workspace_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`,
    ).run(
      id,
      name,
      input.description ?? null,
      input.state ?? "backlog",
      input.leadId ?? null,
      input.targetDate ?? null,
      input.startDate ?? null,
      timestamp,
      workspaceId ?? null,
    );
    // Sin teamIds explícitos, el proyecto se asocia a todos los teams actuales
    // (compatibilidad con clientes previos a AT-152).
    setProjectTeams(db, id, input.teamIds ?? allTeamIds(db, workspaceId), workspaceId);
    setProjectMembers(db, id, input.memberIds ?? [], workspaceId);
    setProjectDependencies(db, id, input.dependencyIds ?? [], workspaceId);
  })();
  return getProject(db, id, workspaceId)!;
}

export function updateProject(
  db: Database,
  id: string,
  input: {
    name?: string | null;
    description?: string | null;
    state?: string | null;
    leadId?: string | null;
    targetDate?: string | null;
    startDate?: string | null;
    memberIds?: string[] | null;
    teamIds?: string[] | null;
    dependencyIds?: string[] | null;
  },
  workspaceId?: string,
): ProjectRow {
  const project = getProject(db, id, workspaceId);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  validate(db, input);
  if (input.teamIds) setProjectTeams(db, id, input.teamIds, workspaceId);
  if (input.memberIds !== undefined) setProjectMembers(db, id, input.memberIds ?? [], workspaceId);
  if (input.dependencyIds !== undefined)
    setProjectDependencies(db, id, input.dependencyIds ?? [], workspaceId);

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
    params.push(value);
  };
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Project name cannot be empty");
    push("name", name);
  }
  if (input.description !== undefined) push("description", input.description);
  if (input.state != null) push("state", input.state);
  if (input.leadId !== undefined) push("lead_id", input.leadId);
  if (input.targetDate !== undefined) push("target_date", input.targetDate);
  if (input.startDate !== undefined) push("start_date", input.startDate);

  if (sets.length > 0) {
    push("updated_at", now());
    const idParameter = params.length + 1;
    params.push(id);
    const scope = workspaceId
      ? ` AND ${workspaceClause("workspace_id", `?${params.length + 1}`)}`
      : "";
    if (workspaceId) params.push(workspaceId);
    db.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?${idParameter}${scope}`).run(
      ...(params as never[]),
    );
  }
  return getProject(db, id, workspaceId)!;
}

export function listProjectMemberIds(
  db: Database,
  projectId: string,
  workspaceId?: string,
): string[] {
  const query = workspaceId
    ? `SELECT actor_id FROM project_members WHERE project_id = ?1 AND ${workspaceClause("workspace_id", "?2")} ORDER BY actor_id`
    : "SELECT actor_id FROM project_members WHERE project_id = ?1 ORDER BY actor_id";
  return (
    workspaceId ? db.query(query).values(projectId, workspaceId) : db.query(query).values(projectId)
  ).map((row) => row[0] as string);
}

export function projectHasMember(
  db: Database,
  projectId: string,
  actorId: string,
  workspaceId?: string,
): boolean {
  const query = workspaceId
    ? `SELECT 1 FROM project_members WHERE project_id = ?1 AND actor_id = ?2 AND ${workspaceClause("workspace_id", "?3")}`
    : "SELECT 1 FROM project_members WHERE project_id = ?1 AND actor_id = ?2";
  return Boolean(
    workspaceId
      ? db.query(query).get(projectId, actorId, workspaceId)
      : db.query(query).get(projectId, actorId),
  );
}

function setProjectMembers(
  db: Database,
  projectId: string,
  actorIds: string[],
  workspaceId?: string,
): void {
  const unique = [...new Set(actorIds)];
  for (const actorId of unique) {
    const actor = getActor(db, actorId);
    if (!actor) throw apiError("NOT_FOUND", `Project member not found: ${actorId}`);
  }
  if (workspaceId)
    db.query(
      `DELETE FROM project_members WHERE project_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
    ).run(projectId, workspaceId);
  else db.query("DELETE FROM project_members WHERE project_id = ?1").run(projectId);
  for (const actorId of unique)
    db.query(
      "INSERT INTO project_members (project_id, actor_id, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4)",
    ).run(projectId, actorId, now(), workspaceId ?? null);
}

export interface ProjectDependencyRow {
  id: string;
  project_id: string;
  depends_on_project_id: string;
  type: "blocks" | "related";
  created_at: string;
}

export function getProjectDependency(
  db: Database,
  id: string,
  workspaceId?: string,
): ProjectDependencyRow | null {
  const query = workspaceId
    ? `SELECT id, project_id, depends_on_project_id, type, created_at FROM project_dependencies WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT id, project_id, depends_on_project_id, type, created_at FROM project_dependencies WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as ProjectDependencyRow | null;
}

export function listProjectDependencyRows(
  db: Database,
  projectId: string,
  workspaceId?: string,
): ProjectDependencyRow[] {
  const query = workspaceId
    ? `SELECT id, project_id, depends_on_project_id, type, created_at FROM project_dependencies WHERE project_id = ?1 AND ${workspaceClause("workspace_id", "?2")} ORDER BY created_at, id`
    : "SELECT id, project_id, depends_on_project_id, type, created_at FROM project_dependencies WHERE project_id = ?1 ORDER BY created_at, id";
  return (
    workspaceId ? db.query(query).all(projectId, workspaceId) : db.query(query).all(projectId)
  ) as ProjectDependencyRow[];
}

function setProjectDependencies(
  db: Database,
  projectId: string,
  dependencyIds: string[],
  workspaceId?: string,
): void {
  const unique = [...new Set(dependencyIds)];
  for (const dependsOnProjectId of unique) {
    if (dependsOnProjectId === projectId)
      throw apiError("VALIDATION_FAILED", "A project cannot depend on itself");
    const dependency = getProject(db, dependsOnProjectId, workspaceId);
    if (!dependency)
      throw apiError("NOT_FOUND", `Dependency project not found: ${dependsOnProjectId}`);
  }
  if (workspaceId)
    db.query(
      `DELETE FROM project_dependencies WHERE project_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
    ).run(projectId, workspaceId);
  else db.query("DELETE FROM project_dependencies WHERE project_id = ?1").run(projectId);
  for (const dependsOnProjectId of unique)
    db.query(
      "INSERT INTO project_dependencies (id, project_id, depends_on_project_id, type, created_at, workspace_id) VALUES (?1, ?2, ?3, 'blocks', ?4, ?5)",
    ).run(newId(), projectId, dependsOnProjectId, now(), workspaceId ?? null);
}

export function createProjectDependency(
  db: Database,
  input: { projectId: string; dependsOnProjectId: string; type?: string | null },
  workspaceId?: string,
): {
  id: string;
  project_id: string;
  depends_on_project_id: string;
  type: "blocks" | "related";
  created_at: string;
} {
  if (input.projectId === input.dependsOnProjectId)
    throw apiError("VALIDATION_FAILED", "A project cannot depend on itself");
  const project = getProject(db, input.projectId, workspaceId);
  const target = getProject(db, input.dependsOnProjectId, workspaceId);
  if (!project || !target) throw apiError("NOT_FOUND", "Dependency project not found");
  const normalizedType = input.type?.toLowerCase();
  const type =
    normalizedType === "related"
      ? "related"
      : normalizedType === "blocks" || normalizedType == null
        ? "blocks"
        : null;
  if (!type) throw apiError("VALIDATION_FAILED", `Invalid project dependency type: ${input.type}`);
  const id = newId();
  db.query(
    "INSERT INTO project_dependencies (id, project_id, depends_on_project_id, type, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(id, input.projectId, input.dependsOnProjectId, type, now(), workspaceId ?? null);
  return db
    .query(
      "SELECT id, project_id, depends_on_project_id, type, created_at FROM project_dependencies WHERE id = ?1",
    )
    .get(id) as {
    id: string;
    project_id: string;
    depends_on_project_id: string;
    type: "blocks" | "related";
    created_at: string;
  };
}

export function deleteProjectDependency(db: Database, id: string, workspaceId?: string): boolean {
  const result = workspaceId
    ? db
        .query(
          `DELETE FROM project_dependencies WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
        )
        .run(id, workspaceId)
    : db.query("DELETE FROM project_dependencies WHERE id = ?1").run(id);
  if (!result.changes) throw apiError("NOT_FOUND", "Project dependency not found");
  return true;
}
