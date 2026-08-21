// Dominio del Workspace único de prime-board.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { now } from "../db/util.ts";

export interface WorkspaceRow {
  id: string;
  name: string;
  url_key: string;
  created_at: string;
  updated_at: string;
}

export function getWorkspace(db: Database, id?: string): WorkspaceRow | null {
  if (id) {
    return db
      .query("SELECT id, name, url_key, created_at, updated_at FROM workspace WHERE id = ?1")
      .get(id) as WorkspaceRow | null;
  }
  const workspaces = db
    .query(
      "SELECT id, name, url_key, created_at, updated_at FROM workspace ORDER BY created_at, id",
    )
    .all() as WorkspaceRow[];
  if (workspaces.length > 1) {
    throw apiError("VALIDATION_FAILED", "Workspace selection is required");
  }
  return workspaces[0] ?? null;
}

export function mapWorkspace(row: WorkspaceRow) {
  return {
    id: row.id,
    name: row.name,
    urlKey: row.url_key,
    createdAt: row.created_at,
  };
}

export interface WorkspaceUpdateInput {
  name: string;
}

/** Cambia únicamente el nombre; urlKey e identidad del Workspace son estables. */
export function updateWorkspace(
  db: Database,
  input: WorkspaceUpdateInput,
  workspaceId?: string,
): WorkspaceRow {
  const workspace = getWorkspace(db, workspaceId);
  if (!workspace) throw apiError("NOT_FOUND", "Workspace is not initialized");

  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Workspace name cannot be empty");

  db.query("UPDATE workspace SET name = ?1, updated_at = ?2 WHERE id = ?3").run(
    name,
    now(),
    workspace.id,
  );
  return getWorkspace(db, workspace.id)!;
}
