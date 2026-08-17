// Favoritos privados del actor para proyectos y vistas guardadas (PRB-268).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { canViewSavedView, type SavedViewRow } from "./saved-views.ts";

export interface FavoriteRow {
  id: string;
  actor_id: string;
  project_id: string | null;
  saved_view_id: string | null;
  position: number;
  created_at: string;
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

function getFavorite(db: Database, id: string): FavoriteRow | null {
  return db.query("SELECT * FROM favorites WHERE id = ?1").get(id) as FavoriteRow | null;
}

export function listFavorites(db: Database, actorId: string): FavoriteRow[] {
  return db
    .query(
      `SELECT f.*
       FROM favorites f
       LEFT JOIN projects p ON p.id = f.project_id
       LEFT JOIN saved_views sv ON sv.id = f.saved_view_id
       WHERE f.actor_id = ?1
         AND ((f.project_id IS NOT NULL AND p.archived_at IS NULL)
           OR (f.saved_view_id IS NOT NULL AND sv.archived_at IS NULL))
       ORDER BY f.position, f.created_at, f.id`,
    )
    .all(actorId) as FavoriteRow[];
}

function nextPosition(db: Database, actorId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM favorites WHERE actor_id = ?1")
    .get(actorId) as { position: number };
  return row.position;
}

function assertPosition(position: number): void {
  if (!Number.isInteger(position) || position < 0) {
    throw apiError("VALIDATION_FAILED", "Favorite position must be a non-negative integer");
  }
}

function assertProject(db: Database, id: string): void {
  const row = db.query("SELECT id, archived_at FROM projects WHERE id = ?1").get(id) as {
    id: string;
    archived_at: string | null;
  } | null;
  if (!row || row.archived_at) throw apiError("NOT_FOUND", "Project not found");
}

function assertSavedView(db: Database, id: string, actorId: string): void {
  const row = db.query("SELECT * FROM saved_views WHERE id = ?1").get(id) as SavedViewRow | null;
  if (!row || row.archived_at || !canViewSavedView(row, actorId)) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }
}

export function createFavorite(
  db: Database,
  actorId: string,
  input: { projectId?: string | null; savedViewId?: string | null },
): FavoriteRow {
  const projectId = input.projectId ?? null;
  const savedViewId = input.savedViewId ?? null;
  if ((projectId == null) === (savedViewId == null)) {
    throw apiError("VALIDATION_FAILED", "Favorite requires exactly one projectId or savedViewId");
  }
  if (projectId) assertProject(db, projectId);
  if (savedViewId) assertSavedView(db, savedViewId, actorId);

  const existing = db
    .query(
      "SELECT * FROM favorites WHERE actor_id = ?1 AND ((project_id = ?2 AND ?2 IS NOT NULL) OR (saved_view_id = ?3 AND ?3 IS NOT NULL))",
    )
    .get(actorId, projectId, savedViewId) as FavoriteRow | null;
  if (existing) return existing;

  const id = newId();
  db.query(
    `INSERT INTO favorites (id, actor_id, project_id, saved_view_id, position, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(id, actorId, projectId, savedViewId, nextPosition(db, actorId), now());
  return getFavorite(db, id)!;
}

export function deleteFavorite(db: Database, actorId: string, id: string): boolean {
  const existing = getFavorite(db, id);
  if (!existing) return true;
  if (existing.actor_id !== actorId) throw apiError("NOT_FOUND", "Favorite not found");
  db.query("DELETE FROM favorites WHERE id = ?1").run(id);
  return true;
}

export function reorderFavorite(
  db: Database,
  actorId: string,
  id: string,
  position: number,
): FavoriteRow {
  assertPosition(position);
  const existing = getFavorite(db, id);
  if (!existing || existing.actor_id !== actorId) throw apiError("NOT_FOUND", "Favorite not found");

  const rows = db
    .query("SELECT * FROM favorites WHERE actor_id = ?1 ORDER BY position, created_at, id")
    .all(actorId) as FavoriteRow[];
  const currentIndex = rows.findIndex((row) => row.id === id);
  const [selected] = rows.splice(currentIndex, 1);
  const targetIndex = Math.min(position, rows.length);
  rows.splice(targetIndex, 0, selected!);
  db.transaction(() => {
    for (const [index, row] of rows.entries()) {
      db.query("UPDATE favorites SET position = ?1 WHERE id = ?2").run(index, row.id);
    }
  })();
  return getFavorite(db, id)!;
}
