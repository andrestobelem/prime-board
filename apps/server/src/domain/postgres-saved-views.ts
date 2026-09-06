import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { apiError } from "../graphql/errors.ts";
import {
  getPostgresTeam,
  assertPostgresTeamActive,
  canWritePostgresTeam,
} from "./postgres-teams.ts";
import {
  canAccessPostgresProject,
  getPostgresProject,
  listPostgresProjectTeamIds,
} from "./postgres-projects.ts";
import {
  canAccessPostgresInitiative,
  getPostgresInitiative,
  listPostgresInitiativeTeamIds,
} from "./postgres-initiatives.ts";
import { newId, now } from "../db/util.ts";

export type PostgresSavedViewScope = "personal" | "team" | "workspace" | "project" | "initiative";

export interface PostgresSavedViewRow {
  id: string;
  name: string;
  scope: PostgresSavedViewScope;
  team_id: string | null;
  project_id: string | null;
  initiative_id: string | null;
  owner_id: string;
  workspace_id: string;
  filter_json: string;
  order_by: string;
  group_by: string;
  columns_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

const ORDER_BY_VALUES = new Set(["CREATED_ASC", "CREATED_DESC", "UPDATED_ASC", "UPDATED_DESC"]);
const GROUP_BY_VALUES = new Set(["state", "milestone", "assignee", "priority"]);

function parseFilter(filter: unknown): string {
  if (filter === undefined || filter === null) return "{}";
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw apiError("VALIDATION_FAILED", "Saved view filter must be an object");
  }
  return JSON.stringify(filter);
}

function parseColumns(columns: unknown): string {
  if (columns === undefined || columns === null) return "[]";
  if (!Array.isArray(columns) || columns.some((column) => typeof column !== "string")) {
    throw apiError("VALIDATION_FAILED", "Saved view columns must be a string array");
  }
  return JSON.stringify(columns);
}

function resolveScope(scope: string): PostgresSavedViewScope {
  const normalized = scope.toLowerCase();
  if (
    normalized !== "personal" &&
    normalized !== "team" &&
    normalized !== "workspace" &&
    normalized !== "project" &&
    normalized !== "initiative"
  ) {
    throw apiError("VALIDATION_FAILED", `Invalid saved view scope: ${scope}`);
  }
  return normalized;
}

function viewerId(viewer: Pick<ActorRow, "id">): string {
  return viewer.id;
}

export function mapPostgresSavedView(row: PostgresSavedViewRow) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    teamId: row.team_id,
    projectId: row.project_id,
    initiativeId: row.initiative_id,
    ownerId: row.owner_id,
    filter: JSON.parse(row.filter_json) as Record<string, unknown>,
    orderBy: row.order_by,
    groupBy: row.group_by,
    columns: JSON.parse(row.columns_json || "[]") as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    _row: row,
  };
}

export async function getPostgresSavedView(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<PostgresSavedViewRow | null> {
  return persistence.one<PostgresSavedViewRow>("SELECT * FROM saved_views WHERE id = $1", [id]);
}

export async function canAccessPostgresSavedView(
  persistence: Persistence,
  row: PostgresSavedViewRow,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
): Promise<boolean> {
  if (row.scope === "personal") return row.owner_id === viewer.id;
  if (row.scope === "workspace") return true;
  if (row.scope === "team") {
    if (!row.team_id) return false;
    const team = await getPostgresTeam(persistence, { id: row.team_id });
    if (!team) return false;
    return canWritePostgresTeam(persistence, viewer, row.team_id);
  }
  if (row.scope === "project") {
    return Boolean(
      row.project_id &&
      (await getPostgresProject(persistence, row.project_id)) &&
      (await canAccessPostgresProject(persistence, viewer, row.project_id)),
    );
  }
  return Boolean(
    row.initiative_id &&
    (await getPostgresInitiative(persistence, row.initiative_id)) &&
    (await canAccessPostgresInitiative(persistence, viewer, row.initiative_id)),
  );
}

export async function listPostgresSavedViews(
  persistence: Persistence,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  teamId?: string | null,
  includeArchived = false,
): Promise<PostgresSavedViewRow[]> {
  const rows = await persistence.many<PostgresSavedViewRow>(
    "SELECT * FROM saved_views ORDER BY created_at, id",
  );
  const result: PostgresSavedViewRow[] = [];
  for (const row of rows) {
    if (!includeArchived && row.archived_at) continue;
    if (!includeArchived && row.team_id) {
      const team = await getPostgresTeam(persistence, { id: row.team_id });
      if (team?.archived_at) continue;
    }
    if (!(await canAccessPostgresSavedView(persistence, row, viewer))) continue;
    if (teamId) {
      if (row.scope === "team" && row.team_id !== teamId) continue;
      if (row.scope === "project" && row.project_id) {
        const teamIds = await listPostgresProjectTeamIds(persistence, row.project_id);
        if (!teamIds.includes(teamId)) continue;
      }
      if (row.scope === "initiative" && row.initiative_id) {
        const teamIds = await listPostgresInitiativeTeamIds(persistence, row.initiative_id);
        if (!teamIds.includes(teamId)) continue;
      }
    }
    result.push(row);
  }
  return result;
}

async function validateTeamScope(
  persistence: Persistence,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  scope: PostgresSavedViewScope,
  teamId: string | null,
): Promise<string | null> {
  if (scope !== "team") return null;
  if (!teamId) throw apiError("VALIDATION_FAILED", "Team saved views require teamId");
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  await assertPostgresTeamActive(persistence, teamId);
  if (!(await canWritePostgresTeam(persistence, viewer, teamId))) {
    throw apiError("UNAUTHORIZED", "Team access policy does not allow this operation");
  }
  return teamId;
}

async function validateScope(
  persistence: Persistence,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  scope: PostgresSavedViewScope,
  teamId: string | null,
  projectId: string | null,
  initiativeId: string | null,
): Promise<{ teamId: string | null; projectId: string | null; initiativeId: string | null }> {
  if (scope === "team") {
    return {
      teamId: await validateTeamScope(persistence, viewer, scope, teamId),
      projectId: null,
      initiativeId: null,
    };
  }
  if (scope === "project") {
    if (!projectId) throw apiError("VALIDATION_FAILED", "Project saved views require projectId");
    const project = await getPostgresProject(persistence, projectId);
    if (!project || !(await canAccessPostgresProject(persistence, viewer, projectId))) {
      throw apiError("NOT_FOUND", "Project not found");
    }
    if (viewer.workspace_role !== "admin") {
      const teamIds = await listPostgresProjectTeamIds(persistence, projectId);
      for (const destination of teamIds) {
        if (!(await canWritePostgresTeam(persistence, viewer, destination))) {
          throw apiError("UNAUTHORIZED", "Project access policy does not allow this operation");
        }
      }
    }
    return { teamId: null, projectId, initiativeId: null };
  }
  if (scope === "initiative") {
    if (!initiativeId)
      throw apiError("VALIDATION_FAILED", "Initiative saved views require initiativeId");
    const initiative = await getPostgresInitiative(persistence, initiativeId);
    if (
      !initiative ||
      !(await canAccessPostgresInitiative(persistence, viewer, initiativeId)) ||
      (initiative.owner_id &&
        initiative.owner_id !== viewer.id &&
        viewer.workspace_role !== "admin")
    ) {
      throw apiError("NOT_FOUND", "Initiative not found");
    }
    return { teamId: null, projectId: null, initiativeId };
  }
  return { teamId: null, projectId: null, initiativeId: null };
}

export async function createPostgresSavedView(
  persistence: Persistence,
  owner: Pick<ActorRow, "id" | "workspace_role">,
  input: {
    name: string;
    scope: string;
    teamId?: string | null;
    projectId?: string | null;
    initiativeId?: string | null;
    filter?: unknown;
    orderBy?: string | null;
    groupBy?: string | null;
    columns?: string[] | null;
  },
): Promise<PostgresSavedViewRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Saved view name cannot be empty");
  const scope = resolveScope(input.scope);
  const targets = await validateScope(
    persistence,
    owner,
    scope,
    input.teamId ?? null,
    input.projectId ?? null,
    input.initiativeId ?? null,
  );
  const workspace = await persistence.one<{ id: string }>(
    "SELECT id FROM workspace ORDER BY created_at, id LIMIT 1",
  );
  if (!workspace) throw apiError("NOT_FOUND", "Workspace not found");
  const orderBy = input.orderBy ?? "CREATED_DESC";
  if (!ORDER_BY_VALUES.has(orderBy)) {
    throw apiError("VALIDATION_FAILED", `Invalid orderBy: ${orderBy}`);
  }
  const groupBy = input.groupBy ?? "state";
  if (!GROUP_BY_VALUES.has(groupBy)) {
    throw apiError("VALIDATION_FAILED", `Invalid groupBy: ${groupBy}`);
  }
  const id = newId();
  const timestamp = now();
  await persistence.execute(
    `INSERT INTO saved_views
     (id, name, scope, team_id, project_id, initiative_id, owner_id, workspace_id, filter_json, order_by, group_by, columns_json, created_at, updated_at, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, NULL)`,
    [
      id,
      name,
      scope,
      targets.teamId,
      targets.projectId,
      targets.initiativeId,
      viewerId(owner),
      workspace.id,
      parseFilter(input.filter),
      orderBy,
      groupBy,
      parseColumns(input.columns),
      timestamp,
    ],
  );
  const row = await getPostgresSavedView(persistence, id);
  if (!row) throw new Error("PostgreSQL saved view insert returned no row");
  return row;
}

export async function updatePostgresSavedView(
  persistence: Persistence,
  id: string,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  input: {
    name?: string | null;
    filter?: unknown;
    orderBy?: string | null;
    groupBy?: string | null;
    columns?: string[] | null;
    archived?: boolean | null;
  },
): Promise<PostgresSavedViewRow> {
  const existing = await getPostgresSavedView(persistence, id);
  if (!existing || !(await canAccessPostgresSavedView(persistence, existing, viewer))) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }
  if (existing.scope === "personal" && existing.owner_id !== viewer.id) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }
  await validateScope(
    persistence,
    viewer,
    existing.scope,
    existing.team_id,
    existing.project_id,
    existing.initiative_id,
  );

  const sets: string[] = [];
  const params: SqlValue[] = [];
  const push = (column: string, value: SqlValue) => {
    sets.push(`${column} = $${params.length + 1}`);
    params.push(value);
  };
  if (input.name !== undefined && input.name !== null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Saved view name cannot be empty");
    push("name", name);
  }
  if (input.filter !== undefined) push("filter_json", parseFilter(input.filter));
  if (input.orderBy != null) {
    if (!ORDER_BY_VALUES.has(input.orderBy)) {
      throw apiError("VALIDATION_FAILED", `Invalid orderBy: ${input.orderBy}`);
    }
    push("order_by", input.orderBy);
  }
  if (input.groupBy != null) {
    if (!GROUP_BY_VALUES.has(input.groupBy)) {
      throw apiError("VALIDATION_FAILED", `Invalid groupBy: ${input.groupBy}`);
    }
    push("group_by", input.groupBy);
  }
  if (input.columns !== undefined) push("columns_json", parseColumns(input.columns));
  if (input.archived === true) push("archived_at", now());
  if (input.archived === false) push("archived_at", null);
  if (sets.length > 0) {
    push("updated_at", now());
    params.push(id);
    await persistence.execute(
      `UPDATE saved_views SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params,
    );
  }
  const row = await getPostgresSavedView(persistence, id);
  if (!row) throw apiError("NOT_FOUND", "Saved view not found");
  return row;
}

export async function duplicatePostgresSavedView(
  persistence: Persistence,
  id: string,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
): Promise<PostgresSavedViewRow> {
  const existing = await getPostgresSavedView(persistence, id);
  if (!existing || !(await canAccessPostgresSavedView(persistence, existing, viewer))) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }
  return createPostgresSavedView(persistence, viewer, {
    name: `${existing.name} (copy)`,
    scope: existing.scope,
    teamId: existing.team_id,
    projectId: existing.project_id,
    initiativeId: existing.initiative_id,
    filter: JSON.parse(existing.filter_json),
    orderBy: existing.order_by,
    groupBy: existing.group_by,
    columns: JSON.parse(existing.columns_json || "[]"),
  });
}

export async function deletePostgresSavedView(
  persistence: Persistence,
  id: string,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
): Promise<boolean> {
  const existing = await getPostgresSavedView(persistence, id);
  if (!existing || !(await canAccessPostgresSavedView(persistence, existing, viewer))) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }
  if (existing.scope === "personal" && existing.owner_id !== viewer.id) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }
  await validateScope(
    persistence,
    viewer,
    existing.scope,
    existing.team_id,
    existing.project_id,
    existing.initiative_id,
  );
  await persistence.execute("DELETE FROM saved_views WHERE id = $1", [id]);
  return true;
}
