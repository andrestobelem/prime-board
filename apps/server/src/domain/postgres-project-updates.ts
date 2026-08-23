import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { assertCanManagePostgresProject, canAccessPostgresProject } from "./postgres-projects.ts";
import { getPostgresActor } from "./postgres-actors.ts";
import type { ActorRow } from "../auth/viewer.ts";
import type { ProjectUpdateHealth } from "./project-updates.ts";

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
): Promise<PostgresProjectUpdateRow | null> {
  return persistence.one<PostgresProjectUpdateRow>("SELECT * FROM project_updates WHERE id = $1", [
    id,
  ]);
}

export async function listPostgresProjectUpdates(
  persistence: Persistence,
  projectId: string,
): Promise<readonly PostgresProjectUpdateRow[]> {
  return persistence.many<PostgresProjectUpdateRow>(
    "SELECT * FROM project_updates WHERE project_id = $1 ORDER BY created_at DESC, id DESC",
    [projectId],
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
  const row = await getPostgresProjectUpdate(persistence, id);
  if (!row) throw new Error("PostgreSQL project update insert returned no row");
  return row;
}

export async function deletePostgresProjectUpdate(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
): Promise<boolean> {
  const existing = await getPostgresProjectUpdate(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "Project update not found");
  await assertProjectUpdateAccess(persistence, viewer, existing.project_id);
  await persistence.execute("DELETE FROM project_updates WHERE id = $1", [id]);
  return true;
}

export async function canAccessPostgresProjectUpdate(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
): Promise<boolean> {
  const update = await getPostgresProjectUpdate(persistence, id);
  return Boolean(
    update && (await canAccessPostgresProject(persistence, viewer, update.project_id)),
  );
}
