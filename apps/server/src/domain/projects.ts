// Dominio de proyectos (spec §3): agrupan issues, con lead, estado y fecha objetivo.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getActor } from "./actors.ts";
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
  input: { state?: string | null; leadId?: string | null; targetDate?: string | null },
): void {
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
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
    teamIds?: string[] | null;
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
      `INSERT INTO projects (id, name, description, state, lead_id, target_date, created_at, updated_at, workspace_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`,
    ).run(
      id,
      name,
      input.description ?? null,
      input.state ?? "backlog",
      input.leadId ?? null,
      input.targetDate ?? null,
      timestamp,
      workspaceId ?? null,
    );
    // Sin teamIds explícitos, el proyecto se asocia a todos los teams actuales
    // (compatibilidad con clientes previos a AT-152).
    setProjectTeams(db, id, input.teamIds ?? allTeamIds(db, workspaceId), workspaceId);
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
    teamIds?: string[] | null;
  },
  workspaceId?: string,
): ProjectRow {
  const project = getProject(db, id, workspaceId);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  validate(db, input);
  if (input.teamIds) setProjectTeams(db, id, input.teamIds, workspaceId);

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
