import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { assertCanManagePostgresProject, canAccessPostgresProject } from "./postgres-projects.ts";
import { getPostgresActor } from "./postgres-actors.ts";
import type { ActorRow } from "../auth/viewer.ts";
import type { ProjectUpdateHealth } from "./project-updates.ts";
import type { PostgresWorkspaceContext } from "./postgres-workspace-scope.ts";
import {
  projectWorkspaceScope,
  scopedWorkspacePredicate,
  workspaceIdOf,
} from "./postgres-workspace-scope.ts";

export interface PostgresProjectUpdateRow {
  id: string;
  project_id: string;
  author_id: string;
  health: ProjectUpdateHealth;
  body: string;
  risks: string | null;
  created_at: string;
  updated_at: string;
}

export function mapPostgresProjectUpdate(row: PostgresProjectUpdateRow) {
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

export async function getPostgresProjectUpdate(
  persistence: Persistence | PersistenceTransaction,
  id: string,
  context?: PostgresWorkspaceContext,
): Promise<PostgresProjectUpdateRow | null> {
  const scope = scopedWorkspacePredicate(
    context,
    (workspaceParam) => projectWorkspaceScope("project_updates", workspaceParam),
    "$2",
  );
  return persistence.one<PostgresProjectUpdateRow>(
    `SELECT project_updates.* FROM project_updates WHERE project_updates.id = $1 AND ${scope}`,
    [id, ...(context ? [workspaceIdOf(context)] : [])],
  );
}

export async function listPostgresProjectUpdates(
  persistence: Persistence,
  projectId: string,
  context?: PostgresWorkspaceContext,
): Promise<readonly PostgresProjectUpdateRow[]> {
  const scope = scopedWorkspacePredicate(
    context,
    (workspaceParam) => projectWorkspaceScope("project_updates", workspaceParam),
    "$2",
  );
  return persistence.many<PostgresProjectUpdateRow>(
    `SELECT project_updates.* FROM project_updates WHERE project_updates.project_id = $1 AND ${scope}
      ORDER BY project_updates.created_at DESC, project_updates.id DESC`,
    [projectId, ...(context ? [workspaceIdOf(context)] : [])],
  );
}

function resolveHealth(health: string): ProjectUpdateHealth {
  const normalized = health.toLowerCase() as ProjectUpdateHealth;
  if (!(["on_track", "at_risk", "off_track"] as string[]).includes(normalized)) {
    throw apiError("VALIDATION_FAILED", `Invalid project update health: ${health}`);
  }
  return normalized;
}

async function assertProjectUpdateAccess(
  persistence: Persistence,
  viewer: ActorRow,
  projectId: string,
): Promise<void> {
  await assertCanManagePostgresProject(persistence, viewer, projectId);
}

export async function createPostgresProjectUpdate(
  persistence: Persistence,
  viewer: ActorRow,
  input: { projectId: string; health: string; body: string; risks?: string | null },
  context?: PostgresWorkspaceContext,
): Promise<PostgresProjectUpdateRow> {
  await assertProjectUpdateAccess(persistence, viewer, input.projectId);
  const body = input.body.trim();
  if (!body) throw apiError("VALIDATION_FAILED", "Project update body cannot be empty");
  const author = await getPostgresActor(persistence, viewer.id);
  if (!author) throw apiError("NOT_FOUND", "Actor not found");
  const id = newId();
  const timestamp = now();
  await persistence.execute(
    `INSERT INTO project_updates
     (id, project_id, author_id, health, body, risks, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      id,
      input.projectId,
      viewer.id,
      resolveHealth(input.health),
      body,
      input.risks?.trim() || null,
      timestamp,
    ],
  );
  const row = await getPostgresProjectUpdate(persistence, id, context);
  if (!row) throw new Error("PostgreSQL project update insert returned no row");
  return row;
}

export async function deletePostgresProjectUpdate(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  context?: PostgresWorkspaceContext,
): Promise<boolean> {
  const existing = await getPostgresProjectUpdate(persistence, id, context);
  if (!existing) throw apiError("NOT_FOUND", "Project update not found");
  await assertProjectUpdateAccess(persistence, viewer, existing.project_id);
  await persistence.execute("DELETE FROM project_updates WHERE id = $1", [id]);
  return true;
}

export async function canAccessPostgresProjectUpdate(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  context?: PostgresWorkspaceContext,
): Promise<boolean> {
  const update = await getPostgresProjectUpdate(persistence, id, context);
  return Boolean(
    update && (await canAccessPostgresProject(persistence, viewer, update.project_id)),
  );
}
