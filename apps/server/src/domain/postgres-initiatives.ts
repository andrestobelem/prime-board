import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { parseDateTime } from "./datetime.ts";
import {
  assertCanManagePostgresProject,
  canAccessPostgresProject,
  listPostgresProjectTeamIds,
} from "./postgres-projects.ts";
import {
  assertPostgresTeamActive,
  canWritePostgresTeam,
  getPostgresTeam,
  isPostgresTeamMember,
} from "./postgres-teams.ts";
import type { ActorRow } from "../auth/viewer.ts";
import type { InitiativeState } from "./initiatives.ts";

export interface PostgresInitiativeRow {
  id: string;
  name: string;
  description: string | null;
  state: InitiativeState;
  target_date: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function mapPostgresInitiative(row: PostgresInitiativeRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    targetDate: row.target_date,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export async function getPostgresInitiative(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<PostgresInitiativeRow | null> {
  return persistence.one<PostgresInitiativeRow>("SELECT * FROM initiatives WHERE id = $1", [id]);
}

export async function listPostgresInitiativeTeamIds(
  persistence: Persistence | PersistenceTransaction,
  initiativeId: string,
): Promise<readonly string[]> {
  const rows = await persistence.many<{ team_id: string }>(
    "SELECT team_id FROM initiative_teams WHERE initiative_id = $1 ORDER BY team_id",
    [initiativeId],
  );
  return rows.map((row) => row.team_id);
}

export async function listPostgresInitiativeProjectIds(
  persistence: Persistence | PersistenceTransaction,
  initiativeId: string,
): Promise<readonly string[]> {
  const rows = await persistence.many<{ project_id: string }>(
    "SELECT project_id FROM initiative_projects WHERE initiative_id = $1 ORDER BY project_id",
    [initiativeId],
  );
  return rows.map((row) => row.project_id);
}

export async function listPostgresInitiativeScopeTeamIds(
  persistence: Persistence | PersistenceTransaction,
  initiativeId: string,
): Promise<string[]> {
  const direct = await listPostgresInitiativeTeamIds(persistence, initiativeId);
  const projectIds = await listPostgresInitiativeProjectIds(persistence, initiativeId);
  const projectTeams: string[] = [];
  for (const projectId of projectIds) {
    projectTeams.push(...(await listPostgresProjectTeamIds(persistence, projectId)));
  }
  return [...new Set([...direct, ...projectTeams])];
}

export async function canAccessPostgresInitiative(
  persistence: Persistence,
  viewer: ActorRow,
  initiativeId: string,
): Promise<boolean> {
  const row = await getPostgresInitiative(persistence, initiativeId);
  if (!row) return false;
  const projectIds = await listPostgresInitiativeProjectIds(persistence, initiativeId);
  for (const projectId of projectIds) {
    if (!(await canAccessPostgresProject(persistence, viewer, projectId))) return false;
  }
  for (const teamId of await listPostgresInitiativeScopeTeamIds(persistence, initiativeId)) {
    const team = await getPostgresTeam(persistence, { id: teamId });
    if (
      !team ||
      (viewer.workspace_role !== "admin" &&
        !(await isPostgresTeamMember(persistence, team.id, viewer.id)))
    )
      return false;
  }
  return true;
}

async function assertCanMutatePostgresInitiative(
  persistence: Persistence,
  viewer: ActorRow,
  initiative: PostgresInitiativeRow,
): Promise<void> {
  if (!(await canAccessPostgresInitiative(persistence, viewer, initiative.id))) {
    throw apiError("NOT_FOUND", "Initiative not found");
  }
  if (initiative.owner_id && initiative.owner_id !== viewer.id) {
    throw apiError("NOT_FOUND", "Initiative not found");
  }
}

function resolveState(state: string): InitiativeState {
  const normalized = state.toLowerCase() as InitiativeState;
  if (!(["planned", "active", "completed", "canceled"] as string[]).includes(normalized)) {
    throw apiError("VALIDATION_FAILED", `Invalid initiative state: ${state}`);
  }
  return normalized;
}

async function validateTeamIds(
  persistence: Persistence,
  viewer: ActorRow,
  teamIds: readonly string[],
): Promise<string[]> {
  const result = [...new Set(teamIds)];
  for (const teamId of result) {
    await assertPostgresTeamActive(persistence, teamId);
    if (!(await canWritePostgresTeam(persistence, viewer, teamId))) {
      throw apiError("UNAUTHORIZED", "Team access policy does not allow this operation");
    }
  }
  return result;
}

async function validateProjectIds(
  persistence: Persistence,
  viewer: ActorRow,
  projectIds: readonly string[],
): Promise<string[]> {
  const result = [...new Set(projectIds)];
  for (const projectId of result)
    await assertCanManagePostgresProject(persistence, viewer, projectId);
  return result;
}

async function replaceRelations(
  tx: PersistenceTransaction,
  initiativeId: string,
  projectIds: readonly string[],
  teamIds: readonly string[],
): Promise<void> {
  await tx.execute("DELETE FROM initiative_projects WHERE initiative_id = $1", [initiativeId]);
  await tx.execute("DELETE FROM initiative_teams WHERE initiative_id = $1", [initiativeId]);
  for (const projectId of projectIds) {
    await tx.execute(
      "INSERT INTO initiative_projects (initiative_id, project_id) VALUES ($1, $2)",
      [initiativeId, projectId],
    );
  }
  for (const teamId of teamIds) {
    await tx.execute("INSERT INTO initiative_teams (initiative_id, team_id) VALUES ($1, $2)", [
      initiativeId,
      teamId,
    ]);
  }
}

export async function listPostgresInitiatives(
  persistence: Persistence,
  includeArchived = false,
  viewer?: ActorRow,
): Promise<readonly PostgresInitiativeRow[]> {
  const rows = await persistence.many<PostgresInitiativeRow>(
    `SELECT * FROM initiatives ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at, id`,
  );
  if (!viewer) return rows;
  const visible: PostgresInitiativeRow[] = [];
  for (const row of rows) {
    if (await canAccessPostgresInitiative(persistence, viewer, row.id)) visible.push(row);
  }
  return visible;
}

export async function createPostgresInitiative(
  persistence: Persistence,
  viewer: ActorRow,
  input: {
    name: string;
    description?: string | null;
    state?: string | null;
    targetDate?: string | null;
    projectIds?: readonly string[] | null;
    teamIds?: readonly string[] | null;
  },
): Promise<PostgresInitiativeRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Initiative name cannot be empty");
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  const projectIds = await validateProjectIds(persistence, viewer, input.projectIds ?? []);
  const teamIds = await validateTeamIds(persistence, viewer, input.teamIds ?? []);
  const id = newId();
  const timestamp = now();
  await persistence.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO initiatives
       (id, name, description, state, target_date, owner_id, created_at, updated_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, NULL)`,
      [
        id,
        name,
        input.description ?? null,
        input.state ? resolveState(input.state) : "planned",
        input.targetDate ?? null,
        viewer.id,
        timestamp,
      ],
    );
    await replaceRelations(tx, id, projectIds, teamIds);
  });
  const row = await getPostgresInitiative(persistence, id);
  if (!row) throw new Error("PostgreSQL initiative insert returned no row");
  return row;
}

export async function updatePostgresInitiative(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  input: {
    name?: string | null;
    description?: string | null;
    state?: string | null;
    targetDate?: string | null;
    projectIds?: readonly string[] | null;
    teamIds?: readonly string[] | null;
    archived?: boolean | null;
  },
): Promise<PostgresInitiativeRow> {
  const existing = await getPostgresInitiative(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "Initiative not found");
  await assertCanMutatePostgresInitiative(persistence, viewer, existing);
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  const projectIds =
    input.projectIds !== undefined && input.projectIds !== null
      ? await validateProjectIds(persistence, viewer, input.projectIds)
      : await listPostgresInitiativeProjectIds(persistence, id);
  const teamIds =
    input.teamIds !== undefined && input.teamIds !== null
      ? await validateTeamIds(persistence, viewer, input.teamIds)
      : await listPostgresInitiativeTeamIds(persistence, id);
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const push = (column: string, value: SqlValue) => {
    sets.push(`${column} = $${params.length + 1}`);
    params.push(value);
  };
  if (input.name !== undefined && input.name !== null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Initiative name cannot be empty");
    push("name", name);
  }
  if (input.description !== undefined) push("description", input.description);
  if (input.state !== undefined && input.state !== null) push("state", resolveState(input.state));
  if (input.targetDate !== undefined) push("target_date", input.targetDate);
  if (input.archived === true) push("archived_at", now());
  if (input.archived === false) push("archived_at", null);
  const relationsChanged =
    (input.projectIds !== undefined && input.projectIds !== null) ||
    (input.teamIds !== undefined && input.teamIds !== null);
  await persistence.transaction(async (tx) => {
    if (sets.length || relationsChanged) {
      if (sets.length) {
        push("updated_at", now());
        params.push(id);
        await tx.execute(
          `UPDATE initiatives SET ${sets.join(", ")} WHERE id = $${params.length}`,
          params,
        );
      } else {
        await tx.execute("UPDATE initiatives SET updated_at = $1 WHERE id = $2", [now(), id]);
      }
      if (relationsChanged) await replaceRelations(tx, id, projectIds, teamIds);
    }
  });
  return (await getPostgresInitiative(persistence, id))!;
}

export async function deletePostgresInitiative(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
): Promise<boolean> {
  const existing = await getPostgresInitiative(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "Initiative not found");
  await assertCanMutatePostgresInitiative(persistence, viewer, existing);
  await persistence.transaction(async (tx) => {
    await tx.execute("DELETE FROM initiative_projects WHERE initiative_id = $1", [id]);
    await tx.execute("DELETE FROM initiative_teams WHERE initiative_id = $1", [id]);
    await tx.execute("DELETE FROM initiatives WHERE id = $1", [id]);
  });
  return true;
}

export async function postgresInitiativeProgress(
  persistence: Persistence,
  initiativeId: string,
): Promise<{ totalIssues: number; completedIssues: number; progress: number }> {
  const row = await persistence.one<{ total: number; done: number | null }>(
    `SELECT count(*)::int AS total,
            COALESCE(sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END), 0)::int AS done
     FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
     WHERE issues.archived_at IS NULL
       AND issues.project_id IN (SELECT project_id FROM initiative_projects WHERE initiative_id = $1)`,
    [initiativeId],
  );
  const totalIssues = Number(row?.total ?? 0);
  const completedIssues = Number(row?.done ?? 0);
  return {
    totalIssues,
    completedIssues,
    progress: totalIssues === 0 ? 0 : completedIssues / totalIssues,
  };
}
