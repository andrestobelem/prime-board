// Actualizaciones narrativas de proyectos (PRB-207).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getProject } from "./projects.ts";

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

export function getProjectUpdate(db: Database, id: string): ProjectUpdateRow | null {
  return db.query("SELECT * FROM project_updates WHERE id = ?1").get(id) as ProjectUpdateRow | null;
}

export function listProjectUpdates(db: Database, projectId: string): ProjectUpdateRow[] {
  return db
    .query("SELECT * FROM project_updates WHERE project_id = ?1 ORDER BY created_at DESC, id DESC")
    .all(projectId) as ProjectUpdateRow[];
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
): ProjectUpdateRow {
  if (!getProject(db, input.projectId)) throw apiError("NOT_FOUND", "Project not found");
  const body = input.body.trim();
  if (!body) throw apiError("VALIDATION_FAILED", "Project update body cannot be empty");
  const id = newId();
  const timestamp = now();
  db.query(
    `INSERT INTO project_updates
      (id, project_id, author_id, health, body, risks, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  ).run(
    id,
    input.projectId,
    authorId,
    resolveHealth(input.health),
    body,
    input.risks?.trim() || null,
    timestamp,
  );
  return getProjectUpdate(db, id)!;
}

export function deleteProjectUpdate(db: Database, id: string): boolean {
  const existing = getProjectUpdate(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Project update not found");
  db.query("DELETE FROM project_updates WHERE id = ?1").run(id);
  return true;
}
