import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { apiError } from "../graphql/errors.ts";
import {
  getPostgresTeam,
  assertPostgresTeamActive,
  canWritePostgresTeam,
} from "./postgres-teams.ts";
import { newId, now } from "../db/util.ts";

export type PostgresSavedViewScope = "personal" | "team" | "workspace";

export interface PostgresSavedViewRow {
  id: string;
  name: string;
  scope: PostgresSavedViewScope;
  team_id: string | null;
  owner_id: string;
  filter_json: string;
  order_by: string;
  group_by: string;
  columns_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

const ORDER_BY_VALUES = new Set([
  "CREATED_ASC",
  "CREATED_DESC",
  "UPDATED_ASC",
  "UPDATED_DESC",
  "DUE_DATE_ASC",
  "DUE_DATE_DESC",
  "STARTED_AT_ASC",
  "STARTED_AT_DESC",
  "COMPLETED_AT_ASC",
  "COMPLETED_AT_DESC",
  "CANCELED_AT_ASC",
  "CANCELED_AT_DESC",
]);
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
  if (normalized !== "personal" && normalized !== "team" && normalized !== "workspace") {
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
  if (!row.team_id) return false;
  const team = await getPostgresTeam(persistence, { id: row.team_id });
  if (!team) return false;
  return canWritePostgresTeam(persistence, viewer, row.team_id);
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
    if (teamId && row.scope === "team" && row.team_id !== teamId) continue;
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

export async function createPostgresSavedView(
  persistence: Persistence,
  owner: Pick<ActorRow, "id" | "workspace_role">,
  input: {
    name: string;
    scope: string;
    teamId?: string | null;
    filter?: unknown;
    orderBy?: string | null;
    groupBy?: string | null;
    columns?: string[] | null;
  },
): Promise<PostgresSavedViewRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Saved view name cannot be empty");
  const scope = resolveScope(input.scope);
  const teamId = await validateTeamScope(persistence, owner, scope, input.teamId ?? null);
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
     (id, name, scope, team_id, owner_id, filter_json, order_by, group_by, columns_json, created_at, updated_at, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, NULL)`,
    [
      id,
      name,
      scope,
      teamId,
      viewerId(owner),
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
  if (existing.scope === "team" && existing.team_id) {
    await validateTeamScope(persistence, viewer, existing.scope, existing.team_id);
  }

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
  if (existing.scope === "team" && existing.team_id) {
    await validateTeamScope(persistence, viewer, existing.scope, existing.team_id);
  }
  await persistence.execute("DELETE FROM saved_views WHERE id = $1", [id]);
  return true;
}
