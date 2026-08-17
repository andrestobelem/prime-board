// Vistas guardadas: filtros/orden/agrupación/columnas reutilizables (PRB-201/208).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";

export type SavedViewScope = "personal" | "team" | "workspace";

export interface SavedViewRow {
  id: string;
  name: string;
  scope: SavedViewScope;
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

const ORDER_BY_VALUES = new Set(["CREATED_ASC", "CREATED_DESC", "UPDATED_ASC", "UPDATED_DESC"]);

const GROUP_BY_VALUES = new Set(["state", "milestone", "assignee", "priority"]);

function parseColumns(columns: unknown): string {
  if (columns === undefined || columns === null) return "[]";
  if (!Array.isArray(columns) || columns.some((c) => typeof c !== "string")) {
    throw apiError("VALIDATION_FAILED", "Saved view columns must be a string array");
  }
  return JSON.stringify(columns);
}

export function mapSavedView(row: SavedViewRow) {
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

export function getSavedView(db: Database, id: string): SavedViewRow | null {
  return db.query("SELECT * FROM saved_views WHERE id = ?1").get(id) as SavedViewRow | null;
}

export function canViewSavedView(row: SavedViewRow, viewerId: string): boolean {
  if (row.scope === "personal") return row.owner_id === viewerId;
  return true;
}

const canSee = canViewSavedView;

export function listSavedViews(
  db: Database,
  viewerId: string,
  teamId?: string | null,
  includeArchived = false,
): SavedViewRow[] {
  const rows = db.query("SELECT * FROM saved_views ORDER BY created_at").all() as SavedViewRow[];
  return rows.filter((row) => {
    if (!includeArchived && row.archived_at) return false;
    if (!canSee(row, viewerId)) return false;
    if (teamId) {
      if (row.scope === "team") return row.team_id === teamId;
      return row.scope === "workspace" || row.scope === "personal";
    }
    return true;
  });
}

function parseFilter(filter: unknown): string {
  if (filter === undefined || filter === null) return "{}";
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw apiError("VALIDATION_FAILED", "Saved view filter must be an object");
  }
  return JSON.stringify(filter);
}

function resolveScope(scope: string): SavedViewScope {
  const normalized = scope.toLowerCase() as SavedViewScope;
  if (normalized !== "personal" && normalized !== "team" && normalized !== "workspace") {
    throw apiError("VALIDATION_FAILED", `Invalid saved view scope: ${scope}`);
  }
  return normalized;
}

export function createSavedView(
  db: Database,
  ownerId: string,
  input: {
    name: string;
    scope: string;
    teamId?: string | null;
    filter?: unknown;
    orderBy?: string | null;
    groupBy?: string | null;
    columns?: string[] | null;
  },
): SavedViewRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Saved view name cannot be empty");
  const scope = resolveScope(input.scope);
  let teamId: string | null = input.teamId ?? null;
  if (scope === "team") {
    if (!teamId) throw apiError("VALIDATION_FAILED", "Team saved views require teamId");
    if (!db.query("SELECT id FROM teams WHERE id = ?1").get(teamId)) {
      throw apiError("NOT_FOUND", "Team not found");
    }
  } else {
    teamId = null;
  }

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
  db.query(
    `INSERT INTO saved_views
      (id, name, scope, team_id, owner_id, filter_json, order_by, group_by, columns_json, created_at, updated_at, archived_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, NULL)`,
  ).run(
    id,
    name,
    scope,
    teamId,
    ownerId,
    parseFilter(input.filter),
    orderBy,
    groupBy,
    parseColumns(input.columns),
    timestamp,
  );
  return getSavedView(db, id)!;
}

export function updateSavedView(
  db: Database,
  id: string,
  viewerId: string,
  input: {
    name?: string | null;
    filter?: unknown;
    orderBy?: string | null;
    groupBy?: string | null;
    columns?: string[] | null;
    archived?: boolean | null;
  },
): SavedViewRow {
  const existing = getSavedView(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Saved view not found");
  if (!canSee(existing, viewerId)) throw apiError("NOT_FOUND", "Saved view not found");
  if (existing.scope === "personal" && existing.owner_id !== viewerId) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
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
    db.query(`UPDATE saved_views SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
      ...(params as never[]),
    );
  }
  return getSavedView(db, id)!;
}

export function duplicateSavedView(db: Database, id: string, viewerId: string): SavedViewRow {
  const existing = getSavedView(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Saved view not found");
  if (!canSee(existing, viewerId)) throw apiError("NOT_FOUND", "Saved view not found");
  return createSavedView(db, viewerId, {
    name: `${existing.name} (copy)`,
    scope: existing.scope,
    teamId: existing.team_id,
    filter: JSON.parse(existing.filter_json),
    orderBy: existing.order_by,
    groupBy: existing.group_by,
    columns: JSON.parse(existing.columns_json || "[]"),
  });
}

export function deleteSavedView(db: Database, id: string, viewerId: string): boolean {
  const existing = getSavedView(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Saved view not found");
  if (!canSee(existing, viewerId)) throw apiError("NOT_FOUND", "Saved view not found");
  if (existing.scope === "personal" && existing.owner_id !== viewerId) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }
  db.query("DELETE FROM saved_views WHERE id = ?1").run(id);
  return true;
}
