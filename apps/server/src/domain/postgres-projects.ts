import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { parseDateTime } from "./datetime.ts";
import { getPostgresActor } from "./postgres-actors.ts";
import {
  assertPostgresTeamActive,
  canDiscoverPostgresTeam,
  canWritePostgresTeam,
  getPostgresTeam,
  listPostgresTeams,
} from "./postgres-teams.ts";
import { newId, now } from "../db/util.ts";
import { PROJECT_STATES } from "./projects.ts";
import type { ActorRow } from "../auth/viewer.ts";

export interface PostgresProjectRow {
  id: string;
  name: string;
  description: string | null;
  state: (typeof PROJECT_STATES)[number];
  lead_id: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface PostgresProjectInput {
  name: string;
  description?: string | null;
  state?: string | null;
  leadId?: string | null;
  targetDate?: string | null;
  teamIds?: string[] | null;
}

export interface PostgresProjectUpdateInput {
  name?: string | null;
  description?: string | null;
  state?: string | null;
  leadId?: string | null;
  targetDate?: string | null;
  teamIds?: string[] | null;
}

export function mapPostgresProject(row: PostgresProjectRow) {
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

export async function getPostgresProject(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<PostgresProjectRow | null> {
  return persistence.one<PostgresProjectRow>("SELECT * FROM projects WHERE id = $1", [id]);
}

export async function listPostgresProjectTeamIds(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
): Promise<string[]> {
  const rows = await persistence.many<{ team_id: string }>(
    "SELECT team_id FROM project_teams WHERE project_id = $1 ORDER BY team_id",
    [projectId],
  );
  return rows.map((row) => row.team_id);
}

export async function listPostgresProjects(
  persistence: Persistence,
  state?: string | null,
  teamId?: string | null,
  includeArchived = false,
): Promise<PostgresProjectRow[]> {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (!includeArchived) clauses.push("projects.archived_at IS NULL");
  if (state) {
    params.push(state);
    clauses.push(`projects.state = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    clauses.push(
      `EXISTS (SELECT 1 FROM project_teams WHERE project_teams.project_id = projects.id AND project_teams.team_id = $${params.length})`,
    );
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return [
    ...(await persistence.many<PostgresProjectRow>(
      `SELECT projects.* FROM projects${where} ORDER BY projects.created_at, projects.id`,
      params,
    )),
  ];
}

async function validateLead(
  persistence: Persistence | PersistenceTransaction,
  leadId: string | null | undefined,
): Promise<void> {
  if (leadId === undefined || leadId === null) return;
  if (!(await getPostgresActor(persistence, leadId))) {
    throw apiError("NOT_FOUND", "Lead actor not found");
  }
}

function validateProjectFields(input: {
  name?: string | null;
  state?: string | null;
  targetDate?: string | null;
}): void {
  if (input.name !== undefined && input.name !== null && !input.name.trim()) {
    throw apiError("VALIDATION_FAILED", "Project name cannot be empty");
  }
  if (
    input.state !== undefined &&
    input.state !== null &&
    !PROJECT_STATES.some((state) => state === input.state)
  ) {
    throw apiError("VALIDATION_FAILED", `Invalid project state: ${input.state}`);
  }
  if (input.targetDate !== undefined && input.targetDate !== null) {
    parseDateTime(input.targetDate, "targetDate");
  }
}

async function validateProjectTeams(
  persistence: Persistence,
  viewer: ActorRow,
  teamIds: readonly string[],
): Promise<string[]> {
  const uniqueTeamIds = [...new Set(teamIds)];
  if (uniqueTeamIds.length === 0) {
    throw apiError("VALIDATION_FAILED", "A project must belong to at least one team");
  }
  for (const teamId of uniqueTeamIds) {
    const team = await assertPostgresTeamActive(persistence, teamId);
    if (!(await canWritePostgresTeam(persistence, viewer, team.id))) {
      throw apiError("UNAUTHORIZED", "Project access policy does not allow this operation");
    }
  }
  return uniqueTeamIds;
}

export async function canAccessPostgresProject(
  persistence: Persistence,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  projectId: string,
): Promise<boolean> {
  const teamIds = await listPostgresProjectTeamIds(persistence, projectId);
  if (teamIds.length === 0) return false;
  if (viewer.workspace_role === "admin") return true;
  for (const teamId of teamIds) {
    const team = await getPostgresTeam(persistence, { id: teamId });
    if (!team || !(await canDiscoverPostgresTeam(persistence, viewer, team))) return false;
  }
  return true;
}

export async function assertCanManagePostgresProject(
  persistence: Persistence,
  viewer: ActorRow,
  projectId: string,
): Promise<PostgresProjectRow> {
  const project = await getPostgresProject(persistence, projectId);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  const teamIds = await listPostgresProjectTeamIds(persistence, projectId);
  if (teamIds.length === 0) throw apiError("NOT_FOUND", "Project not found");
  if (viewer.workspace_role !== "admin") {
    for (const teamId of teamIds) {
      if (!(await canWritePostgresTeam(persistence, viewer, teamId))) {
        throw apiError("UNAUTHORIZED", "Project access policy does not allow this operation");
      }
    }
  }
  return project;
}

export async function createPostgresProject(
  persistence: Persistence,
  viewer: ActorRow,
  input: PostgresProjectInput,
): Promise<PostgresProjectRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Project name cannot be empty");
  validateProjectFields(input);
  await validateLead(persistence, input.leadId);
  const teams =
    input.teamIds == null
      ? (await listPostgresTeams(persistence)).map((team) => team.id)
      : input.teamIds;
  const teamIds = await validateProjectTeams(persistence, viewer, teams);
  const id = newId();
  const timestamp = now();
  await persistence.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO projects
       (id, name, description, state, lead_id, target_date, created_at, updated_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, NULL)`,
      [
        id,
        name,
        input.description ?? null,
        input.state ?? "backlog",
        input.leadId ?? null,
        input.targetDate ?? null,
        timestamp,
      ],
    );
    for (const teamId of teamIds) {
      await tx.execute("INSERT INTO project_teams (project_id, team_id) VALUES ($1, $2)", [
        id,
        teamId,
      ]);
    }
  });
  const project = await getPostgresProject(persistence, id);
  if (!project) throw new Error("PostgreSQL project insert returned no row");
  return project;
}

export async function updatePostgresProject(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  input: PostgresProjectUpdateInput,
): Promise<PostgresProjectRow> {
  const existing = await assertCanManagePostgresProject(persistence, viewer, id);
  validateProjectFields(input);
  await validateLead(persistence, input.leadId);
  const teamIds =
    input.teamIds === undefined
      ? null
      : await validateProjectTeams(persistence, viewer, input.teamIds ?? []);
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const push = (column: string, value: SqlValue) => {
    sets.push(`${column} = $${params.length + 1}`);
    params.push(value);
  };
  if (input.name !== undefined && input.name !== null) push("name", input.name.trim());
  if (input.description !== undefined) push("description", input.description);
  if (input.state !== undefined && input.state !== null) push("state", input.state);
  if (input.leadId !== undefined) push("lead_id", input.leadId);
  if (input.targetDate !== undefined) push("target_date", input.targetDate);
  await persistence.transaction(async (tx) => {
    if (teamIds) {
      await tx.execute("DELETE FROM project_teams WHERE project_id = $1", [id]);
      for (const teamId of teamIds) {
        await tx.execute("INSERT INTO project_teams (project_id, team_id) VALUES ($1, $2)", [
          id,
          teamId,
        ]);
      }
    }
    if (sets.length || teamIds) {
      if (sets.length) {
        push("updated_at", now());
        params.push(id);
        const row = await tx.one<PostgresProjectRow>(
          `UPDATE projects SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
          params,
        );
        if (!row) throw apiError("NOT_FOUND", "Project not found");
      } else {
        await tx.execute("UPDATE projects SET updated_at = $1 WHERE id = $2", [now(), id]);
      }
    }
  });
  return (await getPostgresProject(persistence, existing.id))!;
}

export async function archivePostgresProject(
  persistence: Persistence,
  id: string,
  archived: boolean,
): Promise<PostgresProjectRow> {
  const project = await getPostgresProject(persistence, id);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  const archivedAt = archived ? (project.archived_at ?? now()) : null;
  const row = await persistence.one<PostgresProjectRow>(
    "UPDATE projects SET archived_at = $1, updated_at = $2 WHERE id = $3 RETURNING *",
    [archivedAt, now(), id],
  );
  if (!row) throw apiError("NOT_FOUND", "Project not found");
  return row;
}
