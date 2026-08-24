// Favoritos privados del actor para proyectos y vistas guardadas (PRB-268).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { canAccessSavedView, getSavedView, type SavedViewRow } from "./saved-views.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { canAccessProject } from "../auth/permissions.ts";
import { getProject, type ProjectRow } from "./projects.ts";

export interface FavoriteRow {
  id: string;
  actor_id: string;
  project_id: string | null;
  saved_view_id: string | null;
  position: number;
  created_at: string;
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

export function mapFavorite(row: FavoriteRow) {
  return {
    id: row.id,
    actorId: row.actor_id,
    projectId: row.project_id,
    savedViewId: row.saved_view_id,
    position: row.position,
  };
}

function getFavorite(db: Database, id: string, workspaceId?: string): FavoriteRow | null {
  const query = workspaceId
    ? `SELECT * FROM favorites WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT * FROM favorites WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as FavoriteRow | null;
}

export function listFavorites(
  db: Database,
  viewer: ViewerRef,
  workspaceId?: string,
): FavoriteRow[] {
  const actor = resolveViewer(db, viewer);
  if (!actor) return [];
  const actorId = actor.id;
  const workspaceCondition = workspaceId ? `AND ${workspaceClause("f.workspace_id", "?2")}` : "";
  const query = `
       SELECT f.*
       FROM favorites f
       LEFT JOIN projects p ON p.id = f.project_id
       LEFT JOIN saved_views sv ON sv.id = f.saved_view_id
       WHERE f.actor_id = ?1
         ${workspaceCondition}
         AND ((f.project_id IS NOT NULL AND p.archived_at IS NULL)
           OR (f.saved_view_id IS NOT NULL AND sv.archived_at IS NULL))
       ORDER BY f.position, f.created_at, f.id`;
  const rows = (
    workspaceId ? db.query(query).all(actorId, workspaceId) : db.query(query).all(actorId)
  ) as FavoriteRow[];
  return rows.filter((row) => {
    if (row.project_id) {
      const project = getProject(db, row.project_id, workspaceId);
      return Boolean(project && !project.archived_at && canAccessProject(db, actor, project.id));
    }
    if (row.saved_view_id) {
      const savedView = getSavedView(db, row.saved_view_id, workspaceId) as SavedViewRow | null;
      return Boolean(
        savedView &&
        !savedView.archived_at &&
        canAccessSavedView(db, savedView, actor, workspaceId),
      );
    }
    return false;
  });
}

function nextPosition(db: Database, actorId: string, workspaceId?: string): number {
  const query = workspaceId
    ? `SELECT COALESCE(MAX(position), -1) + 1 AS position
       FROM favorites
       WHERE actor_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM favorites WHERE actor_id = ?1";
  const row = (
    workspaceId ? db.query(query).get(actorId, workspaceId) : db.query(query).get(actorId)
  ) as {
    position: number;
  };
  return row.position;
}

function assertPosition(position: number): void {
  if (!Number.isInteger(position) || position < 0) {
    throw apiError("VALIDATION_FAILED", "Favorite position must be a non-negative integer");
  }
}

function assertProject(db: Database, id: string, workspaceId?: string): ProjectRow {
  const row = getProject(db, id, workspaceId);
  if (!row || row.archived_at) throw apiError("NOT_FOUND", "Project not found");
  return row;
}

function assertSavedView(
  db: Database,
  id: string,
  viewer: ViewerRef,
  workspaceId?: string,
): SavedViewRow {
  const row = getSavedView(db, id, workspaceId) as SavedViewRow | null;
  if (!row || row.archived_at || !canAccessSavedView(db, row, viewer, workspaceId)) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }
  return row;
}

export function createFavorite(
  db: Database,
  viewer: ViewerRef,
  input: { projectId?: string | null; savedViewId?: string | null },
  workspaceId?: string,
): FavoriteRow {
  const actorId = viewerId(viewer);
  const projectId = input.projectId ?? null;
  const savedViewId = input.savedViewId ?? null;
  if ((projectId == null) === (savedViewId == null)) {
    throw apiError("VALIDATION_FAILED", "Favorite requires exactly one projectId or savedViewId");
  }
  const project = projectId ? assertProject(db, projectId, workspaceId) : null;
  const savedView = savedViewId ? assertSavedView(db, savedViewId, viewer, workspaceId) : null;
  // Un Workspace singleton puede conservar una fila legacy con NULL. El
  // Favorite debe usar el mismo alcance que su recurso para satisfacer la FK
  // compuesta y mantener la compatibilidad de lectura/escritura.
  const favoriteWorkspaceId = project
    ? project.workspace_id
    : savedView
      ? savedView.workspace_id
      : (workspaceId ?? null);

  const existing = db
    .query(
      `SELECT * FROM favorites
       WHERE actor_id = ?1
         ${favoriteWorkspaceId ? `AND ${workspaceClause("workspace_id", "?4")}` : ""}
         AND ((project_id = ?2 AND ?2 IS NOT NULL) OR (saved_view_id = ?3 AND ?3 IS NOT NULL))`,
    )
    .get(
      ...(favoriteWorkspaceId
        ? [actorId, projectId, savedViewId, favoriteWorkspaceId]
        : [actorId, projectId, savedViewId]),
    ) as FavoriteRow | null;
  if (existing) return existing;

  const id = newId();
  db.query(
    `INSERT INTO favorites (id, actor_id, project_id, saved_view_id, position, created_at, workspace_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(
    id,
    actorId,
    projectId,
    savedViewId,
    nextPosition(db, actorId, favoriteWorkspaceId ?? undefined),
    now(),
    favoriteWorkspaceId,
  );
  return getFavorite(db, id, favoriteWorkspaceId ?? undefined)!;
}

export function deleteFavorite(
  db: Database,
  actorId: string,
  id: string,
  workspaceId?: string,
): boolean {
  const existing = getFavorite(db, id, workspaceId);
  if (!existing) return true;
  if (existing.actor_id !== actorId) throw apiError("NOT_FOUND", "Favorite not found");
  if (workspaceId) {
    db.query(
      `DELETE FROM favorites WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
    ).run(id, workspaceId);
  } else {
    db.query("DELETE FROM favorites WHERE id = ?1").run(id);
  }
  return true;
}

export function reorderFavorite(
  db: Database,
  actorId: string,
  id: string,
  position: number,
  workspaceId?: string,
): FavoriteRow {
  assertPosition(position);
  const existing = getFavorite(db, id, workspaceId);
  if (!existing || existing.actor_id !== actorId) throw apiError("NOT_FOUND", "Favorite not found");

  const query = workspaceId
    ? `SELECT * FROM favorites
       WHERE actor_id = ?1 AND ${workspaceClause("workspace_id", "?2")}
       ORDER BY position, created_at, id`
    : "SELECT * FROM favorites WHERE actor_id = ?1 ORDER BY position, created_at, id";
  const rows = (
    workspaceId ? db.query(query).all(actorId, workspaceId) : db.query(query).all(actorId)
  ) as FavoriteRow[];
  const currentIndex = rows.findIndex((row) => row.id === id);
  const [selected] = rows.splice(currentIndex, 1);
  const targetIndex = Math.min(position, rows.length);
  rows.splice(targetIndex, 0, selected!);
  db.transaction(() => {
    for (const [index, row] of rows.entries()) {
      const update = workspaceId
        ? `UPDATE favorites SET position = ?1 WHERE id = ?2 AND ${workspaceClause("workspace_id", "?3")}`
        : "UPDATE favorites SET position = ?1 WHERE id = ?2";
      if (workspaceId) db.query(update).run(index, row.id, workspaceId);
      else db.query(update).run(index, row.id);
    }
  })();
  return getFavorite(db, id, workspaceId)!;
}
