// Milestones: sub-estructura ordenada dentro de un proyecto (AT-29).
// Un issue solo puede apuntar a un milestone del proyecto al que pertenece.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";

export interface MilestoneRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  target_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export function mapMilestone(row: MilestoneRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    targetDate: row.target_date,
    position: row.position,
    projectId: row.project_id,
    createdAt: row.created_at,
  };
}

export function getMilestone(db: Database, id: string): MilestoneRow | null {
  return db.query("SELECT * FROM milestones WHERE id = ?1").get(id) as MilestoneRow | null;
}

export function listMilestones(db: Database, projectId: string): MilestoneRow[] {
  return db
    .query("SELECT * FROM milestones WHERE project_id = ?1 ORDER BY position, created_at")
    .all(projectId) as MilestoneRow[];
}

export function createMilestone(
  db: Database,
  input: { projectId: string; name: string; description?: string | null; targetDate?: string | null; position?: number | null },
): MilestoneRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Milestone name cannot be empty");
  if (!db.query("SELECT id FROM projects WHERE id = ?1").get(input.projectId)) {
    throw apiError("NOT_FOUND", "Project not found");
  }
  if (db.query("SELECT id FROM milestones WHERE project_id = ?1 AND name = ?2").get(input.projectId, name)) {
    throw apiError("VALIDATION_FAILED", `Milestone ${name} already exists in this project`);
  }
  const max = db
    .query("SELECT coalesce(max(position), -1) AS max FROM milestones WHERE project_id = ?1")
    .get(input.projectId) as { max: number };

  const id = newId();
  const timestamp = now();
  db.query(
    `INSERT INTO milestones (id, project_id, name, description, target_date, position, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  ).run(id, input.projectId, name, input.description ?? null, input.targetDate ?? null,
        input.position ?? max.max + 1, timestamp);
  return getMilestone(db, id)!;
}

export function updateMilestone(
  db: Database,
  id: string,
  input: { name?: string | null; description?: string | null; targetDate?: string | null; position?: number | null },
): MilestoneRow {
  const milestone = getMilestone(db, id);
  if (!milestone) throw apiError("NOT_FOUND", "Milestone not found");
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
    params.push(value);
  };
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Milestone name cannot be empty");
    push("name", name);
  }
  if (input.description !== undefined) push("description", input.description);
  if (input.targetDate !== undefined) push("target_date", input.targetDate);
  if (input.position != null) push("position", input.position);
  if (sets.length > 0) {
    push("updated_at", now());
    params.push(id);
    db.query(`UPDATE milestones SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(...(params as never[]));
  }
  return getMilestone(db, id)!;
}

/** Un issue solo puede apuntar a un milestone del proyecto en el que está. */
export function assertMilestoneMatchesProject(
  db: Database,
  milestoneId: string,
  projectId: string | null,
): void {
  const milestone = getMilestone(db, milestoneId);
  if (!milestone) throw apiError("NOT_FOUND", "Milestone not found");
  if (!projectId) {
    throw apiError("VALIDATION_FAILED", "Issue must belong to a project to have a milestone");
  }
  if (milestone.project_id !== projectId) {
    throw apiError("VALIDATION_FAILED", "Milestone belongs to a different project");
  }
}
