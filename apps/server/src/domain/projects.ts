// Dominio de proyectos (spec §3): agrupan issues, con lead, estado y fecha objetivo.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getActor } from "./actors.ts";

export const PROJECT_STATES = [
  "backlog", "planned", "started", "paused", "completed", "canceled",
] as const;

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  state: (typeof PROJECT_STATES)[number];
  lead_id: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function mapProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    leadId: row.lead_id,
    targetDate: row.target_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function getProject(db: Database, id: string): ProjectRow | null {
  return db.query("SELECT * FROM projects WHERE id = ?1").get(id) as ProjectRow | null;
}

export function listProjects(db: Database, state?: string | null): ProjectRow[] {
  if (state) {
    return db
      .query("SELECT * FROM projects WHERE state = ?1 AND archived_at IS NULL ORDER BY created_at")
      .all(state) as ProjectRow[];
  }
  return db
    .query("SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at")
    .all() as ProjectRow[];
}

function validate(db: Database, input: { state?: string | null; leadId?: string | null }): void {
  if (input.state != null && !PROJECT_STATES.includes(input.state as never)) {
    throw apiError("VALIDATION_FAILED", `Invalid project state: ${input.state}`);
  }
  if (input.leadId != null && !getActor(db, input.leadId)) {
    throw apiError("NOT_FOUND", "Lead actor not found");
  }
}

export function createProject(
  db: Database,
  input: {
    name: string;
    description?: string | null;
    state?: string | null;
    leadId?: string | null;
    targetDate?: string | null;
  },
): ProjectRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Project name cannot be empty");
  validate(db, input);

  const id = newId();
  const timestamp = now();
  db.query(
    `INSERT INTO projects (id, name, description, state, lead_id, target_date, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  ).run(
    id, name, input.description ?? null, input.state ?? "backlog",
    input.leadId ?? null, input.targetDate ?? null, timestamp,
  );
  return getProject(db, id)!;
}

export function updateProject(
  db: Database,
  id: string,
  input: {
    name?: string | null;
    description?: string | null;
    state?: string | null;
    leadId?: string | null;
    targetDate?: string | null;
  },
): ProjectRow {
  const project = getProject(db, id);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  validate(db, input);

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
    params.push(value);
  };
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Project name cannot be empty");
    push("name", name);
  }
  if (input.description !== undefined) push("description", input.description);
  if (input.state != null) push("state", input.state);
  if (input.leadId !== undefined) push("lead_id", input.leadId);
  if (input.targetDate !== undefined) push("target_date", input.targetDate);

  if (sets.length > 0) {
    push("updated_at", now());
    params.push(id);
    db.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
      ...(params as never[]),
    );
  }
  return getProject(db, id)!;
}
