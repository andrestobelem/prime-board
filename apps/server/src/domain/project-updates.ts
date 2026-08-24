// Actualizaciones narrativas de proyectos (PRB-207).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getProject } from "./projects.ts";

function workspaceClause(column: string, parameter: string): string {
  return `(${column} = ${parameter} OR (${column} IS NULL AND (SELECT count(*) FROM workspace) = 1))`;
}

export type ProjectUpdateHealth = "on_track" | "at_risk" | "off_track";

export interface ProjectUpdateRow {
  id: string;
  project_id: string;
  author_id: string;
  health: ProjectUpdateHealth;
  body: string;
  risks: string | null;
  created_at: string;
  updated_at: string;
  workspace_id: string | null;
}

export function mapProjectUpdate(row: ProjectUpdateRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    authorId: row.author_id,
    health: row.health,
    body: row.body,
    risks: row.risks,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getProjectUpdate(
  db: Database,
  id: string,
  workspaceId?: string,
): ProjectUpdateRow | null {
  const query = workspaceId
    ? `SELECT * FROM project_updates WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT * FROM project_updates WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as ProjectUpdateRow | null;
}

export function listProjectUpdates(
  db: Database,
  projectId: string,
  workspaceId?: string,
): ProjectUpdateRow[] {
  const query = workspaceId
    ? `SELECT * FROM project_updates WHERE project_id = ?1 AND ${workspaceClause("workspace_id", "?2")} ORDER BY created_at DESC, id DESC`
    : "SELECT * FROM project_updates WHERE project_id = ?1 ORDER BY created_at DESC, id DESC";
  return (
    workspaceId ? db.query(query).all(projectId, workspaceId) : db.query(query).all(projectId)
  ) as ProjectUpdateRow[];
}

function resolveHealth(health: string): ProjectUpdateHealth {
  const normalized = health.toLowerCase() as ProjectUpdateHealth;
  if (normalized !== "on_track" && normalized !== "at_risk" && normalized !== "off_track") {
    throw apiError("VALIDATION_FAILED", `Invalid project update health: ${health}`);
  }
  return normalized;
}

export function createProjectUpdate(
  db: Database,
  authorId: string,
  input: {
    projectId: string;
    health: string;
    body: string;
    risks?: string | null;
  },
  workspaceId?: string,
): ProjectUpdateRow {
  if (!getProject(db, input.projectId, workspaceId))
    throw apiError("NOT_FOUND", "Project not found");
  const body = input.body.trim();
  if (!body) throw apiError("VALIDATION_FAILED", "Project update body cannot be empty");
  const id = newId();
  const timestamp = now();
  db.query(
    `INSERT INTO project_updates
      (id, project_id, author_id, health, body, risks, created_at, updated_at, workspace_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`,
  ).run(
    id,
    input.projectId,
    authorId,
    resolveHealth(input.health),
    body,
    input.risks?.trim() || null,
    timestamp,
    workspaceId ?? null,
  );
  return getProjectUpdate(db, id, workspaceId)!;
}

export function deleteProjectUpdate(db: Database, id: string, workspaceId?: string): boolean {
  const existing = getProjectUpdate(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Project update not found");
  if (workspaceId) {
    db.query(
      `DELETE FROM project_updates WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
    ).run(id, workspaceId);
  } else {
    db.query("DELETE FROM project_updates WHERE id = ?1").run(id);
  }
  return true;
}
