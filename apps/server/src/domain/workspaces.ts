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
    throw apiError("WORKSPACE_REQUIRED", "A Workspace selector is required");
  }
  return workspaces[0] ?? null;
}

export interface WorkspaceAccessRow extends WorkspaceRow {
  role: "admin" | "member";
  status: "active" | "suspended" | "left";
  is_default: number;
}

export function mapWorkspace(row: WorkspaceRow & Partial<WorkspaceAccessRow>) {
  return {
    id: row.id,
    name: row.name,
    urlKey: row.url_key,
    createdAt: row.created_at,
    role: row.role ?? "member",
    status: row.status ?? "active",
    isDefault: row.is_default === 1,
  };
}

/** Lista únicamente los Workspaces autorizados por la Membership y la key. */
export function listWorkspaceAccess(
  db: Database,
  actorId: string,
  keyId: string,
): WorkspaceAccessRow[] {
  const query =
    keyId === "local"
      ? `SELECT w.id, w.name, w.url_key, w.created_at, w.updated_at,
              m.role, m.status, 1 AS is_default
         FROM workspace w
         JOIN workspace_memberships m ON m.workspace_id = w.id
        WHERE m.actor_id = ?1 AND m.status = 'active'
        ORDER BY w.created_at, w.id`
      : `SELECT w.id, w.name, w.url_key, w.created_at, w.updated_at,
              m.role, m.status, g.is_default
         FROM workspace w
         JOIN api_key_workspaces g ON g.workspace_id = w.id
         JOIN workspace_memberships m
           ON m.workspace_id = w.id AND m.actor_id = ?1
        WHERE g.api_key_id = ?2 AND m.status = 'active'
        ORDER BY w.created_at, w.id`;
  return (
    keyId === "local" ? db.query(query).all(actorId) : db.query(query).all(actorId, keyId)
  ) as WorkspaceAccessRow[];
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
