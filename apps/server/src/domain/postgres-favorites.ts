import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import type { ActorRow } from "../auth/viewer.ts";
import {
  canAccessPostgresProject,
  getPostgresProject,
  type PostgresProjectRow,
} from "./postgres-projects.ts";
import {
  canAccessPostgresSavedView,
  getPostgresSavedView,
  type PostgresSavedViewRow,
} from "./postgres-saved-views.ts";

export interface PostgresFavoriteRow {
  id: string;
  actor_id: string;
  project_id: string | null;
  saved_view_id: string | null;
  position: number;
  created_at: string;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof Error && /unique|duplicate|23505/i.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export function mapPostgresFavorite(row: PostgresFavoriteRow) {
  return {
    id: row.id,
    actorId: row.actor_id,
    projectId: row.project_id,
    savedViewId: row.saved_view_id,
    position: row.position,
  };
}

async function getPostgresFavorite(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<PostgresFavoriteRow | null> {
  return persistence.one<PostgresFavoriteRow>("SELECT * FROM favorites WHERE id = $1", [id]);
}

async function canAccessFavoriteTarget(
  persistence: Persistence,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  row: PostgresFavoriteRow,
): Promise<boolean> {
  if (row.project_id) {
    const project = await getPostgresProject(persistence, row.project_id);
    return Boolean(
      project &&
      !project.archived_at &&
      (await canAccessPostgresProject(persistence, viewer, project.id)),
    );
  }
  if (row.saved_view_id) {
    const view = await getPostgresSavedView(persistence, row.saved_view_id);
    return Boolean(
      view && !view.archived_at && (await canAccessPostgresSavedView(persistence, view, viewer)),
    );
  }
  return false;
}

export async function listPostgresFavorites(
  persistence: Persistence,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
): Promise<PostgresFavoriteRow[]> {
  const rows = await persistence.many<PostgresFavoriteRow>(
    `SELECT f.*
     FROM favorites f
     LEFT JOIN projects p ON p.id = f.project_id
     LEFT JOIN saved_views sv ON sv.id = f.saved_view_id
     WHERE f.actor_id = $1
       AND ((f.project_id IS NOT NULL AND p.archived_at IS NULL)
         OR (f.saved_view_id IS NOT NULL AND sv.archived_at IS NULL))
     ORDER BY f.position, f.created_at, f.id`,
    [viewer.id],
  );
  const result: PostgresFavoriteRow[] = [];
  for (const row of rows) {
    if (await canAccessFavoriteTarget(persistence, viewer, row)) result.push(row);
  }
  return result;
}

async function assertProject(
  persistence: Persistence,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  id: string,
): Promise<PostgresProjectRow> {
  const project = await getPostgresProject(persistence, id);
  if (!project || project.archived_at) throw apiError("NOT_FOUND", "Project not found");
  if (!(await canAccessPostgresProject(persistence, viewer, id))) {
    throw apiError("NOT_FOUND", "Project not found");
  }
  return project;
}

async function assertSavedView(
  persistence: Persistence,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  id: string,
): Promise<PostgresSavedViewRow> {
  const view = await getPostgresSavedView(persistence, id);
  if (!view || view.archived_at || !(await canAccessPostgresSavedView(persistence, view, viewer))) {
    throw apiError("NOT_FOUND", "Saved view not found");
  }
  return view;
}

async function nextPosition(persistence: Persistence, actorId: string): Promise<number> {
  const row = await persistence.one<{ position: number }>(
    "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM favorites WHERE actor_id = $1",
    [actorId],
  );
  return row?.position ?? 0;
}

function assertPosition(position: number): void {
  if (!Number.isInteger(position) || position < 0) {
    throw apiError("VALIDATION_FAILED", "Favorite position must be a non-negative integer");
  }
}

export async function createPostgresFavorite(
  persistence: Persistence,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  input: { projectId?: string | null; savedViewId?: string | null },
): Promise<PostgresFavoriteRow> {
  const projectId = input.projectId ?? null;
  const savedViewId = input.savedViewId ?? null;
  if ((projectId == null) === (savedViewId == null)) {
    throw apiError("VALIDATION_FAILED", "Favorite requires exactly one projectId or savedViewId");
  }
  if (projectId) await assertProject(persistence, viewer, projectId);
  if (savedViewId) await assertSavedView(persistence, viewer, savedViewId);

  const existing = await persistence.one<PostgresFavoriteRow>(
    `SELECT * FROM favorites
     WHERE actor_id = $1
       AND ((project_id = $2 AND $2 IS NOT NULL) OR (saved_view_id = $3 AND $3 IS NOT NULL))`,
    [viewer.id, projectId, savedViewId],
  );
  if (existing) return existing;

  const id = newId();
  try {
    await persistence.execute(
      `INSERT INTO favorites (id, actor_id, project_id, saved_view_id, position, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, viewer.id, projectId, savedViewId, await nextPosition(persistence, viewer.id), now()],
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const concurrent = await persistence.one<PostgresFavoriteRow>(
      `SELECT * FROM favorites
       WHERE actor_id = $1
         AND ((project_id = $2 AND $2 IS NOT NULL) OR (saved_view_id = $3 AND $3 IS NOT NULL))`,
      [viewer.id, projectId, savedViewId],
    );
    if (concurrent) return concurrent;
    throw error;
  }
  const row = await getPostgresFavorite(persistence, id);
  if (!row) throw new Error("PostgreSQL favorite insert returned no row");
  return row;
}

export async function deletePostgresFavorite(
  persistence: Persistence,
  actorId: string,
  id: string,
): Promise<boolean> {
  const existing = await getPostgresFavorite(persistence, id);
  if (!existing) return true;
  if (existing.actor_id !== actorId) throw apiError("NOT_FOUND", "Favorite not found");
  await persistence.execute("DELETE FROM favorites WHERE id = $1 AND actor_id = $2", [id, actorId]);
  return true;
}

export async function reorderPostgresFavorite(
  persistence: Persistence,
  actorId: string,
  id: string,
  position: number,
): Promise<PostgresFavoriteRow> {
  assertPosition(position);
  const existing = await getPostgresFavorite(persistence, id);
  if (!existing || existing.actor_id !== actorId) throw apiError("NOT_FOUND", "Favorite not found");
  const rows = [
    ...(await persistence.many<PostgresFavoriteRow>(
      "SELECT * FROM favorites WHERE actor_id = $1 ORDER BY position, created_at, id",
      [actorId],
    )),
  ];
  const currentIndex = rows.findIndex((row) => row.id === id);
  if (currentIndex < 0) throw apiError("NOT_FOUND", "Favorite not found");
  const selected = rows.splice(currentIndex, 1)[0];
  if (!selected) throw apiError("NOT_FOUND", "Favorite not found");
  rows.splice(Math.min(position, rows.length), 0, selected);
  await persistence.transaction(async (tx) => {
    for (const [index, row] of rows.entries()) {
      await tx.execute("UPDATE favorites SET position = $1 WHERE id = $2", [index, row.id]);
    }
  });
  const result = await getPostgresFavorite(persistence, id);
  if (!result) throw apiError("NOT_FOUND", "Favorite not found");
  return result;
}
