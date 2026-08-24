// Milestones: sub-estructura ordenada dentro de un proyecto (AT-29).
// Un issue solo puede apuntar a un milestone del proyecto al que pertenece.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { parseDateTime } from "./datetime.ts";
import { recordActivity } from "./activity.ts";

function workspaceClause(column: string, parameter: string): string {
  return `(${column} = ${parameter} OR (${column} IS NULL AND (SELECT count(*) FROM workspace) = 1))`;
}

export interface MilestoneRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  target_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  workspace_id: string | null;
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

export function getMilestone(db: Database, id: string, workspaceId?: string): MilestoneRow | null {
  const query = workspaceId
    ? `SELECT * FROM milestones WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT * FROM milestones WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as MilestoneRow | null;
}

export function listMilestones(
  db: Database,
  projectId: string,
  workspaceId?: string,
): MilestoneRow[] {
  const query = workspaceId
    ? `SELECT * FROM milestones WHERE project_id = ?1 AND ${workspaceClause("workspace_id", "?2")} ORDER BY position, created_at`
    : "SELECT * FROM milestones WHERE project_id = ?1 ORDER BY position, created_at";
  return (
    workspaceId ? db.query(query).all(projectId, workspaceId) : db.query(query).all(projectId)
  ) as MilestoneRow[];
}

export function createMilestone(
  db: Database,
  input: {
    projectId: string;
    name: string;
    description?: string | null;
    targetDate?: string | null;
    position?: number | null;
  },
  workspaceId?: string,
): MilestoneRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Milestone name cannot be empty");
  const projectQuery = workspaceId
    ? `SELECT id FROM projects WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT id FROM projects WHERE id = ?1";
  const project = workspaceId
    ? db.query(projectQuery).get(input.projectId, workspaceId)
    : db.query(projectQuery).get(input.projectId);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  const duplicateQuery = workspaceId
    ? `SELECT id FROM milestones WHERE project_id = ?1 AND name = ?2 AND ${workspaceClause("workspace_id", "?3")}`
    : "SELECT id FROM milestones WHERE project_id = ?1 AND name = ?2";
  if (
    workspaceId
      ? db.query(duplicateQuery).get(input.projectId, name, workspaceId)
      : db.query(duplicateQuery).get(input.projectId, name)
  ) {
    throw apiError("VALIDATION_FAILED", `Milestone ${name} already exists in this project`);
  }
  const maxQuery = workspaceId
    ? `SELECT coalesce(max(position), -1) AS max FROM milestones WHERE project_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT coalesce(max(position), -1) AS max FROM milestones WHERE project_id = ?1";
  const max = (
    workspaceId
      ? db.query(maxQuery).get(input.projectId, workspaceId)
      : db.query(maxQuery).get(input.projectId)
  ) as { max: number };

  const id = newId();
  const timestamp = now();
  db.query(
    `INSERT INTO milestones (id, project_id, name, description, target_date, position, created_at, updated_at, workspace_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`,
  ).run(
    id,
    input.projectId,
    name,
    input.description ?? null,
    input.targetDate ?? null,
    input.position ?? max.max + 1,
    timestamp,
    workspaceId ?? null,
  );
  return getMilestone(db, id, workspaceId)!;
}

export function updateMilestone(
  db: Database,
  id: string,
  input: {
    name?: string | null;
    description?: string | null;
    targetDate?: string | null;
    position?: number | null;
  },
  workspaceId?: string,
): MilestoneRow {
  const milestone = getMilestone(db, id, workspaceId);
  if (!milestone) throw apiError("NOT_FOUND", "Milestone not found");
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
    params.push(value);
  };
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Milestone name cannot be empty");
    const duplicateQuery = workspaceId
      ? `SELECT id FROM milestones WHERE project_id = ?1 AND name = ?2 AND id != ?3 AND ${workspaceClause("workspace_id", "?4")}`
      : "SELECT id FROM milestones WHERE project_id = ?1 AND name = ?2 AND id != ?3";
    const duplicate = workspaceId
      ? db.query(duplicateQuery).get(milestone.project_id, name, id, workspaceId)
      : db.query(duplicateQuery).get(milestone.project_id, name, id);
    if (duplicate)
      throw apiError("VALIDATION_FAILED", `Milestone ${name} already exists in this project`);
    push("name", name);
  }
  if (input.description !== undefined) push("description", input.description);
  if (input.targetDate !== undefined) push("target_date", input.targetDate);
  if (input.position != null) push("position", input.position);
  if (sets.length > 0) {
    push("updated_at", now());
    const idParameter = params.length + 1;
    params.push(id);
    const scope = workspaceId
      ? ` AND ${workspaceClause("workspace_id", `?${params.length + 1}`)}`
      : "";
    if (workspaceId) params.push(workspaceId);
    db.query(`UPDATE milestones SET ${sets.join(", ")} WHERE id = ?${idParameter}${scope}`).run(
      ...(params as never[]),
    );
  }
  return getMilestone(db, id, workspaceId)!;
}

function preserveMilestoneActivityReferences(
  db: Database,
  milestoneId: string,
  reference: string,
  workspaceId?: string,
): void {
  const query = workspaceId
    ? `SELECT id, payload FROM activity WHERE type IN ('milestone_changed', 'created') AND ${workspaceClause("workspace_id", "?1")}`
    : "SELECT id, payload FROM activity WHERE type IN ('milestone_changed', 'created')";
  const activities = (
    workspaceId ? db.query(query).all(workspaceId) : db.query(query).all()
  ) as Array<{
    id: string;
    payload: string;
  }>;
  for (const activity of activities) {
    const payload = JSON.parse(activity.payload) as Record<string, unknown>;
    let changed = false;
    for (const field of ["from", "to", "milestoneId"]) {
      if (payload[field] === milestoneId) {
        payload[field] = reference;
        changed = true;
      }
    }
    if (changed) {
      db.query("UPDATE activity SET payload = ?1 WHERE id = ?2").run(
        JSON.stringify(payload),
        activity.id,
      );
    }
  }
}

/**
 * Borra un milestone. Los issues asignados quedan sin milestone (no se borran ni
 * se bloquea la operación): el milestone es una agrupación, no una dependencia.
 */
export function deleteMilestone(
  db: Database,
  actorId: string,
  id: string,
  workspaceId?: string,
): number {
  const milestone = getMilestone(db, id, workspaceId);
  if (!milestone) throw apiError("NOT_FOUND", "Milestone not found");
  let affected = 0;
  const projectQuery = workspaceId
    ? `SELECT projects.name AS project_name FROM projects
     JOIN milestones ON milestones.project_id = projects.id
     WHERE milestones.id = ?1 AND ${workspaceClause("milestones.workspace_id", "?2")}`
    : `SELECT projects.name AS project_name FROM projects
     JOIN milestones ON milestones.project_id = projects.id WHERE milestones.id = ?1`;
  const project = (
    workspaceId ? db.query(projectQuery).get(id, workspaceId) : db.query(projectQuery).get(id)
  ) as { project_name: string };
  // Keep a stable natural key even if another project later reuses the name.
  const historicalReference = `${project.project_name}/${milestone.name}`;
  db.transaction(() => {
    const issueQuery = workspaceId
      ? `SELECT id, workspace_id FROM issues WHERE milestone_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
      : "SELECT id, workspace_id FROM issues WHERE milestone_id = ?1";
    const issues = (
      workspaceId ? db.query(issueQuery).all(id, workspaceId) : db.query(issueQuery).all(id)
    ) as Array<{
      id: string;
      workspace_id?: string | null;
    }>;
    affected = issues.length;
    const timestamp = now();
    if (workspaceId) {
      db.query(
        `UPDATE issues SET milestone_id = NULL, updated_at = ?1 WHERE milestone_id = ?2 AND ${workspaceClause("workspace_id", "?3")}`,
      ).run(timestamp, id, workspaceId);
    } else {
      db.query(
        "UPDATE issues SET milestone_id = NULL, updated_at = ?1 WHERE milestone_id = ?2",
      ).run(timestamp, id);
    }
    for (const issue of issues) {
      // Keep the natural reference because the milestone row is deleted below.
      recordActivity(
        db,
        issue.id,
        actorId,
        "milestone_changed",
        { from: historicalReference, to: null, reason: "milestone_deleted" },
        undefined,
        issue.workspace_id ?? undefined,
      );
    }
    preserveMilestoneActivityReferences(db, id, historicalReference, workspaceId);
    if (workspaceId) {
      db.query(
        `DELETE FROM milestones WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
      ).run(id, workspaceId);
    } else {
      db.query("DELETE FROM milestones WHERE id = ?1").run(id);
    }
  })();
  return affected;
}

/** Un issue solo puede apuntar a un milestone del proyecto en el que está. */
export function assertMilestoneMatchesProject(
  db: Database,
  milestoneId: string,
  projectId: string | null,
  workspaceId?: string,
): void {
  const milestone = getMilestone(db, milestoneId, workspaceId);
  if (!milestone) throw apiError("NOT_FOUND", "Milestone not found");
  if (!projectId) {
    throw apiError("VALIDATION_FAILED", "Issue must belong to a project to have a milestone");
  }
  if (milestone.project_id !== projectId) {
    throw apiError("VALIDATION_FAILED", "Milestone belongs to a different project");
  }
}
