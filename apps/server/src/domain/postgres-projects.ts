import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { getPostgresActor } from "./postgres-actors.ts";
import {
  assertPostgresTeamActive,
  canDiscoverPostgresTeam,
  canWritePostgresTeam,
  getPostgresTeam,
  listPostgresTeams,
} from "./postgres-teams.ts";
import { newId, now } from "../db/util.ts";
import { PROJECT_STATES, validateProjectDateRange } from "./projects.ts";
import type { ActorRow } from "../auth/viewer.ts";

export interface PostgresProjectRow {
  id: string;
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

export interface PostgresProjectInput {
  name: string;
  description?: string | null;
  state?: string | null;
  leadId?: string | null;
  targetDate?: string | null;
  startDate?: string | null;
  memberIds?: string[] | null;
  dependencyIds?: string[] | null;
  teamIds?: string[] | null;
}

export interface PostgresProjectUpdateInput {
  name?: string | null;
  description?: string | null;
  state?: string | null;
  leadId?: string | null;
  targetDate?: string | null;
  startDate?: string | null;
  memberIds?: string[] | null;
  dependencyIds?: string[] | null;
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
    startDate: row.start_date,
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
  startDate?: string | null;
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
  validateProjectDateRange(input.startDate, input.targetDate);
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

async function postgresProjectHasMember(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
  actorId: string,
): Promise<boolean> {
  return Boolean(
    await persistence.one("SELECT 1 FROM project_members WHERE project_id = $1 AND actor_id = $2", [
      projectId,
      actorId,
    ]),
  );
}

export async function canAccessPostgresProject(
  persistence: Persistence,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  projectId: string,
): Promise<boolean> {
  const teamIds = await listPostgresProjectTeamIds(persistence, projectId);
  if (viewer.workspace_role === "admin") return true;
  if (await postgresProjectHasMember(persistence, projectId, viewer.id)) return true;
  if (teamIds.length === 0) return false;
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
  if (
    viewer.workspace_role !== "admin" &&
    (await postgresProjectHasMember(persistence, projectId, viewer.id))
  )
    return project;
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

export async function listPostgresProjectMemberIds(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
): Promise<string[]> {
  const rows = await persistence.many<{ actor_id: string }>(
    "SELECT actor_id FROM project_members WHERE project_id = $1 ORDER BY actor_id",
    [projectId],
  );
  return rows.map((row) => row.actor_id);
}

export async function listPostgresProjectDependencyRows(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
): Promise<
  readonly {
    id: string;
    project_id: string;
    depends_on_project_id: string;
    type: "blocks" | "related";
    created_at: string;
  }[]
> {
  return persistence.many(
    "SELECT id, project_id, depends_on_project_id, type, created_at FROM project_dependencies WHERE project_id = $1 ORDER BY created_at, id",
    [projectId],
  );
}

async function validateProjectMembers(
  persistence: Persistence | PersistenceTransaction,
  memberIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(memberIds)];
  for (const actorId of unique) {
    if (!(await getPostgresActor(persistence, actorId)))
      throw apiError("NOT_FOUND", `Project member not found: ${actorId}`);
  }
  return unique;
}

async function validateProjectDependencies(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
  dependencyIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(dependencyIds)];
  for (const dependencyId of unique) {
    if (dependencyId === projectId)
      throw apiError("VALIDATION_FAILED", "A project cannot depend on itself");
    if (!(await getPostgresProject(persistence, dependencyId)))
      throw apiError("NOT_FOUND", `Dependency project not found: ${dependencyId}`);
  }
  return unique;
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
  const members = await validateProjectMembers(persistence, input.memberIds ?? []);
  const dependencies = await validateProjectDependencies(
    persistence,
    "",
    input.dependencyIds ?? [],
  );
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
       (id, name, description, state, lead_id, target_date, start_date, created_at, updated_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NULL)`,
      [
        id,
        name,
        input.description ?? null,
        input.state ?? "backlog",
        input.leadId ?? null,
        input.targetDate ?? null,
        input.startDate ?? null,
        timestamp,
      ],
    );
    for (const teamId of teamIds) {
      await tx.execute("INSERT INTO project_teams (project_id, team_id) VALUES ($1, $2)", [
        id,
        teamId,
      ]);
    }
    for (const actorId of members) {
      await tx.execute(
        "INSERT INTO project_members (project_id, actor_id, created_at) VALUES ($1, $2, $3)",
        [id, actorId, timestamp],
      );
    }
    for (const dependencyId of dependencies) {
      await tx.execute(
        "INSERT INTO project_dependencies (id, project_id, depends_on_project_id, type, created_at) VALUES ($1, $2, $3, 'blocks', $4)",
        [newId(), id, dependencyId, timestamp],
      );
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
  validateProjectFields({
    ...input,
    targetDate: input.targetDate === undefined ? existing.target_date : input.targetDate,
    startDate: input.startDate === undefined ? existing.start_date : input.startDate,
  });
  await validateLead(persistence, input.leadId);
  const memberIds =
    input.memberIds === undefined
      ? null
      : await validateProjectMembers(persistence, input.memberIds ?? []);
  const dependencyIds =
    input.dependencyIds === undefined
      ? null
      : await validateProjectDependencies(persistence, id, input.dependencyIds ?? []);
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
  if (input.startDate !== undefined) push("start_date", input.startDate);
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
    if (memberIds) {
      await tx.execute("DELETE FROM project_members WHERE project_id = $1", [id]);
      for (const actorId of memberIds)
        await tx.execute(
          "INSERT INTO project_members (project_id, actor_id, created_at) VALUES ($1, $2, $3)",
          [id, actorId, now()],
        );
    }
    if (dependencyIds) {
      await tx.execute("DELETE FROM project_dependencies WHERE project_id = $1", [id]);
      for (const dependencyId of dependencyIds)
        await tx.execute(
          "INSERT INTO project_dependencies (id, project_id, depends_on_project_id, type, created_at) VALUES ($1, $2, $3, 'blocks', $4)",
          [newId(), id, dependencyId, now()],
        );
    }
    if (sets.length || teamIds || memberIds || dependencyIds) {
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
