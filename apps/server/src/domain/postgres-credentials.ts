import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { apiError } from "../graphql/errors.ts";
import type {
  ActorInvitationRow,
  ActorInvitationStatus,
  ApiKeyRow,
  ApiKeyScope,
} from "./actors.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { getPostgresActor, mapPostgresActor, type PostgresApiKeyView } from "./postgres-actors.ts";
import { newId, now } from "../db/util.ts";

const API_KEY_SCOPES: readonly ApiKeyScope[] = ["read", "write", "admin"];
const HISTORICAL_AGENT_NAMES = new Set(["claude", "demo-agent", "linear"]);

type ApiKeyInput = {
  name?: string | null;
  scopes?: readonly string[] | null;
  teamIds?: readonly string[] | null;
  expiresAt?: string | null;
};

function normalizeScopes(scopes: readonly string[] | null | undefined): ApiKeyScope[] {
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

async function normalizeTeamIds(
  persistence: Persistence | PersistenceTransaction,
  teamIds: readonly string[] | null | undefined,
): Promise<string[]> {
  if (teamIds == null || teamIds.length === 0) return [];
  const unique = [...new Set(teamIds)];
  for (const teamId of unique) {
    if (!(await persistence.one("SELECT id FROM teams WHERE id = $1", [teamId]))) {
      throw apiError("NOT_FOUND", `Team not found: ${teamId}`);
    }
  }
  return unique.sort();
}

function normalizeExpiry(expiresAt: string | null | undefined): string | null {
  if (expiresAt == null) return null;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw apiError("VALIDATION_FAILED", "API key expiration must be a valid future ISO-8601 date");
  }
  return new Date(timestamp).toISOString();
}

async function metadata(
  persistence: Persistence | PersistenceTransaction,
  input: ApiKeyInput,
): Promise<{ scopes: ApiKeyScope[]; teamIds: string[]; expiresAt: string | null }> {
  return {
    scopes: normalizeScopes(input.scopes),
    teamIds: await normalizeTeamIds(persistence, input.teamIds),
    expiresAt: normalizeExpiry(input.expiresAt),
  };
}

export async function postgresApiKeyMetadata(
  persistence: Persistence,
  input: ApiKeyInput,
): Promise<{ scopes: ApiKeyScope[]; teamIds: string[]; expiresAt: string | null }> {
  return metadata(persistence, input);
}

export async function getPostgresApiKey(
  persistence: Persistence,
  id: string,
): Promise<ApiKeyRow | null> {
  return persistence.one<ApiKeyRow>("SELECT * FROM api_keys WHERE id = $1", [id]);
}

async function listKeyScopes(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<ApiKeyScope[]> {
  const rows = await persistence.many<{ scope: ApiKeyScope }>(
    "SELECT scope FROM api_key_scopes WHERE api_key_id = $1 ORDER BY CASE scope WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 END",
    [id],
  );
  return rows.length ? rows.map((row) => row.scope) : [...API_KEY_SCOPES];
}

async function listKeyTeams(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<string[]> {
  const rows = await persistence.many<{ team_id: string }>(
    "SELECT team_id FROM api_key_team_limits WHERE api_key_id = $1 ORDER BY team_id",
    [id],
  );
  return rows.map((row) => row.team_id);
}

async function viewKey(
  persistence: Persistence | PersistenceTransaction,
  row: ApiKeyRow,
  scopes?: ApiKeyScope[],
  teamIds?: string[],
): Promise<PostgresApiKeyView> {
  return {
    ...row,
    scopes: scopes ?? (await listKeyScopes(persistence, row.id)),
    teamIds: teamIds ?? (await listKeyTeams(persistence, row.id)),
  };
}

async function insertApiKey(
  tx: PersistenceTransaction,
  input: { actorId: string; name: string; expiresAt: string | null; rotatedFromId?: string | null },
  key: string,
  scopes: readonly ApiKeyScope[],
  teamIds: readonly string[],
  createdAt = now(),
): Promise<{ row: ApiKeyRow; key: string }> {
  const id = newId();
  await tx.execute(
    `INSERT INTO api_keys (id, actor_id, name, hash, expires_at, rotated_from_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.actorId,
      input.name,
      hashApiKey(key),
      input.expiresAt,
      input.rotatedFromId ?? null,
      createdAt,
    ],
  );
  for (const scope of scopes) {
    await tx.execute("INSERT INTO api_key_scopes (api_key_id, scope) VALUES ($1, $2)", [id, scope]);
  }
  for (const teamId of teamIds) {
    await tx.execute("INSERT INTO api_key_team_limits (api_key_id, team_id) VALUES ($1, $2)", [
      id,
      teamId,
    ]);
  }
  const row = await tx.one<ApiKeyRow>("SELECT * FROM api_keys WHERE id = $1", [id]);
  if (!row) throw new Error("PostgreSQL API key insert returned no row");
  return { row, key };
}

export async function createPostgresApiKey(
  persistence: Persistence,
  input: {
    actorId: string;
    name: string;
    scopes?: readonly string[] | null;
    teamIds?: readonly string[] | null;
    expiresAt?: string | null;
    rotatedFromId?: string | null;
  },
): Promise<{ row: PostgresApiKeyView; key: string }> {
  const actor = await getPostgresActor(persistence, input.actorId);
  if (!actor) throw apiError("NOT_FOUND", "Actor not found");
  if (actor.status !== "active") {
    throw apiError("UNAUTHORIZED", "Only active actors can receive API keys");
  }
  if (!input.name?.trim()) throw apiError("VALIDATION_FAILED", "API key name cannot be empty");
  const values = await metadata(persistence, input);
  const key = generateApiKey();
  const result = await persistence.transaction((tx) =>
    insertApiKey(
      tx,
      {
        actorId: input.actorId,
        name: input.name!.trim(),
        expiresAt: values.expiresAt,
        rotatedFromId: input.rotatedFromId,
      },
      key,
      values.scopes,
      values.teamIds,
    ),
  );
  return { row: await viewKey(persistence, result.row, values.scopes, values.teamIds), key };
}

export async function deletePostgresApiKey(persistence: Persistence, id: string): Promise<boolean> {
  const existing = await getPostgresApiKey(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "API key not found");
  if (!existing.revoked_at) {
    await persistence.execute("UPDATE api_keys SET revoked_at = $1 WHERE id = $2", [now(), id]);
  }
  return true;
}

export async function rotatePostgresApiKey(
  persistence: Persistence,
  id: string,
  input: ApiKeyInput,
): Promise<{ row: PostgresApiKeyView; key: string }> {
  const existing = await getPostgresApiKey(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "API key not found");
  if (existing.revoked_at) throw apiError("VALIDATION_FAILED", "API key is already revoked");
  const values = await metadata(persistence, {
    ...input,
    scopes: input.scopes === undefined ? await listKeyScopes(persistence, id) : input.scopes,
    teamIds: input.teamIds === undefined ? await listKeyTeams(persistence, id) : input.teamIds,
    expiresAt: input.expiresAt === undefined ? existing.expires_at : input.expiresAt,
  });
  const actor = await getPostgresActor(persistence, existing.actor_id);
  if (!actor) throw apiError("NOT_FOUND", "Actor not found");
  const key = generateApiKey();
  const result = await persistence.transaction(async (tx) => {
    const replacement = await insertApiKey(
      tx,
      {
        actorId: existing.actor_id,
        name: input.name?.trim() || existing.name,
        expiresAt: values.expiresAt,
        rotatedFromId: existing.id,
      },
      key,
      values.scopes,
      values.teamIds,
    );
    const revoked = await tx.execute(
      "UPDATE api_keys SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL",
      [now(), id],
    );
    if (revoked.rowCount !== 1) throw apiError("VALIDATION_FAILED", "API key is already revoked");
    return replacement;
  });
  return { row: await viewKey(persistence, result.row, values.scopes, values.teamIds), key };
}

export type PostgresActorInvitation = ActorInvitationRow;

function assertActorNameAvailable(name: string): void {
  if (HISTORICAL_AGENT_NAMES.has(name.toLowerCase())) {
    throw apiError("VALIDATION_FAILED", `Cannot reuse historical agent name "${name}"`);
  }
}

function normalizedOptional(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function invitationStatus(
  persistence: Persistence,
  row: ActorInvitationRow,
): Promise<ActorInvitationRow> {
  if (row.status === "pending" && Date.parse(row.expires_at) <= Date.now()) {
    await persistence.execute("UPDATE actor_invitations SET status = 'expired' WHERE id = $1", [
      row.id,
    ]);
    return { ...row, status: "expired" };
  }
  return row;
}

export async function getPostgresActorInvitation(
  persistence: Persistence,
  id: string,
): Promise<ActorInvitationRow | null> {
  const row = await persistence.one<ActorInvitationRow>(
    "SELECT * FROM actor_invitations WHERE id = $1",
    [id],
  );
  return row ? invitationStatus(persistence, row) : null;
}

export async function listPostgresActorInvitations(
  persistence: Persistence,
  includeRevoked = false,
): Promise<ActorInvitationRow[]> {
  const rows = await persistence.many<ActorInvitationRow>(
    `SELECT * FROM actor_invitations
     ${includeRevoked ? "" : "WHERE status = 'pending'"}
     ORDER BY created_at, id`,
  );
  const current = await Promise.all(rows.map((row) => invitationStatus(persistence, row)));
  return includeRevoked ? current : current.filter((row) => row.status === "pending");
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof Error && /unique|duplicate|23505/i.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export async function createPostgresActorInvitation(
  persistence: Persistence,
  invitedBy: string,
  input: {
    email?: string | null;
    name?: string | null;
    type?: string | null;
    expiresAt?: string | null;
    metadata?: unknown;
  },
): Promise<{ row: ActorInvitationRow; token: string }> {
  const email = normalizedOptional(input.email);
  const name = normalizedOptional(input.name);
  const type = input.type?.toLowerCase() || null;
  if (type !== null && type !== "human" && type !== "agent") {
    throw apiError("VALIDATION_FAILED", `Invalid actor type: ${input.type}`);
  }
  if (
    email &&
    (await persistence.one(
      "SELECT id FROM actor_invitations WHERE lower(email) = lower($1) AND status = 'pending'",
      [email],
    ))
  ) {
    throw apiError("VALIDATION_FAILED", "A pending invitation already exists for this email");
  }
  let metadataJson = "{}";
  if (input.metadata !== undefined && input.metadata !== null) {
    try {
      metadataJson = JSON.stringify(input.metadata);
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
    const row = await persistence.one<ActorInvitationRow>(
      `INSERT INTO actor_invitations
       (id, email, name, type, token_hash, status, invited_by, metadata_json, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)
       RETURNING *`,
      [id, email, name, type, hashApiKey(token), invitedBy, metadataJson, timestamp, expiresAt],
    );
    if (!row) throw new Error("PostgreSQL invitation insert returned no row");
    return { row, token };
  } catch (error) {
    // The partial unique index remains the final arbiter for concurrent invites.
    if (isUniqueViolation(error)) {
      throw apiError("VALIDATION_FAILED", "A pending invitation already exists for this email");
    }
    throw error;
  }
}

export async function revokePostgresActorInvitation(
  persistence: Persistence,
  id: string,
): Promise<ActorInvitationRow> {
  const existing = await getPostgresActorInvitation(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "Actor invitation not found");
  if (existing.status !== "pending") {
    throw apiError("VALIDATION_FAILED", "Only pending invitations can be revoked");
  }
  const row = await persistence.one<ActorInvitationRow>(
    `UPDATE actor_invitations SET status = 'revoked', revoked_at = $1
     WHERE id = $2 AND status = 'pending' RETURNING *`,
    [now(), id],
  );
  if (!row) throw apiError("VALIDATION_FAILED", "Only pending invitations can be revoked");
  return row;
}

export async function acceptPostgresActorInvitation(
  persistence: Persistence,
  token: string,
  input: { name?: string | null; type?: string | null },
): Promise<{ actor: ActorRow; invitation: ActorInvitationRow; key: string }> {
  return persistence.transaction(async (tx) => {
    const row = await tx.one<ActorInvitationRow>(
      "SELECT * FROM actor_invitations WHERE token_hash = $1 FOR UPDATE",
      [hashApiKey(token)],
    );
    if (!row) throw apiError("UNAUTHORIZED", "Invalid actor invitation token");
    if (row.status !== "pending" || Date.parse(row.expires_at) <= Date.now()) {
      if (row.status === "pending") {
        await tx.execute("UPDATE actor_invitations SET status = 'expired' WHERE id = $1", [row.id]);
      }
      throw apiError("UNAUTHORIZED", "Invalid actor invitation token");
    }
    const reserved = await tx.execute(
      "UPDATE actor_invitations SET status = 'accepted' WHERE id = $1 AND status = 'pending'",
      [row.id],
    );
    if (reserved.rowCount !== 1) throw apiError("UNAUTHORIZED", "Invalid actor invitation token");
    const name =
      normalizedOptional(input.name) ?? row.name ?? (row.email ? row.email.split("@")[0] : null);
    if (!name)
      throw apiError("VALIDATION_FAILED", "Actor name is required to accept an invitation");
    const type = (input.type ?? row.type ?? "human").toLowerCase();
    if (type !== "human" && type !== "agent") {
      throw apiError("VALIDATION_FAILED", `Invalid actor type: ${input.type}`);
    }
    if (await tx.one("SELECT id FROM actors WHERE lower(name) = lower($1)", [name])) {
      throw apiError("VALIDATION_FAILED", "Actor name already exists");
    }
    const actorId = newId();
    const timestamp = now();
    const actor = await tx.one<ActorRow>(
      `INSERT INTO actors (id, name, email, type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
      [actorId, name, row.email, type, timestamp],
    );
    if (!actor) throw new Error("PostgreSQL invitation actor insert returned no row");
    const key = generateApiKey();
    const inserted = await insertApiKey(
      tx,
      { actorId, name: "invitation key", expiresAt: null },
      key,
      API_KEY_SCOPES,
      [],
      timestamp,
    );
    const acceptedAt = now();
    const invitation = await tx.one<ActorInvitationRow>(
      `UPDATE actor_invitations SET actor_id = $1, accepted_at = $2
       WHERE id = $3 RETURNING *`,
      [actorId, acceptedAt, row.id],
    );
    if (!invitation) throw new Error("PostgreSQL invitation update returned no row");
    return { actor, invitation, key: inserted.key };
  });
}
