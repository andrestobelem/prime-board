import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { parseDateTime } from "./datetime.ts";
import {
  assertCanManagePostgresProject,
  assertPostgresWorkspace,
  canAccessPostgresProject,
  listPostgresProjectTeamIds,
  lockPostgresProjectScope,
  lockPostgresTeamIds,
  readPostgresAuthScope,
} from "./postgres-projects.ts";
import {
  assertPostgresTeamActive,
  canWritePostgresTeam,
  getPostgresTeam,
  isPostgresTeamMember,
} from "./postgres-teams.ts";
import type { ActorRow, AuthScopeContext } from "../auth/viewer.ts";
import type { InitiativeState } from "./initiatives.ts";

function parseResources(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface PostgresInitiativeRow {
  id: string;
  name: string;
  description: string | null;
  state: InitiativeState;
  priority: number;
  target_date: string | null;
  lead_team_id: string | null;
  resources_json: string;
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
    priority: row.priority,
    targetDate: row.target_date,
    leadTeamId: row.lead_team_id,
    resources: parseResources(row.resources_json),
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export async function getPostgresInitiative(
  persistence: Persistence | PersistenceTransaction,
  id: string,
  workspaceId?: string,
): Promise<PostgresInitiativeRow | null> {
  if (workspaceId !== undefined) await assertPostgresWorkspace(persistence, workspaceId);
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

export async function listPostgresInitiativeLabelIds(
  persistence: Persistence | PersistenceTransaction,
  initiativeId: string,
): Promise<string[]> {
  const rows = await persistence.many<{ label_id: string }>(
    "SELECT label_id FROM initiative_labels WHERE initiative_id = $1 ORDER BY label_id",
    [initiativeId],
  );
  return rows.map((row) => row.label_id);
}

export async function listPostgresInitiativeUpdates(
  persistence: Persistence | PersistenceTransaction,
  initiativeId: string,
): Promise<readonly Record<string, unknown>[]> {
  return persistence.many(
    "SELECT * FROM initiative_updates WHERE initiative_id = $1 ORDER BY created_at DESC, id DESC",
    [initiativeId],
  );
}

async function validateInitiativeLabels(
  persistence: Persistence | PersistenceTransaction,
  labelIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(labelIds)];
  for (const labelId of unique) {
    if (!(await persistence.one("SELECT id FROM labels WHERE id = $1", [labelId])))
      throw apiError("NOT_FOUND", `Initiative label not found: ${labelId}`);
  }
  return unique;
}

function validateInitiativePriority(priority: number | null | undefined): void {
  if (
    priority !== undefined &&
    priority !== null &&
    (!Number.isInteger(priority) || priority < 0 || priority > 4)
  )
    throw apiError("VALIDATION_FAILED", "Initiative priority must be an integer between 0 and 4");
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

/**
 * Bloquea una Initiative, sus relaciones, Projects y Teams antes de autorizar
 * un status update. Las mutaciones de relaciones bloquean primero la raíz.
 */
async function lockPostgresInitiativeScope(
  tx: PersistenceTransaction,
  initiativeId: string,
  workspaceId?: string,
): Promise<{ initiative: PostgresInitiativeRow; teamIds: string[] }> {
  await assertPostgresWorkspace(tx, workspaceId);
  const initiative = await tx.one<PostgresInitiativeRow>(
    "SELECT * FROM initiatives WHERE id = $1 FOR UPDATE",
    [initiativeId],
  );
  if (!initiative) throw apiError("NOT_FOUND", "Initiative not found");

  const directRows = await tx.many<{ team_id: string }>(
    "SELECT team_id FROM initiative_teams WHERE initiative_id = $1 ORDER BY team_id FOR UPDATE",
    [initiativeId],
  );
  const projectRows = await tx.many<{ project_id: string }>(
    "SELECT project_id FROM initiative_projects WHERE initiative_id = $1 ORDER BY project_id FOR UPDATE",
    [initiativeId],
  );
  const directTeamIds = directRows.map((row) => row.team_id);
  const projectTeamIds = await lockPostgresProjectScope(
    tx,
    projectRows.map((row) => row.project_id),
  );
  await lockPostgresTeamIds(tx, directTeamIds);
  return {
    initiative,
    teamIds: [...new Set([...directTeamIds, ...projectTeamIds])].sort(),
  };
}

function assertPostgresInitiativeTeamLimit(
  auth: AuthScopeContext | null | undefined,
  teamIds: readonly string[],
): void {
  if (!auth?.teamIds) return;
  const allowed = new Set(auth.teamIds);
  if (teamIds.length === 0 || teamIds.some((teamId) => !allowed.has(teamId))) {
    throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
  }
}

export async function canAccessPostgresInitiative(
  persistence: Persistence | PersistenceTransaction,
  viewer: ActorRow,
  initiativeId: string,
  workspaceId?: string,
): Promise<boolean> {
  if (workspaceId !== undefined) await assertPostgresWorkspace(persistence, workspaceId);
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
  persistence: Persistence | PersistenceTransaction,
  viewer: ActorRow,
  initiative: PostgresInitiativeRow,
  workspaceId?: string,
): Promise<void> {
  if (!(await canAccessPostgresInitiative(persistence, viewer, initiative.id, workspaceId))) {
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
    priority?: number | null;
    targetDate?: string | null;
    leadTeamId?: string | null;
    labelIds?: readonly string[] | null;
    resources?: readonly unknown[] | null;
    projectIds?: readonly string[] | null;
    teamIds?: readonly string[] | null;
  },
): Promise<PostgresInitiativeRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Initiative name cannot be empty");
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  validateInitiativePriority(input.priority);
  const labelIds = await validateInitiativeLabels(persistence, input.labelIds ?? []);
  if (input.leadTeamId != null) await assertPostgresTeamActive(persistence, input.leadTeamId);
  const projectIds = await validateProjectIds(persistence, viewer, input.projectIds ?? []);
  const teamIds = await validateTeamIds(persistence, viewer, input.teamIds ?? []);
  const id = newId();
  const timestamp = now();
  await persistence.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO initiatives
       (id, name, description, state, priority, target_date, lead_team_id, resources_json, owner_id, created_at, updated_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, NULL)`,
      [
        id,
        name,
        input.description ?? null,
        input.state ? resolveState(input.state) : "planned",
        input.priority ?? 0,
        input.targetDate ?? null,
        input.leadTeamId ?? null,
        JSON.stringify(input.resources ?? []),
        viewer.id,
        timestamp,
      ],
    );
    await replaceRelations(tx, id, projectIds, teamIds);
    for (const labelId of labelIds)
      await tx.execute("INSERT INTO initiative_labels (initiative_id, label_id) VALUES ($1, $2)", [
        id,
        labelId,
      ]);
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
    priority?: number | null;
    targetDate?: string | null;
    leadTeamId?: string | null;
    labelIds?: readonly string[] | null;
    resources?: readonly unknown[] | null;
    projectIds?: readonly string[] | null;
    teamIds?: readonly string[] | null;
    archived?: boolean | null;
  },
): Promise<PostgresInitiativeRow> {
  const existing = await getPostgresInitiative(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "Initiative not found");
  await assertCanMutatePostgresInitiative(persistence, viewer, existing);
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  validateInitiativePriority(input.priority);
  const labelIds =
    input.labelIds === undefined || input.labelIds === null
      ? null
      : await validateInitiativeLabels(persistence, input.labelIds);
  if (input.leadTeamId !== undefined && input.leadTeamId !== null)
    await assertPostgresTeamActive(persistence, input.leadTeamId);
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
  if (input.priority !== undefined && input.priority !== null) push("priority", input.priority);
  if (input.targetDate !== undefined) push("target_date", input.targetDate);
  if (input.leadTeamId !== undefined) push("lead_team_id", input.leadTeamId);
  if (input.resources !== undefined) push("resources_json", JSON.stringify(input.resources ?? []));
  if (input.archived === true) push("archived_at", now());
  if (input.archived === false) push("archived_at", null);
  const relationsChanged =
    (input.projectIds !== undefined && input.projectIds !== null) ||
    (input.teamIds !== undefined && input.teamIds !== null) ||
    labelIds !== null;
  await persistence.transaction(async (tx) => {
    // Status transactions lock this root before reading initiative relations.
    const locked = await tx.one<{ id: string }>(
      "SELECT id FROM initiatives WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!locked) throw apiError("NOT_FOUND", "Initiative not found");
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
      if (relationsChanged) {
        if (
          (input.projectIds !== undefined && input.projectIds !== null) ||
          (input.teamIds !== undefined && input.teamIds !== null)
        )
          await replaceRelations(tx, id, projectIds, teamIds);
        if (labelIds !== null) {
          await tx.execute("DELETE FROM initiative_labels WHERE initiative_id = $1", [id]);
          for (const labelId of labelIds)
            await tx.execute(
              "INSERT INTO initiative_labels (initiative_id, label_id) VALUES ($1, $2)",
              [id, labelId],
            );
        }
      }
    }
  });
  return (await getPostgresInitiative(persistence, id))!;
}

export interface PostgresInitiativeUpdateRow {
  id: string;
  initiative_id: string;
  author_id: string;
  health: "on_track" | "at_risk" | "off_track";
  body: string;
  created_at: string;
  updated_at: string;
}

export async function createPostgresInitiativeUpdate(
  persistence: Persistence,
  viewer: ActorRow,
  initiativeId: string,
  input: { health: string; body: string },
  workspaceId?: string,
  auth?: AuthScopeContext | null,
): Promise<PostgresInitiativeUpdateRow> {
  return persistence.transaction(async (tx) => {
    await assertPostgresWorkspace(tx, workspaceId);
    const effectiveAuth = await readPostgresAuthScope(tx, auth, workspaceId);
    const { initiative, teamIds } = await lockPostgresInitiativeScope(
      tx,
      initiativeId,
      workspaceId,
    );
    await assertCanMutatePostgresInitiative(tx, viewer, initiative, workspaceId);
    assertPostgresInitiativeTeamLimit(effectiveAuth, teamIds);
    const health = input.health.toLowerCase();
    const allowedHealth = ["on_track", "at_risk", "off_track"];
    if (!allowedHealth.includes(health))
      throw apiError("VALIDATION_FAILED", "Invalid initiative update health");
    const body = input.body.trim();
    if (!body) throw apiError("VALIDATION_FAILED", "Initiative update body cannot be empty");
    const timestamp = now();
    const row = await tx.one<PostgresInitiativeUpdateRow>(
      "INSERT INTO initiative_updates (id, initiative_id, author_id, health, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *",
      [newId(), initiative.id, viewer.id, health, body, timestamp],
    );
    if (!row) throw new Error("PostgreSQL initiative update insert returned no row");
    return row;
  });
}

export async function getPostgresInitiativeUpdate(
  persistence: Persistence | PersistenceTransaction,
  id: string,
  workspaceId?: string,
): Promise<PostgresInitiativeUpdateRow | null> {
  await assertPostgresWorkspace(persistence, workspaceId);
  return persistence.one<PostgresInitiativeUpdateRow>(
    "SELECT * FROM initiative_updates WHERE id = $1",
    [id],
  );
}

export async function deletePostgresInitiativeUpdate(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  workspaceId?: string,
  auth?: AuthScopeContext | null,
): Promise<boolean> {
  return persistence.transaction(async (tx) => {
    await assertPostgresWorkspace(tx, workspaceId);
    const effectiveAuth = await readPostgresAuthScope(tx, auth, workspaceId);
    const row = await tx.one<PostgresInitiativeUpdateRow>(
      "SELECT * FROM initiative_updates WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!row) throw apiError("NOT_FOUND", "Initiative update not found");
    const { initiative, teamIds } = await lockPostgresInitiativeScope(
      tx,
      row.initiative_id,
      workspaceId,
    );
    await assertCanMutatePostgresInitiative(tx, viewer, initiative, workspaceId);
    assertPostgresInitiativeTeamLimit(effectiveAuth, teamIds);
    const result = await tx.execute<PostgresInitiativeUpdateRow>(
      "DELETE FROM initiative_updates WHERE id = $1 RETURNING *",
      [id],
    );
    if (result.rowCount !== 1) throw apiError("NOT_FOUND", "Initiative update not found");
    return true;
  });
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
