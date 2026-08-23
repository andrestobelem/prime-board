// Lecturas de planificación usadas por resolvers anidados de Documents en PostgreSQL.
import type { Persistence } from "../db/persistence.ts";

export interface PostgresProjectRow {
  id: string;
  name: string;
  description: string | null;
  state: string;
  lead_id: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface PostgresInitiativeRow {
  id: string;
  name: string;
  description: string | null;
  state: string;
  target_date: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface PostgresCycleRow {
  id: string;
  team_id: string;
  number: number;
  name: string;
  starts_at: string;
  ends_at: string;
  state: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
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

export function mapPostgresCycle(row: PostgresCycleRow) {
  return {
    id: row.id,
    teamId: row.team_id,
    number: row.number,
    name: row.name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export async function getPostgresProject(
  persistence: Persistence,
  id: string,
): Promise<PostgresProjectRow | null> {
  return persistence.one<PostgresProjectRow>("SELECT * FROM projects WHERE id = $1", [id]);
}

export async function listPostgresProjectTeamIds(
  persistence: Persistence,
  projectId: string,
): Promise<string[]> {
  const rows = await persistence.many<{ team_id: string }>(
    "SELECT team_id FROM project_teams WHERE project_id = $1 ORDER BY team_id",
    [projectId],
  );
  return rows.map((row) => row.team_id);
}

export async function listPostgresProjectMilestones(
  persistence: Persistence,
  projectId: string,
): Promise<Array<Record<string, unknown>>> {
  return [
    ...(await persistence.many<Record<string, unknown>>(
      "SELECT * FROM milestones WHERE project_id = $1 ORDER BY position, id",
      [projectId],
    )),
  ];
}

export async function listPostgresProjectUpdates(
  persistence: Persistence,
  projectId: string,
): Promise<Array<Record<string, unknown>>> {
  return [
    ...(await persistence.many<Record<string, unknown>>(
      "SELECT * FROM project_updates WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId],
    )),
  ];
}

export async function getPostgresInitiative(
  persistence: Persistence,
  id: string,
): Promise<PostgresInitiativeRow | null> {
  return persistence.one<PostgresInitiativeRow>("SELECT * FROM initiatives WHERE id = $1", [id]);
}

export async function listPostgresInitiativeProjectIds(
  persistence: Persistence,
  initiativeId: string,
): Promise<string[]> {
  const rows = await persistence.many<{ project_id: string }>(
    "SELECT project_id FROM initiative_projects WHERE initiative_id = $1 ORDER BY project_id",
    [initiativeId],
  );
  return rows.map((row) => row.project_id);
}

export async function listPostgresInitiativeTeamIds(
  persistence: Persistence,
  initiativeId: string,
): Promise<string[]> {
  const direct = await persistence.many<{ team_id: string }>(
    "SELECT team_id FROM initiative_teams WHERE initiative_id = $1 ORDER BY team_id",
    [initiativeId],
  );
  const projects = await listPostgresInitiativeProjectIds(persistence, initiativeId);
  const projectTeams: string[] = [];
  for (const projectId of projects) {
    projectTeams.push(...(await listPostgresProjectTeamIds(persistence, projectId)));
  }
  return [...new Set([...direct.map((row) => row.team_id), ...projectTeams])].sort();
}

export async function getPostgresCycle(
  persistence: Persistence,
  id: string,
): Promise<PostgresCycleRow | null> {
  return persistence.one<PostgresCycleRow>("SELECT * FROM cycles WHERE id = $1", [id]);
}

export async function postgresCycleProgress(
  persistence: Persistence,
  cycleId: string,
): Promise<{ totalIssues: number; completedIssues: number; progress: number }> {
  const row = await persistence.one<{ total: number; done: number | null }>(
    `SELECT count(*)::int AS total,
            coalesce(sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END), 0)::int AS done
     FROM issues
     JOIN workflow_states ON workflow_states.id = issues.state_id
     WHERE issues.cycle_id = $1 AND issues.archived_at IS NULL`,
    [cycleId],
  );
  const totalIssues = Number(row?.total ?? 0);
  const completedIssues = Number(row?.done ?? 0);
  return {
    totalIssues,
    completedIssues,
    progress: totalIssues ? completedIssues / totalIssues : 0,
  };
}

export async function postgresInitiativeProgress(
  persistence: Persistence,
  initiativeId: string,
): Promise<{ totalIssues: number; completedIssues: number; progress: number }> {
  const row = await persistence.one<{ total: number; done: number | null }>(
    `SELECT count(*)::int AS total,
            coalesce(sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END), 0)::int AS done
     FROM issues
     JOIN workflow_states ON workflow_states.id = issues.state_id
     WHERE issues.archived_at IS NULL
       AND issues.project_id IN (
         SELECT project_id FROM initiative_projects WHERE initiative_id = $1
       )`,
    [initiativeId],
  );
  const totalIssues = Number(row?.total ?? 0);
  const completedIssues = Number(row?.done ?? 0);
  return {
    totalIssues,
    completedIssues,
    progress: totalIssues ? completedIssues / totalIssues : 0,
  };
}
