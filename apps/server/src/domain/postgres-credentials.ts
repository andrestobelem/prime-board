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

async function assertWorkspaceExists(
  persistence: Persistence | PersistenceTransaction,
  workspaceId: string,
): Promise<void> {
  if (!(await persistence.one("SELECT id FROM workspace WHERE id = $1", [workspaceId]))) {
    throw apiError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
  }
}

async function normalizeTeamIds(
  persistence: Persistence | PersistenceTransaction,
  teamIds: readonly string[] | null | undefined,
  workspaceId: string,
): Promise<string[]> {
  if (teamIds == null || teamIds.length === 0) return [];
  await assertWorkspaceExists(persistence, workspaceId);
  const unique = [...new Set(teamIds)];
  for (const teamId of unique) {
    // PostgreSQL still keeps Teams installation-scoped. The Workspace check
    // above prevents a selector from authorizing a Team against a missing
    // Workspace while the future Team scope migration is pending.
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
  workspaceId: string,
): Promise<{ scopes: ApiKeyScope[]; teamIds: string[]; expiresAt: string | null }> {
  return {
    scopes: normalizeScopes(input.scopes),
    teamIds: await normalizeTeamIds(persistence, input.teamIds, workspaceId),
    expiresAt: normalizeExpiry(input.expiresAt),
  };
}

export async function postgresApiKeyMetadata(
  persistence: Persistence,
  input: ApiKeyInput,
  workspaceId: string,
): Promise<{ scopes: ApiKeyScope[]; teamIds: string[]; expiresAt: string | null }> {
  return metadata(persistence, input, workspaceId);
}

export async function getPostgresApiKey(
  persistence: Persistence,
  id: string,
): Promise<ApiKeyRow | null> {
  return persistence.one<ApiKeyRow>("SELECT * FROM api_keys WHERE id = $1", [id]);
}

async function assertActiveWorkspaceMembership(
  persistence: Persistence | PersistenceTransaction,
  actorId: string,
  workspaceId: string,
): Promise<void> {
  const membership = await persistence.one<{ status: "active" | "suspended" | "left" }>(
    `SELECT status
     FROM workspace_memberships
     WHERE workspace_id = $1 AND actor_id = $2`,
    [workspaceId, actorId],
  );
  if (!membership) throw apiError("NOT_FOUND", "Actor not found in this Workspace");
  if (membership.status !== "active") {
    throw apiError("UNAUTHORIZED", "Only active actors can receive API keys");
  }
}

async function assertApiKeyWorkspaceGrant(
  persistence: Persistence | PersistenceTransaction,
  keyId: string,
  workspaceId: string,
): Promise<void> {
  if (
    !(await persistence.one(
      `SELECT 1
       FROM api_key_workspaces
       WHERE api_key_id = $1 AND workspace_id = $2`,
      [keyId, workspaceId],
    ))
  ) {
    throw apiError("NOT_FOUND", "API key is not available in this Workspace");
  }
}

async function assertApiKeyTeamLimitsGranted(
  persistence: Persistence | PersistenceTransaction,
  keyId: string,
): Promise<void> {
  if (
    await persistence.one(
      `SELECT 1
       FROM api_key_team_limits AS limits
       WHERE limits.api_key_id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM api_key_workspaces AS grants
           WHERE grants.api_key_id = limits.api_key_id
             AND grants.workspace_id = limits.workspace_id
         )`,
      [keyId],
    )
  ) {
    throw apiError("UNAUTHORIZED", "API key Team limits are not granted in a Workspace");
  }
}

async function assertApiKeyWorkspaceAccess(
  persistence: Persistence | PersistenceTransaction,
  row: ApiKeyRow,
  workspaceId: string,
): Promise<void> {
  await assertApiKeyWorkspaceGrant(persistence, row.id, workspaceId);
  await assertApiKeyTeamLimitsGranted(persistence, row.id);
  await assertActiveWorkspaceMembership(persistence, row.actor_id, workspaceId);
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
  workspaceId?: string,
): Promise<string[]> {
  const rows = await persistence.many<{ team_id: string }>(
    workspaceId
      ? `SELECT limits.team_id
         FROM api_key_team_limits AS limits
         JOIN api_key_workspaces AS grants
           ON grants.api_key_id = limits.api_key_id
          AND grants.workspace_id = $2
         WHERE limits.api_key_id = $1
           AND limits.workspace_id = $2
         ORDER BY limits.team_id`
      : "SELECT team_id FROM api_key_team_limits WHERE api_key_id = $1 ORDER BY team_id",
    workspaceId ? [id, workspaceId] : [id],
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
  input: {
    actorId: string;
    name: string;
    expiresAt: string | null;
    rotatedFromId?: string | null;
    workspaceId?: string;
  },
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
  if (input.workspaceId) {
    // 0007 seeds the initial grant through a trigger. Keep mutations scoped to
    // the effective Workspace instead of retaining grants from other scopes.
    await tx.execute(
      "DELETE FROM api_key_workspaces WHERE api_key_id = $1 AND workspace_id <> $2",
      [id, input.workspaceId],
    );
    await tx.execute(
      `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (api_key_id, workspace_id)
       DO UPDATE SET is_default = 1`,
      [id, input.workspaceId, createdAt],
    );
  }
  for (const scope of scopes) {
    await tx.execute("INSERT INTO api_key_scopes (api_key_id, scope) VALUES ($1, $2)", [id, scope]);
  }
  for (const teamId of teamIds) {
    if (!input.workspaceId) {
      throw new Error("PostgreSQL API key Team limits require a Workspace");
    }
    await tx.execute(
      "INSERT INTO api_key_team_limits (api_key_id, team_id, workspace_id) VALUES ($1, $2, $3)",
      [id, teamId, input.workspaceId],
    );
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
  workspaceId: string,
): Promise<{ row: PostgresApiKeyView; key: string }> {
  const actor = await getPostgresActor(persistence, input.actorId);
  if (!actor) throw apiError("NOT_FOUND", "Actor not found");
  await assertActiveWorkspaceMembership(persistence, input.actorId, workspaceId);
  if (!input.name?.trim()) throw apiError("VALIDATION_FAILED", "API key name cannot be empty");
  const values = await metadata(persistence, input, workspaceId);
  const key = generateApiKey();
  const result = await persistence.transaction((tx) =>
    insertApiKey(
      tx,
      {
        actorId: input.actorId,
        name: input.name!.trim(),
        expiresAt: values.expiresAt,
        rotatedFromId: input.rotatedFromId,
        workspaceId,
      },
      key,
      values.scopes,
      values.teamIds,
    ),
  );
  return {
    row: await viewKey(persistence, result.row, values.scopes, values.teamIds),
    key,
  };
}

export async function deletePostgresApiKey(
  persistence: Persistence,
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const existing = await getPostgresApiKey(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "API key not found");
  await assertApiKeyWorkspaceAccess(persistence, existing, workspaceId);
  const timestamp = now();
  await persistence.transaction(async (tx) => {
    await assertApiKeyWorkspaceAccess(tx, existing, workspaceId);
    await tx.execute(
      "DELETE FROM api_key_team_limits WHERE api_key_id = $1 AND workspace_id = $2",
      [id, workspaceId],
    );
    await tx.execute("DELETE FROM api_key_workspaces WHERE api_key_id = $1 AND workspace_id = $2", [
      id,
      workspaceId,
    ]);
    await tx.execute(
      `UPDATE api_keys SET revoked_at = $1
       WHERE id = $2 AND revoked_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM api_key_workspaces WHERE api_key_id = $2)`,
      [timestamp, id],
    );
  });
  return true;
}

export async function rotatePostgresApiKey(
  persistence: Persistence,
  id: string,
  input: ApiKeyInput,
  workspaceId: string,
): Promise<{ row: PostgresApiKeyView; key: string }> {
  const existing = await getPostgresApiKey(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "API key not found");
  if (existing.revoked_at) throw apiError("VALIDATION_FAILED", "API key is already revoked");
  await assertApiKeyWorkspaceAccess(persistence, existing, workspaceId);
  const values = await metadata(
    persistence,
    {
      ...input,
      scopes: input.scopes === undefined ? await listKeyScopes(persistence, id) : input.scopes,
      teamIds:
        input.teamIds === undefined
          ? await listKeyTeams(persistence, id, workspaceId)
          : input.teamIds,
      expiresAt: input.expiresAt === undefined ? existing.expires_at : input.expiresAt,
    },
    workspaceId,
  );
  const actor = await getPostgresActor(persistence, existing.actor_id);
  if (!actor) throw apiError("NOT_FOUND", "Actor not found");
  const key = generateApiKey();
  const result = await persistence.transaction(async (tx) => {
    await assertApiKeyWorkspaceAccess(tx, existing, workspaceId);
    const replacement = await insertApiKey(
      tx,
      {
        actorId: existing.actor_id,
        name: input.name?.trim() || existing.name,
        expiresAt: values.expiresAt,
        rotatedFromId: existing.id,
        workspaceId,
      },
      key,
      values.scopes,
      values.teamIds,
    );
    await tx.execute(
      "DELETE FROM api_key_team_limits WHERE api_key_id = $1 AND workspace_id = $2",
      [id, workspaceId],
    );
    await tx.execute("DELETE FROM api_key_workspaces WHERE api_key_id = $1 AND workspace_id = $2", [
      id,
      workspaceId,
    ]);
    const revoked = await tx.execute(
      `UPDATE api_keys SET revoked_at = $1
       WHERE id = $2 AND revoked_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM api_key_workspaces WHERE api_key_id = $2)`,
      [now(), id],
    );
    if (revoked.rowCount !== 1 && existing.revoked_at === null) {
      // A remaining Workspace grant keeps the old key valid in that scope.
      const stillGranted = await tx.one("SELECT 1 FROM api_key_workspaces WHERE api_key_id = $1", [
        id,
      ]);
      if (!stillGranted) throw apiError("VALIDATION_FAILED", "API key is already revoked");
    }
    return replacement;
  });
  return {
    row: await viewKey(persistence, result.row, values.scopes, values.teamIds),
    key,
  };
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
  const expiresAt = Date.parse(row.expires_at);
  if (row.status !== "pending" || !Number.isFinite(expiresAt) || expiresAt > Date.now()) {
    return row;
  }
  const updated = await persistence.execute(
    `UPDATE actor_invitations SET status = 'expired'
     WHERE id = $1 AND status = 'pending'`,
    [row.id],
  );
  if (updated.rowCount === 1) return { ...row, status: "expired" };
  // A concurrent accept/revoke won the row lock; return the committed state
  // instead of manufacturing an expired status over an accepted invitation.
  return (
    (await persistence.one<ActorInvitationRow>("SELECT * FROM actor_invitations WHERE id = $1", [
      row.id,
    ])) ?? row
  );
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
    const row = await persistence.transaction(async (tx) => {
      if (email) {
        const existing = await tx.one<Pick<ActorInvitationRow, "id" | "expires_at">>(
          `SELECT id, expires_at FROM actor_invitations
           WHERE lower(email) = lower($1) AND status = 'pending' FOR UPDATE`,
          [email],
        );
        if (existing) {
          if (Date.parse(existing.expires_at) <= Date.now()) {
            await tx.execute("UPDATE actor_invitations SET status = 'expired' WHERE id = $1", [
              existing.id,
            ]);
          } else {
            throw apiError(
              "VALIDATION_FAILED",
              "A pending invitation already exists for this email",
            );
          }
        }
      }
      const row = await tx.one<ActorInvitationRow>(
        `INSERT INTO actor_invitations
         (id, email, name, type, token_hash, status, invited_by, metadata_json, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)
         RETURNING *`,
        [id, email, name, type, hashApiKey(token), invitedBy, metadataJson, timestamp, expiresAt],
      );
      if (!row) throw new Error("PostgreSQL invitation insert returned no row");
      return row;
    });
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
  const outcome = await persistence.transaction(async (tx) => {
    const row = await tx.one<ActorInvitationRow>(
      "SELECT * FROM actor_invitations WHERE token_hash = $1 FOR UPDATE",
      [hashApiKey(token)],
    );
    if (!row || row.status !== "pending") return { kind: "invalid" as const };
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      await tx.execute(
        `UPDATE actor_invitations SET status = 'expired' WHERE id = $1 AND status = 'pending'`,
        [row.id],
      );
      return { kind: "expired" as const };
    }
    const reserved = await tx.execute(
      "UPDATE actor_invitations SET status = 'accepted' WHERE id = $1 AND status = 'pending'",
      [row.id],
    );
    if (reserved.rowCount !== 1) return { kind: "invalid" as const };
    const name =
      normalizedOptional(input.name) ?? row.name ?? (row.email ? row.email.split("@")[0] : null);
    if (!name)
      throw apiError("VALIDATION_FAILED", "Actor name is required to accept an invitation");
    assertActorNameAvailable(name);
    const type = (input.type ?? row.type ?? "human").toLowerCase();
    if (type !== "human" && type !== "agent") {
      throw apiError("VALIDATION_FAILED", `Invalid actor type: ${input.type}`);
    }
    if (await tx.one("SELECT id FROM actors WHERE lower(name) = lower($1)", [name])) {
      throw apiError("VALIDATION_FAILED", "Actor name already exists");
    }
    const actorId = newId();
    const timestamp = now();
    let actor: ActorRow | null;
    try {
      actor = await tx.one<ActorRow>(
        `INSERT INTO actors (id, name, email, type, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
        [actorId, name, row.email, type, timestamp],
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw apiError("VALIDATION_FAILED", "Actor name already exists");
      throw error;
    }
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
    return { kind: "accepted" as const, actor, invitation, key: inserted.key };
  });
  if (outcome.kind === "invalid" || outcome.kind === "expired") {
    throw apiError("UNAUTHORIZED", "Invalid actor invitation token");
  }
  return outcome;
}
