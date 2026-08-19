import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import type { ApiKeyRow, ApiKeyScope } from "./actors.ts";

const HISTORICAL_AGENT_NAMES = new Set(["claude", "demo-agent", "linear"]);
const API_KEY_SCOPES: readonly ApiKeyScope[] = ["read", "write", "admin"];

function assertNotReactivatingHistorical(name: string, existingName?: string): void {
  const normalized = name.toLowerCase();
  if (!HISTORICAL_AGENT_NAMES.has(normalized)) return;
  if (existingName?.toLowerCase() === normalized) return;
  throw apiError("VALIDATION_FAILED", `Cannot reuse historical agent name "${name}"`);
}

export function mapPostgresActor(row: ActorRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    type: row.type,
    workspaceRole: row.workspace_role,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function getPostgresActor(
  persistence: Persistence,
  id: string,
): Promise<ActorRow | null> {
  return persistence.one<ActorRow>("SELECT * FROM actors WHERE id = $1", [id]);
}

export async function listPostgresActors(
  persistence: Persistence,
  type?: string | null,
): Promise<ActorRow[]> {
  if (type) {
    return [
      ...(await persistence.many<ActorRow>(
        "SELECT * FROM actors WHERE type = $1 ORDER BY created_at",
        [type],
      )),
    ];
  }
  return [...(await persistence.many<ActorRow>("SELECT * FROM actors ORDER BY created_at"))];
}

export async function createPostgresActor(
  persistence: Persistence,
  input: { name: string; type: string; email?: string | null },
): Promise<ActorRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Actor name cannot be empty");
  if (input.type !== "human" && input.type !== "agent") {
    throw apiError("VALIDATION_FAILED", `Invalid actor type: ${input.type}`);
  }
  assertNotReactivatingHistorical(name);
  if (await persistence.one("SELECT id FROM actors WHERE lower(name) = lower($1)", [name])) {
    throw apiError("VALIDATION_FAILED", "Actor name already exists");
  }
  const id = newId();
  const timestamp = now();
  const row = await persistence.one<ActorRow>(
    `INSERT INTO actors (id, name, email, type, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING *`,
    [id, name, input.email ?? null, input.type, timestamp],
  );
  if (!row) throw new Error("PostgreSQL actor insert returned no row");
  return row;
}

export async function updatePostgresActor(
  persistence: Persistence,
  id: string,
  input: { name?: string | null; email?: string | null },
): Promise<ActorRow> {
  const existing = await getPostgresActor(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "Actor not found");
  const name = input.name === undefined || input.name === null ? existing.name : input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Actor name cannot be empty");
  assertNotReactivatingHistorical(name, existing.name);
  if (
    await persistence.one("SELECT id FROM actors WHERE lower(name) = lower($1) AND id <> $2", [
      name,
      id,
    ])
  ) {
    throw apiError("VALIDATION_FAILED", "Actor name already exists");
  }
  const email = input.email === undefined ? existing.email : input.email?.trim() || null;
  const row = await persistence.one<ActorRow>(
    `UPDATE actors SET name = $1, email = $2, updated_at = $3 WHERE id = $4 RETURNING *`,
    [name, email, now(), id],
  );
  if (!row) throw apiError("NOT_FOUND", "Actor not found");
  return row;
}

async function actorOrNotFound(persistence: Persistence, id: string): Promise<ActorRow> {
  const actor = await getPostgresActor(persistence, id);
  if (!actor) throw apiError("NOT_FOUND", "Actor not found");
  return actor;
}

async function activeAdminCount(persistence: PersistenceTransaction): Promise<number> {
  const rows = await persistence.many<{ id: string }>(
    "SELECT id FROM actors WHERE workspace_role = 'admin' AND status = 'active' FOR UPDATE",
  );
  return rows.length;
}

export async function suspendPostgresActor(
  persistence: Persistence,
  id: string,
  suspendedBy: string,
): Promise<ActorRow> {
  return persistence.transaction(async (tx) => {
    const actor = await tx.one<ActorRow>("SELECT * FROM actors WHERE id = $1 FOR UPDATE", [id]);
    if (!actor) throw apiError("NOT_FOUND", "Actor not found");
    if (actor.status === "left")
      throw apiError("VALIDATION_FAILED", "A left actor cannot be suspended");
    if (actor.status === "suspended") return actor;
    if (actor.workspace_role === "admin" && (await activeAdminCount(tx)) <= 1) {
      throw apiError("VALIDATION_FAILED", "Cannot suspend the last workspace admin");
    }
    const timestamp = now();
    const row = await tx.one<ActorRow>(
      `UPDATE actors SET status = 'suspended', suspended_at = $1, suspended_by = $2, updated_at = $1
       WHERE id = $3 RETURNING *`,
      [timestamp, suspendedBy, id],
    );
    if (!row) throw apiError("NOT_FOUND", "Actor not found");
    return row;
  });
}

export async function reactivatePostgresActor(
  persistence: Persistence,
  id: string,
): Promise<ActorRow> {
  const actor = await actorOrNotFound(persistence, id);
  if (actor.status === "left")
    throw apiError("VALIDATION_FAILED", "A left actor cannot be reactivated");
  if (actor.status === "active") return actor;
  const row = await persistence.one<ActorRow>(
    `UPDATE actors SET status = 'active', suspended_at = NULL, suspended_by = NULL, updated_at = $1
     WHERE id = $2 RETURNING *`,
    [now(), id],
  );
  if (!row) throw apiError("NOT_FOUND", "Actor not found");
  return row;
}

export async function revokePostgresActor(persistence: Persistence, id: string): Promise<ActorRow> {
  return markPostgresActorLeft(persistence, id);
}

export async function leavePostgresActor(persistence: Persistence, id: string): Promise<ActorRow> {
  return markPostgresActorLeft(persistence, id);
}

async function markPostgresActorLeft(persistence: Persistence, id: string): Promise<ActorRow> {
  return persistence.transaction(async (tx) => {
    const actor = await tx.one<ActorRow>("SELECT * FROM actors WHERE id = $1 FOR UPDATE", [id]);
    if (!actor) throw apiError("NOT_FOUND", "Actor not found");
    if (actor.status === "left") return actor;
    if (
      actor.status === "active" &&
      actor.workspace_role === "admin" &&
      (await activeAdminCount(tx)) <= 1
    ) {
      throw apiError("VALIDATION_FAILED", "Cannot revoke the last workspace admin");
    }
    const timestamp = now();
    const row = await tx.one<ActorRow>(
      `UPDATE actors SET status = 'left', left_at = $1, updated_at = $1 WHERE id = $2 RETURNING *`,
      [timestamp, id],
    );
    await tx.execute(
      "UPDATE api_keys SET revoked_at = $1 WHERE actor_id = $2 AND revoked_at IS NULL",
      [timestamp, id],
    );
    if (!row) throw apiError("NOT_FOUND", "Actor not found");
    return row;
  });
}

export async function getPostgresWorkspace(persistence: Persistence, id?: string | null) {
  return persistence.one<{
    id: string;
    name: string;
    url_key: string;
    created_at: string;
    updated_at: string;
  }>(
    id
      ? "SELECT id, name, url_key, created_at, updated_at FROM workspace WHERE id = $1"
      : "SELECT id, name, url_key, created_at, updated_at FROM workspace LIMIT 1",
    id ? [id] : undefined,
  );
}

export async function updatePostgresWorkspace(
  persistence: Persistence,
  input: { name: string },
  workspaceId?: string,
) {
  const workspace = await getPostgresWorkspace(persistence, workspaceId);
  if (!workspace) throw apiError("NOT_FOUND", "Workspace is not initialized");
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Workspace name cannot be empty");
  const row = await persistence.one<typeof workspace>(
    "UPDATE workspace SET name = $1, updated_at = $2 WHERE id = $3 RETURNING id, name, url_key, created_at, updated_at",
    [name, now(), workspace.id],
  );
  if (!row) throw apiError("NOT_FOUND", "Workspace is not initialized");
  return row;
}

export interface PostgresApiKeyView extends ApiKeyRow {
  scopes: ApiKeyScope[];
  teamIds: string[];
}

export async function listPostgresApiKeys(
  persistence: Persistence,
  actorId: string,
): Promise<PostgresApiKeyView[]> {
  const rows = await persistence.many<ApiKeyRow>(
    "SELECT * FROM api_keys WHERE actor_id = $1 AND revoked_at IS NULL ORDER BY created_at",
    [actorId],
  );
  const result: PostgresApiKeyView[] = [];
  for (const row of rows) {
    const scopes = await persistence.many<{ scope: ApiKeyScope }>(
      "SELECT scope FROM api_key_scopes WHERE api_key_id = $1 ORDER BY CASE scope WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 END",
      [row.id],
    );
    const teamIds = await persistence.many<{ team_id: string }>(
      "SELECT team_id FROM api_key_team_limits WHERE api_key_id = $1 ORDER BY team_id",
      [row.id],
    );
    result.push({
      ...row,
      scopes: scopes.length ? scopes.map((scope) => scope.scope) : [...API_KEY_SCOPES],
      teamIds: teamIds.map((team) => team.team_id),
    });
  }
  return result;
}

export function mapPostgresApiKey(row: PostgresApiKeyView) {
  return {
    id: row.id,
    name: row.name,
    actorId: row.actor_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    rotatedFromId: row.rotated_from_id,
    scopes: row.scopes,
    teamIds: row.teamIds,
  };
}
