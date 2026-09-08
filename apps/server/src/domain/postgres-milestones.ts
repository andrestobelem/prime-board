import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { parseDateTime } from "./datetime.ts";
import {
  assertCanManagePostgresProject,
  canAccessPostgresProject,
  getPostgresProject,
  listPostgresProjectTeamIds,
} from "./postgres-projects.ts";
import type { ActorRow } from "../auth/viewer.ts";
import type { PostgresWorkspaceContext } from "./postgres-workspace-scope.ts";
import {
  milestoneWorkspaceScope,
  projectWorkspaceScope,
  scopedWorkspacePredicate,
  workspaceIdOf,
} from "./postgres-workspace-scope.ts";

export interface PostgresMilestoneRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  target_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export function mapPostgresMilestone(row: PostgresMilestoneRow) {
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

export async function getPostgresMilestone(
  persistence: Persistence | PersistenceTransaction,
  id: string,
  context?: PostgresWorkspaceContext,
): Promise<PostgresMilestoneRow | null> {
  const scope = scopedWorkspacePredicate(
    context,
    (workspaceParam) => milestoneWorkspaceScope("milestones", workspaceParam),
    "$2",
  );
  return persistence.one<PostgresMilestoneRow>(
    `SELECT milestones.* FROM milestones WHERE milestones.id = $1 AND ${scope}`,
    [id, ...(context ? [context.workspaceId] : [])],
  );
}

export async function listPostgresMilestones(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
  context?: PostgresWorkspaceContext,
): Promise<readonly PostgresMilestoneRow[]> {
  const scope = scopedWorkspacePredicate(
    context,
    (workspaceParam) => projectWorkspaceScope("projects", workspaceParam),
    "$2",
  );
  return persistence.many<PostgresMilestoneRow>(
    `SELECT milestones.* FROM milestones
       JOIN projects ON projects.id = milestones.project_id
      WHERE milestones.project_id = $1 AND ${scope}
      ORDER BY milestones.position, milestones.created_at, milestones.id`,
    [projectId, ...(context ? [context.workspaceId] : [])],
  );
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current) {
    if (current instanceof Error && /unique|duplicate|23505/i.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function validatePosition(position: number | null | undefined): void {
  if (position !== undefined && position !== null && !Number.isFinite(position)) {
    throw apiError("VALIDATION_FAILED", "Milestone position must be finite");
  }
}

async function assertPostgresMilestoneAccess(
  persistence: Persistence,
  viewer: ActorRow,
  projectId: string,
  context?: PostgresWorkspaceContext,
): Promise<void> {
  const project = await getPostgresProject(persistence, projectId, context);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  await assertCanManagePostgresProject(persistence, viewer, projectId, context);
}

export async function createPostgresMilestone(
  persistence: Persistence,
  viewer: ActorRow,
  input: {
    projectId: string;
    name: string;
    description?: string | null;
    targetDate?: string | null;
    position?: number | null;
  },
  context?: PostgresWorkspaceContext,
): Promise<PostgresMilestoneRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Milestone name cannot be empty");
  validatePosition(input.position);
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  await assertPostgresMilestoneAccess(persistence, viewer, input.projectId, context);
  const id = newId();
  const timestamp = now();
  try {
    await persistence.transaction(async (tx) => {
      await tx.one<{ id: string }>("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [
        input.projectId,
      ]);
      const max = await tx.one<{ max: number }>(
        "SELECT COALESCE(MAX(position), -1) AS max FROM milestones WHERE project_id = $1",
        [input.projectId],
      );
      if (context) {
        await tx.execute(
          `INSERT INTO milestones
           (workspace_id, id, project_id, name, description, target_date, position, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
          [
            workspaceIdOf(context),
            id,
            input.projectId,
            name,
            input.description ?? null,
            input.targetDate ?? null,
            input.position ?? (max?.max ?? -1) + 1,
            timestamp,
          ],
        );
      } else {
        await tx.execute(
          `INSERT INTO milestones
           (id, project_id, name, description, target_date, position, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [
            id,
            input.projectId,
            name,
            input.description ?? null,
            input.targetDate ?? null,
            input.position ?? (max?.max ?? -1) + 1,
            timestamp,
          ],
        );
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw apiError("VALIDATION_FAILED", `Milestone ${name} already exists in this project`);
    }
    throw error;
  }
  const row = await getPostgresMilestone(persistence, id, context);
  if (!row) throw new Error("PostgreSQL milestone insert returned no row");
  return row;
}

export async function updatePostgresMilestone(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  input: {
    name?: string | null;
    description?: string | null;
    targetDate?: string | null;
    position?: number | null;
  },
  context?: PostgresWorkspaceContext,
): Promise<PostgresMilestoneRow> {
  const milestone = await getPostgresMilestone(persistence, id, context);
  if (!milestone) throw apiError("NOT_FOUND", "Milestone not found");
  await assertPostgresMilestoneAccess(persistence, viewer, milestone.project_id, context);
  validatePosition(input.position);
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const push = (column: string, value: SqlValue) => {
    sets.push(`${column} = $${params.length + 1}`);
    params.push(value);
  };
  if (input.name !== undefined && input.name !== null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Milestone name cannot be empty");
    push("name", name);
  }
  if (input.description !== undefined) push("description", input.description);
  if (input.targetDate !== undefined) push("target_date", input.targetDate);
  if (input.position !== undefined && input.position !== null) push("position", input.position);
  if (sets.length) {
    push("updated_at", now());
    params.push(id);
    try {
      const row = await persistence.one<PostgresMilestoneRow>(
        `UPDATE milestones SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (!row) throw apiError("NOT_FOUND", "Milestone not found");
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw apiError("VALIDATION_FAILED", "Milestone name already exists in this project");
      }
      throw error;
    }
  }
  return (await getPostgresMilestone(persistence, id, context))!;
}

async function preserveMilestoneActivityReferences(
  tx: PersistenceTransaction,
  milestoneId: string,
  reference: string,
): Promise<void> {
  const activities = await tx.many<{ id: string; payload: string }>(
    "SELECT id, payload FROM activity WHERE type IN ('milestone_changed', 'created')",
  );
  for (const activity of activities) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(activity.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    let changed = false;
    for (const field of ["from", "to", "milestoneId"]) {
      if (payload[field] === milestoneId) {
        payload[field] = reference;
        changed = true;
      }
    }
    if (changed) {
      await tx.execute("UPDATE activity SET payload = $1 WHERE id = $2", [
        JSON.stringify(payload),
        activity.id,
      ]);
    }
  }
}

async function recordPostgresActivity(
  tx: PersistenceTransaction,
  issueId: string,
  actorId: string,
  payload: Record<string, unknown>,
  createdAt: string,
): Promise<void> {
  await tx.execute(
    `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
     VALUES ($1, $2, $3, 'milestone_changed', $4, $5)`,
    [newId(), issueId, actorId, JSON.stringify(payload), createdAt],
  );
}

export async function deletePostgresMilestone(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  context?: PostgresWorkspaceContext,
): Promise<number> {
  const milestone = await getPostgresMilestone(persistence, id, context);
  if (!milestone) throw apiError("NOT_FOUND", "Milestone not found");
  await assertPostgresMilestoneAccess(persistence, viewer, milestone.project_id, context);
  const project = await getPostgresProject(persistence, milestone.project_id, context);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  const reference = `${project.name}/${milestone.name}`;
  let affected = 0;
  await persistence.transaction(async (tx) => {
    const timestamp = now();
    const issues = await tx.many<{ id: string }>(
      `UPDATE issues SET milestone_id = NULL, updated_at = $1
       WHERE milestone_id = $2
       RETURNING id`,
      [timestamp, id],
    );
    affected = issues.length;
    for (const issue of issues) {
      await recordPostgresActivity(
        tx,
        issue.id,
        viewer.id,
        { from: reference, to: null, reason: "milestone_deleted" },
        timestamp,
      );
    }

    await preserveMilestoneActivityReferences(tx, id, reference);
    await tx.execute("DELETE FROM milestones WHERE id = $1", [id]);
  });
  return affected;
}

export async function assertPostgresMilestoneMatchesProject(
  persistence: Persistence | PersistenceTransaction,
  milestoneId: string,
  projectId: string | null,
  context?: PostgresWorkspaceContext,
): Promise<void> {
  const milestone = await getPostgresMilestone(persistence, milestoneId, context);
  if (!milestone) throw apiError("NOT_FOUND", "Milestone not found");
  if (!projectId) {
    throw apiError("VALIDATION_FAILED", "Issue must belong to a project to have a milestone");
  }
  if (milestone.project_id !== projectId) {
    throw apiError("VALIDATION_FAILED", "Milestone belongs to a different project");
  }
}

export async function canAccessPostgresMilestone(
  persistence: Persistence,
  viewer: ActorRow,
  milestoneId: string,
  context?: PostgresWorkspaceContext,
): Promise<boolean> {
  const milestone = await getPostgresMilestone(persistence, milestoneId, context);
  return Boolean(
    milestone && (await canAccessPostgresProject(persistence, viewer, milestone.project_id)),
  );
}
