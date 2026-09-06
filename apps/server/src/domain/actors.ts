// Dominio de actores (humanos y agentes) y sus API keys.
import type { Database } from "bun:sqlite";
import type { ActorRow } from "../auth/viewer.ts";
import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";

/** Nombres de agentes históricos (import/demo): no deben reactivarse. */
const HISTORICAL_AGENT_NAMES = new Set(["claude", "demo-agent", "linear"]);

function assertNotReactivatingHistorical(name: string, existingName?: string): void {
  const normalized = name.toLowerCase();
  if (!HISTORICAL_AGENT_NAMES.has(normalized)) return;
  if (existingName && existingName.toLowerCase() === normalized) return;
  throw apiError("VALIDATION_FAILED", `Cannot reuse historical agent name "${name}"`);
}

export function mapActor(row: ActorRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    type: row.type,
    workspaceRole: row.workspace_role,
    status: row.status,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  };
}

/** Normaliza el avatar del perfil sin aceptar valores enormes ni espacios. */
export function normalizeAvatarUrl(value: unknown, current: string | null): string | null {
  if (value === undefined) return current;
  if (value !== null && typeof value !== "string") {
    throw apiError("VALIDATION_FAILED", "Avatar URL must be a string");
  }
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > 2048) {
    throw apiError("VALIDATION_FAILED", "Avatar URL cannot exceed 2048 characters");
  }
  if (normalized) {
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw apiError("VALIDATION_FAILED", "Avatar URL must be an absolute HTTP(S) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw apiError("VALIDATION_FAILED", "Avatar URL must use HTTP or HTTPS");
    }
  }
  return normalized;
}

export function getActor(db: Database, id: string): ActorRow | null {
  return db.query("SELECT * FROM actors WHERE id = ?1").get(id) as ActorRow | null;
}

export function listActors(db: Database, type?: string | null): ActorRow[] {
  if (type) {
    return db
      .query("SELECT * FROM actors WHERE type = ?1 ORDER BY created_at")
      .all(type) as ActorRow[];
  }
  return db.query("SELECT * FROM actors ORDER BY created_at").all() as ActorRow[];
}

export function createActor(
  db: Database,
  input: { name: string; type: string; email?: string | null; avatarUrl?: string | null },
): ActorRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Actor name cannot be empty");
  if (input.type !== "human" && input.type !== "agent") {
    throw apiError("VALIDATION_FAILED", `Invalid actor type: ${input.type}`);
  }
  assertNotReactivatingHistorical(name);
  const duplicate = db.query("SELECT id FROM actors WHERE lower(name) = lower(?1)").get(name);
  if (duplicate) throw apiError("VALIDATION_FAILED", "Actor name already exists");
  const id = newId();
  const timestamp = now();
  db.query(
    "INSERT INTO actors (id, name, email, type, avatar_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  ).run(
    id,
    name,
    input.email?.trim() || null,
    input.type,
    normalizeAvatarUrl(input.avatarUrl, null),
    timestamp,
    timestamp,
  );
  return getActor(db, id)!;
}

export function updateActor(
  db: Database,
  id: string,
  input: { name?: string | null; email?: string | null; avatarUrl?: string | null },
): ActorRow {
  const existing = getActor(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Actor not found");

  const name = input.name === undefined || input.name === null ? existing.name : input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Actor name cannot be empty");
  assertNotReactivatingHistorical(name, existing.name);
  const duplicate = db
    .query("SELECT id FROM actors WHERE lower(name) = lower(?1) AND id <> ?2")
    .get(name, id);
  if (duplicate) throw apiError("VALIDATION_FAILED", "Actor name already exists");

  const email = input.email === undefined ? existing.email : input.email?.trim() || null;
  const avatarUrl = normalizeAvatarUrl(input.avatarUrl, existing.avatar_url);
  db.query(
    "UPDATE actors SET name = ?1, email = ?2, avatar_url = ?3, updated_at = ?4 WHERE id = ?5",
  ).run(name, email, avatarUrl, now(), id);
  return getActor(db, id)!;
}

export type ApiKeyScope = "read" | "write" | "admin";
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ["read", "write", "admin"];

export interface ApiKeyRow {
  id: string;
  actor_id: string;
  name: string;
  hash: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  rotated_from_id: string | null;
  created_at: string;
}

export interface ApiKeyMetadata {
  scopes: ApiKeyScope[];
  teamIds: string[];
}

export function listApiKeyScopes(db: Database, keyId: string): ApiKeyScope[] {
  const scopes = db
    .query(
      "SELECT scope FROM api_key_scopes WHERE api_key_id = ?1 ORDER BY CASE scope WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 END",
    )
    .all(keyId)
    .map((row) => (row as { scope: ApiKeyScope }).scope);
  return scopes.length ? scopes : [...API_KEY_SCOPES];
}

export function listApiKeyTeamIds(db: Database, keyId: string, workspaceId?: string): string[] {
  const query = workspaceId
    ? "SELECT team_id FROM api_key_team_limits WHERE api_key_id = ?1 AND workspace_id = ?2 ORDER BY team_id"
    : "SELECT team_id FROM api_key_team_limits WHERE api_key_id = ?1 ORDER BY team_id";
  const rows = workspaceId ? db.query(query).all(keyId, workspaceId) : db.query(query).all(keyId);
  return rows.map((row) => (row as { team_id: string }).team_id);
}

export function mapApiKey(row: ApiKeyRow, db?: Database, workspaceId?: string) {
  return {
    id: row.id,
    name: row.name,
    actorId: row.actor_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    rotatedFromId: row.rotated_from_id,
    scopes: db ? listApiKeyScopes(db, row.id) : [],
    teamIds: db ? listApiKeyTeamIds(db, row.id, workspaceId) : [],
  };
}

export function listApiKeys(
  db: Database,
  actorId: string,
  includeRevoked = false,
  workspaceId?: string,
): ApiKeyRow[] {
  const query = workspaceId
    ? `SELECT api_keys.* FROM api_keys
       JOIN api_key_workspaces grants
         ON grants.api_key_id = api_keys.id AND grants.workspace_id = ?2
       WHERE api_keys.actor_id = ?1
       ${includeRevoked ? "" : "AND api_keys.revoked_at IS NULL"}
       ORDER BY api_keys.created_at`
    : `SELECT * FROM api_keys WHERE actor_id = ?1
       ${includeRevoked ? "" : "AND revoked_at IS NULL"}
       ORDER BY created_at`;
  return (
    workspaceId ? db.query(query).all(actorId, workspaceId) : db.query(query).all(actorId)
  ) as ApiKeyRow[];
}

export function getApiKey(db: Database, id: string): ApiKeyRow | null {
  return db.query("SELECT * FROM api_keys WHERE id = ?1").get(id) as ApiKeyRow | null;
}

export function deleteApiKey(db: Database, id: string, workspaceId?: string): boolean {
  const existing = db.query("SELECT id, revoked_at FROM api_keys WHERE id = ?1").get(id) as {
    id: string;
    revoked_at: string | null;
  } | null;
  if (!existing) throw apiError("NOT_FOUND", "API key not found");
  if (!workspaceId) {
    if (!existing.revoked_at) {
      db.query("UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2").run(now(), id);
    }
    return true;
  }

  const resolvedWorkspaceId = resolveApiKeyWorkspace(db, workspaceId);
  if (
    !db
      .query("SELECT 1 FROM api_key_workspaces WHERE api_key_id = ?1 AND workspace_id = ?2")
      .get(id, resolvedWorkspaceId)
  ) {
    throw apiError("NOT_FOUND", "API key is not available in this Workspace");
  }
  const timestamp = now();
  db.transaction(() => {
    db.query("DELETE FROM api_key_team_limits WHERE api_key_id = ?1 AND workspace_id = ?2").run(
      id,
      resolvedWorkspaceId,
    );
    db.query("DELETE FROM api_key_workspaces WHERE api_key_id = ?1 AND workspace_id = ?2").run(
      id,
      resolvedWorkspaceId,
    );
    db.query(
      `UPDATE api_keys SET revoked_at = ?1
       WHERE id = ?2 AND revoked_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM api_key_workspaces WHERE api_key_id = ?2)`,
    ).run(timestamp, id);
  })();
  return true;
}

function normalizeApiKeyScopes(scopes: readonly string[] | null | undefined): ApiKeyScope[] {
  const values =
    scopes == null || scopes.length === 0
      ? [...API_KEY_SCOPES]
      : scopes.map((scope) => scope.toLowerCase());
  const unique = [...new Set(values)];
  if (unique.some((scope) => !API_KEY_SCOPES.includes(scope as ApiKeyScope))) {
    throw apiError("VALIDATION_FAILED", "API key scopes must be READ, WRITE or ADMIN");
  }
  return API_KEY_SCOPES.filter((scope) => unique.includes(scope));
}

function resolveApiKeyWorkspace(db: Database, workspaceId?: string): string {
  if (workspaceId) {
    const workspace = db.query("SELECT id FROM workspace WHERE id = ?1").get(workspaceId);
    if (!workspace) throw apiError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
    return workspaceId;
  }
  const workspaces = db.query("SELECT id FROM workspace ORDER BY created_at, id").all() as Array<{
    id: string;
  }>;
  if (workspaces.length !== 1) {
    throw apiError("VALIDATION_FAILED", "Workspace context is required");
  }
  return workspaces[0]!.id;
}

function normalizeApiKeyTeamIds(
  db: Database,
  teamIds: readonly string[] | null | undefined,
  workspaceId: string,
): string[] {
  if (teamIds == null || teamIds.length === 0) return [];
  const unique = [...new Set(teamIds)];
  for (const teamId of unique) {
    if (
      !db.query("SELECT id FROM teams WHERE id = ?1 AND workspace_id = ?2").get(teamId, workspaceId)
    ) {
      throw apiError("NOT_FOUND", `Team not found: ${teamId}`);
    }
  }
  return unique.sort();
}

function normalizeApiKeyExpiry(expiresAt: string | null | undefined): string | null {
  if (expiresAt == null) return null;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw apiError("VALIDATION_FAILED", "API key expiration must be a valid future ISO-8601 date");
  }
  return new Date(timestamp).toISOString();
}

export function apiKeyMetadata(
  db: Database,
  input: {
    scopes?: readonly string[] | null;
    teamIds?: readonly string[] | null;
    expiresAt?: string | null;
  },
  workspaceId?: string,
): { scopes: ApiKeyScope[]; teamIds: string[]; expiresAt: string | null } {
  const resolvedWorkspaceId = resolveApiKeyWorkspace(db, workspaceId);
  return {
    scopes: normalizeApiKeyScopes(input.scopes),
    teamIds: normalizeApiKeyTeamIds(db, input.teamIds, resolvedWorkspaceId),
    expiresAt: normalizeApiKeyExpiry(input.expiresAt),
  };
}

function insertApiKeyMetadata(
  db: Database,
  keyId: string,
  metadata: ApiKeyMetadata,
  workspaceId: string,
  createdAt: string,
): void {
  const scopeInsert = db.query("INSERT INTO api_key_scopes (api_key_id, scope) VALUES (?1, ?2)");
  for (const scope of metadata.scopes) scopeInsert.run(keyId, scope);
  const teamInsert = db.query(
    "INSERT INTO api_key_team_limits (api_key_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
  );
  for (const teamId of metadata.teamIds) teamInsert.run(keyId, teamId, workspaceId);
  db.query(
    `INSERT OR IGNORE INTO api_key_workspaces
     (api_key_id, workspace_id, is_default, created_at)
     VALUES (?1, ?2, 1, ?3)`,
  ).run(keyId, workspaceId, createdAt);
}

/** Crea una key para un actor. Devuelve la key en claro UNA sola vez. */
export function createApiKey(
  db: Database,
  input: {
    actorId: string;
    name: string;
    scopes?: readonly string[] | null;
    teamIds?: readonly string[] | null;
    expiresAt?: string | null;
    rotatedFromId?: string | null;
    workspaceId?: string;
  },
): { row: ApiKeyRow; key: string } {
  const workspaceId = resolveApiKeyWorkspace(db, input.workspaceId);
  const actor = getActor(db, input.actorId);
  if (!actor) throw apiError("NOT_FOUND", "Actor not found");
  const membership = db
    .query("SELECT status FROM workspace_memberships WHERE workspace_id = ?1 AND actor_id = ?2")
    .get(workspaceId, input.actorId) as { status: "active" | "suspended" | "left" } | null;
  if (!membership) throw apiError("NOT_FOUND", "Actor not found in this Workspace");
  if (membership.status !== "active") {
    throw apiError("UNAUTHORIZED", "Only active actors can receive API keys");
  }
  if (!input.name.trim()) throw apiError("VALIDATION_FAILED", "API key name cannot be empty");
  const metadata = apiKeyMetadata(db, input, workspaceId);
  const key = generateApiKey();
  const id = newId();
  const createdAt = now();
  let row: ApiKeyRow;
  db.transaction(() => {
    db.query(
      "INSERT INTO api_keys (id, actor_id, name, hash, expires_at, rotated_from_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).run(
      id,
      input.actorId,
      input.name.trim(),
      hashApiKey(key),
      metadata.expiresAt,
      input.rotatedFromId ?? null,
      createdAt,
    );
    insertApiKeyMetadata(db, id, metadata, workspaceId, createdAt);
    row = db.query("SELECT * FROM api_keys WHERE id = ?1").get(id) as ApiKeyRow;
  })();
  return { row: row!, key };
}

/** Rota una key atómicamente: la vieja queda revocada y la nueva se entrega una vez. */
export function rotateApiKey(
  db: Database,
  id: string,
  input: {
    name?: string | null;
    scopes?: readonly string[] | null;
    teamIds?: readonly string[] | null;
    expiresAt?: string | null;
    workspaceId?: string;
  },
): { row: ApiKeyRow; key: string } {
  const existing = getApiKey(db, id);
  if (!existing) throw apiError("NOT_FOUND", "API key not found");
  if (existing.revoked_at) throw apiError("VALIDATION_FAILED", "API key is already revoked");
  const workspaceId = resolveApiKeyWorkspace(db, input.workspaceId);
  if (
    !db
      .query("SELECT 1 FROM api_key_workspaces WHERE api_key_id = ?1 AND workspace_id = ?2")
      .get(id, workspaceId)
  ) {
    throw apiError("NOT_FOUND", "API key is not available in this Workspace");
  }
  const metadata = apiKeyMetadata(
    db,
    {
      scopes: input.scopes === undefined ? listApiKeyScopes(db, id) : input.scopes,
      teamIds: input.teamIds === undefined ? listApiKeyTeamIds(db, id, workspaceId) : input.teamIds,
      expiresAt: input.expiresAt === undefined ? existing.expires_at : input.expiresAt,
    },
    workspaceId,
  );
  const key = generateApiKey();
  const replacementId = newId();
  const timestamp = now();
  db.transaction(() => {
    db.query(
      "INSERT INTO api_keys (id, actor_id, name, hash, expires_at, rotated_from_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).run(
      replacementId,
      existing.actor_id,
      input.name?.trim() || existing.name,
      hashApiKey(key),
      metadata.expiresAt,
      existing.id,
      timestamp,
    );
    insertApiKeyMetadata(db, replacementId, metadata, workspaceId, timestamp);
    db.query("DELETE FROM api_key_team_limits WHERE api_key_id = ?1 AND workspace_id = ?2").run(
      id,
      workspaceId,
    );
    db.query("DELETE FROM api_key_workspaces WHERE api_key_id = ?1 AND workspace_id = ?2").run(
      id,
      workspaceId,
    );
    db.query(
      `UPDATE api_keys SET revoked_at = ?1
       WHERE id = ?2 AND revoked_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM api_key_workspaces WHERE api_key_id = ?2)`,
    ).run(timestamp, id);
  })();
  return {
    row: db.query("SELECT * FROM api_keys WHERE id = ?1").get(replacementId) as ApiKeyRow,
    key,
  };
}

export type ActorInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface ActorInvitationRow {
  id: string;
  email: string | null;
  name: string | null;
  type: "human" | "agent" | null;
  token_hash: string;
  status: ActorInvitationStatus;
  invited_by: string;
  actor_id: string | null;
  metadata_json: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  workspace_id?: string | null;
}

function invitationStatus(db: Database, row: ActorInvitationRow): ActorInvitationRow {
  if (row.status === "pending" && Date.parse(row.expires_at) <= Date.now()) {
    const expired = db
      .query("UPDATE actor_invitations SET status = 'expired' WHERE id = ?1 AND status = 'pending'")
      .run(row.id);
    if (expired.changes === 1) return { ...row, status: "expired" };
    const current = db
      .query("SELECT * FROM actor_invitations WHERE id = ?1")
      .get(row.id) as ActorInvitationRow | null;
    return current ?? { ...row, status: "expired" };
  }
  return row;
}

export function mapActorInvitation(row: ActorInvitationRow) {
  let metadata: unknown = {};
  try {
    metadata = JSON.parse(row.metadata_json);
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    type: row.type,
    status: row.status,
    invitedById: row.invited_by,
    actorId: row.actor_id,
    metadata,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
}

export function getActorInvitation(
  db: Database,
  id: string,
  workspaceId?: string,
): ActorInvitationRow | null {
  const query = workspaceId
    ? "SELECT * FROM actor_invitations WHERE id = ?1 AND workspace_id = ?2"
    : "SELECT * FROM actor_invitations WHERE id = ?1";
  const row = (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as ActorInvitationRow | null;
  return row ? invitationStatus(db, row) : null;
}

export function listActorInvitations(
  db: Database,
  includeRevoked = false,
  workspaceId?: string,
): ActorInvitationRow[] {
  const conditions = [
    ...(workspaceId ? ["workspace_id = ?1"] : []),
    ...(!includeRevoked ? [workspaceId ? "status = 'pending'" : "status = 'pending'"] : []),
  ];
  const query = `SELECT * FROM actor_invitations
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY created_at, id`;
  const rows = (
    workspaceId ? db.query(query).all(workspaceId) : db.query(query).all()
  ) as ActorInvitationRow[];
  const current = rows.map((row) => invitationStatus(db, row));
  return includeRevoked ? current : current.filter((row) => row.status === "pending");
}

function normalizedOptional(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

export function createActorInvitation(
  db: Database,
  invitedBy: string,
  input: {
    email?: string | null;
    name?: string | null;
    type?: string | null;
    expiresAt?: string | null;
    metadata?: unknown;
  },
  workspaceId?: string,
): { row: ActorInvitationRow; token: string } {
  const resolvedWorkspaceId = resolveApiKeyWorkspace(db, workspaceId);
  const inviterMembership = db
    .query(
      `SELECT status FROM workspace_memberships
       WHERE workspace_id = ?1 AND actor_id = ?2`,
    )
    .get(resolvedWorkspaceId, invitedBy) as { status: "active" | "suspended" | "left" } | null;
  if (!inviterMembership || inviterMembership.status !== "active") {
    throw apiError("UNAUTHORIZED", "The inviter is not active in this Workspace");
  }
  const email = normalizedOptional(input.email);
  const name = normalizedOptional(input.name);
  const type = input.type?.toLowerCase() || null;
  if (type !== null && type !== "human" && type !== "agent") {
    throw apiError("VALIDATION_FAILED", `Invalid actor type: ${input.type}`);
  }
  let metadata = "{}";
  if (input.metadata !== undefined && input.metadata !== null) {
    try {
      metadata = JSON.stringify(input.metadata);
    } catch {
      throw apiError("VALIDATION_FAILED", "Invitation metadata must be valid JSON");
    }
  }
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    throw apiError("VALIDATION_FAILED", "Invitation expiration must be in the future");
  }
  const token = generateApiKey();
  const id = newId();
  const timestamp = now();
  try {
    let row: ActorInvitationRow | null = null;
    db.transaction(() => {
      if (email) {
        const existing = db
          .query(
            `SELECT id, expires_at FROM actor_invitations
             WHERE lower(email) = lower(?1) AND workspace_id = ?2 AND status = 'pending'`,
          )
          .get(email, resolvedWorkspaceId) as { id: string; expires_at: string } | null;
        if (existing && Date.parse(existing.expires_at) <= Date.now()) {
          db.query(
            "UPDATE actor_invitations SET status = 'expired' WHERE id = ?1 AND status = 'pending'",
          ).run(existing.id);
        } else if (existing) {
          throw apiError("VALIDATION_FAILED", "A pending invitation already exists for this email");
        }
      }
      db.query(
        `INSERT INTO actor_invitations
          (id, email, name, type, token_hash, status, invited_by, metadata_json, created_at, expires_at, workspace_id)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, ?10)`,
      ).run(
        id,
        email,
        name,
        type,
        hashApiKey(token),
        invitedBy,
        metadata,
        timestamp,
        expiresAt,
        resolvedWorkspaceId,
      );
      row = getActorInvitation(db, id, resolvedWorkspaceId);
    })();
    if (!row) throw new Error("Actor invitation insert returned no row");
    return { row, token };
  } catch (error) {
    // The partial unique index is the final arbiter for concurrent invitations.
    if (isUniqueViolation(error)) {
      throw apiError("VALIDATION_FAILED", "A pending invitation already exists for this email");
    }
    throw error;
  }
}

export function revokeActorInvitation(
  db: Database,
  id: string,
  workspaceId?: string,
): ActorInvitationRow {
  const resolvedWorkspaceId = resolveApiKeyWorkspace(db, workspaceId);
  const existing = getActorInvitation(db, id, resolvedWorkspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Actor invitation not found");
  if (existing.status !== "pending") {
    throw apiError("VALIDATION_FAILED", "Only pending invitations can be revoked");
  }
  const revoked = db.transaction(() =>
    db
      .query(
        `UPDATE actor_invitations
         SET status = 'revoked', revoked_at = ?1
         WHERE id = ?2 AND workspace_id = ?3 AND status = 'pending'`,
      )
      .run(now(), id, resolvedWorkspaceId),
  )();
  if (revoked.changes !== 1) {
    const current = getActorInvitation(db, id, resolvedWorkspaceId);
    if (!current) throw apiError("NOT_FOUND", "Actor invitation not found");
    throw apiError("VALIDATION_FAILED", "Only pending invitations can be revoked");
  }
  return getActorInvitation(db, id, resolvedWorkspaceId)!;
}

export function acceptActorInvitation(
  db: Database,
  token: string,
  input: { name?: string | null; type?: string | null },
  workspaceId?: string,
): { actor: ActorRow; invitation: ActorInvitationRow; key: string } {
  const resolvedWorkspaceId = resolveApiKeyWorkspace(db, workspaceId);
  let result: { actor: ActorRow; invitation: ActorInvitationRow; key: string } | null = null;
  db.transaction(() => {
    const row = db
      .query("SELECT * FROM actor_invitations WHERE token_hash = ?1 AND workspace_id = ?2")
      .get(hashApiKey(token), resolvedWorkspaceId) as ActorInvitationRow | null;
    if (!row) throw apiError("UNAUTHORIZED", "Invalid actor invitation token");
    if (row.status !== "pending" || Date.parse(row.expires_at) <= Date.now()) {
      if (row.status === "pending") {
        db.query(
          "UPDATE actor_invitations SET status = 'expired' WHERE id = ?1 AND status = 'pending'",
        ).run(row.id);
      }
      throw apiError("UNAUTHORIZED", "Invalid actor invitation token");
    }

    // Reserve the invitation in the same transaction. This prevents concurrent
    // acceptance from creating two identities or credentials for one token.
    const reserved = db
      .query(
        `UPDATE actor_invitations
         SET status = 'accepted'
         WHERE id = ?1 AND workspace_id = ?2 AND status = 'pending'`,
      )
      .run(row.id, resolvedWorkspaceId);
    if (reserved.changes !== 1) {
      throw apiError("UNAUTHORIZED", "Invalid actor invitation token");
    }

    const requestedName =
      normalizedOptional(input.name) ?? row.name ?? (row.email ? row.email.split("@")[0] : null);
    const type = (input.type ?? row.type ?? "human").toLowerCase();
    if (type !== "human" && type !== "agent") {
      throw apiError("VALIDATION_FAILED", `Invalid actor type: ${input.type}`);
    }

    // Actor identity is global. An email invitation reuses an existing Actor,
    // then adds only the Membership in the inviting Workspace.
    const existing = row.email
      ? (db
          .query(
            `SELECT * FROM actors
             WHERE email IS NOT NULL AND lower(email) = lower(?1)
             ORDER BY created_at, id LIMIT 1`,
          )
          .get(row.email) as ActorRow | null)
      : null;
    let actor: ActorRow;
    if (existing) {
      actor = existing;
    } else {
      if (!requestedName) {
        throw apiError("VALIDATION_FAILED", "Actor name is required to accept an invitation");
      }
      actor = createActor(db, { name: requestedName, type, email: row.email });
    }

    const invitationWorkspaceId = row.workspace_id ?? resolvedWorkspaceId;
    const timestamp = now();
    db.query(
      `INSERT INTO workspace_memberships
       (id, workspace_id, actor_id, role, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'member', 'active', ?4, ?4)
       ON CONFLICT (workspace_id, actor_id) DO NOTHING`,
    ).run(newId(), invitationWorkspaceId, actor.id, timestamp);
    const { key } = createApiKey(db, {
      actorId: actor.id,
      name: "invitation key",
      workspaceId: invitationWorkspaceId,
    });
    db.query(
      `UPDATE actor_invitations
       SET actor_id = ?1, accepted_at = ?2
       WHERE id = ?3 AND workspace_id = ?4`,
    ).run(actor.id, timestamp, row.id, invitationWorkspaceId);
    result = {
      actor: actorInWorkspace(db, actor.id, invitationWorkspaceId),
      invitation: getActorInvitation(db, row.id, invitationWorkspaceId)!,
      key,
    };
  })();
  return result!;
}

function activeAdminCount(db: Database): number {
  const row = db
    .query(
      "SELECT count(*) AS count FROM actors WHERE workspace_role = 'admin' AND status = 'active'",
    )
    .get() as { count: number };
  return row.count;
}

interface ActorWorkspaceMembershipRow {
  workspace_id: string;
  actor_id: string;
  role: "admin" | "member";
  status: "active" | "suspended" | "left";
  suspended_at: string | null;
  suspended_by: string | null;
  left_at: string | null;
  updated_at: string;
}

function actorWorkspaceMembership(
  db: Database,
  actorId: string,
  workspaceId: string,
): ActorWorkspaceMembershipRow | null {
  return db
    .query(
      `SELECT workspace_id, actor_id, role, status, suspended_at, suspended_by, left_at, updated_at
       FROM workspace_memberships
       WHERE actor_id = ?1 AND workspace_id = ?2`,
    )
    .get(actorId, workspaceId) as ActorWorkspaceMembershipRow | null;
}

function actorInWorkspace(db: Database, actorId: string, workspaceId: string): ActorRow {
  const actor = actorOrNotFound(db, actorId);
  const membership = actorWorkspaceMembership(db, actorId, workspaceId);
  if (!membership) throw apiError("NOT_FOUND", "Actor not found");
  return { ...actor, workspace_role: membership.role, status: membership.status };
}

function activeWorkspaceAdminCount(db: Database, workspaceId: string): number {
  const row = db
    .query(
      `SELECT count(*) AS count FROM workspace_memberships
       WHERE workspace_id = ?1 AND role = 'admin' AND status = 'active'`,
    )
    .get(workspaceId) as { count: number };
  return row.count;
}

/** Keeps legacy actor status useful while the database still has one Workspace. */
function syncLegacyActorStatus(
  db: Database,
  actorId: string,
  membership: ActorWorkspaceMembershipRow,
): void {
  const row = db.query("SELECT count(*) AS count FROM workspace").get() as { count: number };
  if (row.count !== 1) return;
  db.query(
    `UPDATE actors
     SET status = ?1, suspended_at = ?2, suspended_by = ?3, left_at = ?4, updated_at = ?5
     WHERE id = ?6`,
  ).run(
    membership.status,
    membership.suspended_at,
    membership.suspended_by,
    membership.left_at,
    membership.updated_at,
    actorId,
  );
}

function actorOrNotFound(db: Database, id: string): ActorRow {
  const actor = getActor(db, id);
  if (!actor) throw apiError("NOT_FOUND", "Actor not found");
  return actor;
}

export function suspendActor(
  db: Database,
  id: string,
  suspendedBy: string,
  workspaceId?: string,
): ActorRow {
  if (workspaceId) {
    return db.transaction(() => {
      const membership = actorWorkspaceMembership(db, id, workspaceId);
      if (!membership) throw apiError("NOT_FOUND", "Actor not found");
      if (membership.status === "left")
        throw apiError("VALIDATION_FAILED", "A left actor cannot be suspended");
      if (membership.status === "suspended") return actorInWorkspace(db, id, workspaceId);
      if (membership.role === "admin" && activeWorkspaceAdminCount(db, workspaceId) <= 1) {
        throw apiError("VALIDATION_FAILED", "Cannot suspend the last workspace admin");
      }
      const timestamp = now();
      db.query(
        `UPDATE workspace_memberships
         SET status = 'suspended', suspended_at = ?1, suspended_by = ?2, left_at = NULL, updated_at = ?1
         WHERE actor_id = ?3 AND workspace_id = ?4`,
      ).run(timestamp, suspendedBy, id, workspaceId);
      const updated = actorWorkspaceMembership(db, id, workspaceId)!;
      syncLegacyActorStatus(db, id, updated);
      return actorInWorkspace(db, id, workspaceId);
    })();
  }

  const actor = actorOrNotFound(db, id);
  if (actor.status === "left")
    throw apiError("VALIDATION_FAILED", "A left actor cannot be suspended");
  if (actor.status === "suspended") return actor;
  if (actor.workspace_role === "admin" && activeAdminCount(db) <= 1) {
    throw apiError("VALIDATION_FAILED", "Cannot suspend the last workspace admin");
  }
  const timestamp = now();
  db.query(
    "UPDATE actors SET status = 'suspended', suspended_at = ?1, suspended_by = ?2, updated_at = ?1 WHERE id = ?3",
  ).run(timestamp, suspendedBy, id);
  // La suspensión bloquea resolveViewer pero no revoca las keys: la reactivación
  // administrativa puede devolver el acceso sin perder sus identificadores.
  return actorOrNotFound(db, id);
}

export function reactivateActor(db: Database, id: string, workspaceId?: string): ActorRow {
  if (workspaceId) {
    return db.transaction(() => {
      const membership = actorWorkspaceMembership(db, id, workspaceId);
      if (!membership) throw apiError("NOT_FOUND", "Actor not found");
      if (membership.status === "left")
        throw apiError("VALIDATION_FAILED", "A left actor cannot be reactivated");
      if (membership.status === "active") return actorInWorkspace(db, id, workspaceId);
      const timestamp = now();
      db.query(
        `UPDATE workspace_memberships
         SET status = 'active', suspended_at = NULL, suspended_by = NULL, updated_at = ?1
         WHERE actor_id = ?2 AND workspace_id = ?3`,
      ).run(timestamp, id, workspaceId);
      const updated = actorWorkspaceMembership(db, id, workspaceId)!;
      syncLegacyActorStatus(db, id, updated);
      return actorInWorkspace(db, id, workspaceId);
    })();
  }

  const actor = actorOrNotFound(db, id);
  if (actor.status === "left")
    throw apiError("VALIDATION_FAILED", "A left actor cannot be reactivated");
  if (actor.status === "active") return actor;
  db.query(
    "UPDATE actors SET status = 'active', suspended_at = NULL, suspended_by = NULL, updated_at = ?1 WHERE id = ?2",
  ).run(now(), id);
  return actorOrNotFound(db, id);
}

function markActorLeft(db: Database, id: string, workspaceId?: string): ActorRow {
  if (workspaceId) {
    return db.transaction(() => {
      const membership = actorWorkspaceMembership(db, id, workspaceId);
      if (!membership) throw apiError("NOT_FOUND", "Actor not found");
      if (membership.status === "left") return actorInWorkspace(db, id, workspaceId);
      if (
        membership.status === "active" &&
        membership.role === "admin" &&
        activeWorkspaceAdminCount(db, workspaceId) <= 1
      ) {
        throw apiError("VALIDATION_FAILED", "Cannot revoke the last workspace admin");
      }
      const timestamp = now();
      db.query(
        `UPDATE workspace_memberships
         SET status = 'left', suspended_at = NULL, suspended_by = NULL, left_at = ?1, updated_at = ?1
         WHERE actor_id = ?2 AND workspace_id = ?3`,
      ).run(timestamp, id, workspaceId);
      db.query(
        `DELETE FROM api_key_team_limits
         WHERE workspace_id = ?1
           AND api_key_id IN (SELECT id FROM api_keys WHERE actor_id = ?2)`,
      ).run(workspaceId, id);
      db.query(
        `DELETE FROM api_key_workspaces
         WHERE workspace_id = ?1
           AND api_key_id IN (SELECT id FROM api_keys WHERE actor_id = ?2)`,
      ).run(workspaceId, id);
      db.query(
        `UPDATE api_keys
         SET revoked_at = ?1
         WHERE actor_id = ?2 AND revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM api_key_workspaces grants
             WHERE grants.api_key_id = api_keys.id
           )`,
      ).run(timestamp, id);
      const updated = actorWorkspaceMembership(db, id, workspaceId)!;
      syncLegacyActorStatus(db, id, updated);
      return actorInWorkspace(db, id, workspaceId);
    })();
  }

  const actor = actorOrNotFound(db, id);
  if (actor.status === "left") return actor;
  if (actor.status === "active" && actor.workspace_role === "admin" && activeAdminCount(db) <= 1) {
    throw apiError("VALIDATION_FAILED", "Cannot revoke the last workspace admin");
  }
  const timestamp = now();
  db.query("UPDATE actors SET status = 'left', left_at = ?1, updated_at = ?1 WHERE id = ?2").run(
    timestamp,
    id,
  );
  db.query("UPDATE api_keys SET revoked_at = ?1 WHERE actor_id = ?2 AND revoked_at IS NULL").run(
    timestamp,
    id,
  );
  return actorOrNotFound(db, id);
}

/** Revoca permanentemente el acceso de un actor sin borrar su identidad ni autoría. */
export function revokeActor(db: Database, id: string, workspaceId?: string): ActorRow {
  return markActorLeft(db, id, workspaceId);
}

/** Un actor puede salir por sí mismo; la operación conserva sus referencias históricas. */
export function leaveActor(db: Database, id: string, workspaceId?: string): ActorRow {
  return markActorLeft(db, id, workspaceId);
}
