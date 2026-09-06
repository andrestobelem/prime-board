// Vistas guardadas: filtros/orden/agrupación/columnas reutilizables (PRB-201/208).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import type { ActorRow } from "../auth/viewer.ts";
import {
  assertCanManageProject,
  canAccessProject,
  canWriteTeam,
  isWorkspaceAdmin,
} from "../auth/permissions.ts";
import { getInitiative, canViewInitiative, listInitiativeTeamIds } from "./initiatives.ts";
import { getProject, listProjectTeamIds } from "./projects.ts";
import { newId, now } from "../db/util.ts";

export type SavedViewScope = "personal" | "team" | "workspace" | "project" | "initiative";

export interface SavedViewRow {
  id: string;
  name: string;
  scope: SavedViewScope;
  team_id: string | null;
  project_id: string | null;
  initiative_id: string | null;
  owner_id: string;
  filter_json: string;
  order_by: string;
  group_by: string;
  columns_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  workspace_id: string | null;
}

type ViewerRef = string | ActorRow;

/** Las filas legacy con NULL solo son visibles con un único Workspace. */
function workspaceClause(column: string, parameter: string): string {
  return `(${column} = ${parameter} OR (${column} IS NULL AND (SELECT count(*) FROM workspace) = 1))`;
}

function resolveViewer(db: Database, viewer: ViewerRef): ActorRow | null {
  if (typeof viewer !== "string") return viewer;
  return db.query("SELECT * FROM actors WHERE id = ?1").get(viewer) as ActorRow | null;
}

function viewerId(viewer: ViewerRef): string {
  return typeof viewer === "string" ? viewer : viewer.id;
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

export function getSavedView(db: Database, id: string, workspaceId?: string): SavedViewRow | null {
  const query = workspaceId
    ? `SELECT * FROM saved_views WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT * FROM saved_views WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as SavedViewRow | null;
}

export function canViewSavedView(row: SavedViewRow, viewer: ViewerRef): boolean {
  if (row.scope === "personal") return row.owner_id === viewerId(viewer);
  return true;
}

/** ACL completa: las vistas TEAM requieren membership vigente; admins bypass. */
export function canAccessSavedView(
  db: Database,
  row: SavedViewRow,
  viewer: ViewerRef,
  workspaceId?: string,
): boolean {
  if (!canViewSavedView(row, viewer)) return false;
  const actor = resolveViewer(db, viewer);
  if (!actor) return false;
  const effectiveWorkspaceId = workspaceId ?? row.workspace_id;
  if (row.scope === "team") {
    if (!row.team_id) return false;
    // La referencia al Team forma parte del límite del Workspace.
    const team = effectiveWorkspaceId
      ? db
          .query(`SELECT id FROM teams WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`)
          .get(row.team_id, effectiveWorkspaceId)
      : db.query("SELECT id FROM teams WHERE id = ?1").get(row.team_id);
    return Boolean(team && canWriteTeam(db, actor, row.team_id));
  }
  if (row.scope === "project") {
    return Boolean(
      row.project_id &&
      getProject(db, row.project_id, effectiveWorkspaceId ?? undefined) &&
      canAccessProject(db, actor, row.project_id, effectiveWorkspaceId ?? undefined),
    );
  }
  if (row.scope === "initiative") {
    return Boolean(
      row.initiative_id &&
      getInitiative(db, row.initiative_id, effectiveWorkspaceId ?? undefined) &&
      canViewInitiative(db, row.initiative_id, actor, effectiveWorkspaceId ?? undefined),
    );
  }
  return true;
}

function assertCanMutateSavedView(
  db: Database,
  row: SavedViewRow,
  viewer: ViewerRef,
  workspaceId?: string,
): void {
  const actor = resolveViewer(db, viewer);
  if (!actor) throw apiError("NOT_FOUND", "Saved view not found");
  const effectiveWorkspaceId = workspaceId ?? row.workspace_id;
  if (row.scope === "team" && row.team_id && !canWriteTeam(db, actor, row.team_id)) {
    throw apiError("UNAUTHORIZED", "Team access policy does not allow this operation");
  }
  if (row.scope === "project" && row.project_id) {
    assertCanManageProject(db, actor, row.project_id, effectiveWorkspaceId ?? undefined);
  }
  if (row.scope === "initiative" && row.initiative_id) {
    const initiative = getInitiative(db, row.initiative_id, effectiveWorkspaceId ?? undefined);
    if (
      !initiative ||
      !canViewInitiative(db, row.initiative_id, actor, effectiveWorkspaceId ?? undefined) ||
      (initiative.owner_id && initiative.owner_id !== actor.id && !isWorkspaceAdmin(actor))
    ) {
      throw apiError("NOT_FOUND", "Saved view not found");
    }
  }
}

export function listSavedViews(
  db: Database,
  viewer: ViewerRef,
  teamId?: string | null,
  includeArchived = false,
  workspaceId?: string,
): SavedViewRow[] {
  const query = workspaceId
    ? `SELECT * FROM saved_views WHERE ${workspaceClause("workspace_id", "?1")} ORDER BY created_at`
    : "SELECT * FROM saved_views ORDER BY created_at";
  const rows = (
    workspaceId ? db.query(query).all(workspaceId) : db.query(query).all()
  ) as SavedViewRow[];
  return rows.filter((row) => {
    if (!includeArchived && row.archived_at) return false;
    if (!includeArchived && row.team_id) {
      const teamQuery = workspaceId
        ? `SELECT archived_at FROM teams WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
        : "SELECT archived_at FROM teams WHERE id = ?1";
      const team = (
        workspaceId
          ? db.query(teamQuery).get(row.team_id, workspaceId)
          : db.query(teamQuery).get(row.team_id)
      ) as { archived_at: string | null } | null;
      if (team?.archived_at) return false;
    }
    if (!canAccessSavedView(db, row, viewer, workspaceId)) return false;
    if (teamId) {
      if (row.scope === "team") return row.team_id === teamId;
      if (row.scope === "project") {
        return Boolean(
          row.project_id && listProjectTeamIds(db, row.project_id, workspaceId).includes(teamId),
        );
      }
      if (row.scope === "initiative") {
        return Boolean(
          row.initiative_id &&
          listInitiativeTeamIds(db, row.initiative_id, workspaceId).includes(teamId),
        );
      }
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

export function createSavedView(
  db: Database,
  ownerRef: ViewerRef,
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
  workspaceId?: string,
): SavedViewRow {
  const ownerId = viewerId(ownerRef);
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Saved view name cannot be empty");
  const scope = resolveScope(input.scope);
  let teamId: string | null = input.teamId ?? null;
  let projectId: string | null = input.projectId ?? null;
  let initiativeId: string | null = input.initiativeId ?? null;
  let savedViewWorkspaceId = workspaceId ?? null;
  if (scope === "team") {
    if (!teamId) throw apiError("VALIDATION_FAILED", "Team saved views require teamId");
    const teamQuery = workspaceId
      ? `SELECT id, archived_at, workspace_id FROM teams WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
      : "SELECT id, archived_at, workspace_id FROM teams WHERE id = ?1";
    const team = (
      workspaceId ? db.query(teamQuery).get(teamId, workspaceId) : db.query(teamQuery).get(teamId)
    ) as { id: string; archived_at: string | null; workspace_id: string | null } | null;
    if (!team) throw apiError("NOT_FOUND", "Team not found");
    if (team.archived_at) throw apiError("VALIDATION_FAILED", "Team is archived");
    savedViewWorkspaceId = team.workspace_id;
    const actor = resolveViewer(db, ownerRef);
    if (!actor || !canWriteTeam(db, actor, teamId)) {
      throw apiError("UNAUTHORIZED", "Team access policy does not allow this operation");
    }
    projectId = null;
    initiativeId = null;
  } else if (scope === "project") {
    if (!projectId) throw apiError("VALIDATION_FAILED", "Project saved views require projectId");
    const project = getProject(db, projectId, workspaceId);
    if (!project) throw apiError("NOT_FOUND", "Project not found");
    const actor = resolveViewer(db, ownerRef);
    if (!actor) throw apiError("NOT_FOUND", "Actor not found");
    assertCanManageProject(db, actor, projectId, workspaceId);
    savedViewWorkspaceId = project.workspace_id ?? savedViewWorkspaceId;
    teamId = null;
    initiativeId = null;
  } else if (scope === "initiative") {
    if (!initiativeId)
      throw apiError("VALIDATION_FAILED", "Initiative saved views require initiativeId");
    const initiative = getInitiative(db, initiativeId, workspaceId);
    if (!initiative) throw apiError("NOT_FOUND", "Initiative not found");
    const actor = resolveViewer(db, ownerRef);
    if (!actor || !canViewInitiative(db, initiativeId, actor, workspaceId)) {
      throw apiError("NOT_FOUND", "Initiative not found");
    }
    if (initiative.owner_id && initiative.owner_id !== actor.id && !isWorkspaceAdmin(actor)) {
      throw apiError("NOT_FOUND", "Initiative not found");
    }
    savedViewWorkspaceId = initiative.workspace_id ?? savedViewWorkspaceId;
    teamId = null;
    projectId = null;
  } else {
    teamId = null;
    projectId = null;
    initiativeId = null;
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
      (id, name, scope, team_id, project_id, initiative_id, owner_id, filter_json, order_by, group_by, columns_json, created_at, updated_at, archived_at, workspace_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, NULL, ?13)`,
  ).run(
    id,
    name,
    scope,
    teamId,
    projectId,
    initiativeId,
    ownerId,
    parseFilter(input.filter),
    orderBy,
    groupBy,
    parseColumns(input.columns),
    timestamp,
    savedViewWorkspaceId,
  );
  return getSavedView(db, id, savedViewWorkspaceId ?? undefined)!;
}

export function updateSavedView(
  db: Database,
  id: string,
  viewer: ViewerRef,
  input: {
    name?: string | null;
    filter?: unknown;
    orderBy?: string | null;
    groupBy?: string | null;
    columns?: string[] | null;
    archived?: boolean | null;
  },
  workspaceId?: string,
): SavedViewRow {
  const existing = getSavedView(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Saved view not found");
  if (!canAccessSavedView(db, existing, viewer, workspaceId))
    throw apiError("NOT_FOUND", "Saved view not found");
  assertCanMutateSavedView(db, existing, viewer, workspaceId);
  if (existing.scope === "personal" && existing.owner_id !== viewerId(viewer)) {
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
    if (workspaceId) {
      params.push(workspaceId);
      db.query(
        `UPDATE saved_views SET ${sets.join(", ")} WHERE id = ?${params.length - 1} AND ${workspaceClause("workspace_id", `?${params.length}`)}`,
      ).run(...(params as never[]));
    } else {
      db.query(`UPDATE saved_views SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
        ...(params as never[]),
      );
    }
  }
  return getSavedView(db, id, workspaceId)!;
}

export function duplicateSavedView(
  db: Database,
  id: string,
  viewer: ViewerRef,
  workspaceId?: string,
): SavedViewRow {
  const existing = getSavedView(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Saved view not found");
  if (!canAccessSavedView(db, existing, viewer, workspaceId))
    throw apiError("NOT_FOUND", "Saved view not found");
  return createSavedView(
    db,
    viewer,
    {
      name: `${existing.name} (copy)`,
      scope: existing.scope,
      teamId: existing.team_id,
      projectId: existing.project_id,
      initiativeId: existing.initiative_id,
      filter: JSON.parse(existing.filter_json),
      orderBy: existing.order_by,
      groupBy: existing.group_by,
      columns: JSON.parse(existing.columns_json || "[]"),
    },
    workspaceId,
  );
}

export function deleteSavedView(
  db: Database,
  id: string,
  viewer: ViewerRef,
  workspaceId?: string,
): boolean {
  const existing = getSavedView(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Saved view not found");
  if (!canAccessSavedView(db, existing, viewer, workspaceId))
    throw apiError("NOT_FOUND", "Saved view not found");
  assertCanMutateSavedView(db, existing, viewer, workspaceId);
  if (existing.scope === "personal" && existing.owner_id !== viewerId(viewer)) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }
  db.transaction(() => {
    if (workspaceId) {
      // SQLite no aplica ON DELETE CASCADE cuando la FK compuesta contiene
      // NULL. Borrar explícitamente evita Favorites huérfanos legacy.
      db.query(
        `DELETE FROM favorites
         WHERE saved_view_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
      ).run(id, workspaceId);
      db.query(
        `DELETE FROM saved_views WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
      ).run(id, workspaceId);
    } else {
      db.query("DELETE FROM favorites WHERE saved_view_id = ?1").run(id);
      db.query("DELETE FROM saved_views WHERE id = ?1").run(id);
    }
  })();
  return true;
}
