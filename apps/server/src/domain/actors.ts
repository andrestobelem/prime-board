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
    createdAt: row.created_at,
  };
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
  input: { name: string; type: string; email?: string | null },
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
    "INSERT INTO actors (id, name, email, type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(id, name, input.email ?? null, input.type, timestamp, timestamp);
  return getActor(db, id)!;
}

export function updateActor(
  db: Database,
  id: string,
  input: { name?: string | null; email?: string | null },
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
  db.query("UPDATE actors SET name = ?1, email = ?2, updated_at = ?3 WHERE id = ?4").run(
    name,
    email,
    now(),
    id,
  );
  return getActor(db, id)!;
}

export interface ApiKeyRow {
  id: string;
  actor_id: string;
  name: string;
  hash: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export function mapApiKey(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    actorId: row.actor_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function listApiKeys(db: Database, actorId: string, includeRevoked = false): ApiKeyRow[] {
  return db
    .query(
      `SELECT * FROM api_keys WHERE actor_id = ?1
       ${includeRevoked ? "" : "AND revoked_at IS NULL"}
       ORDER BY created_at`,
    )
    .all(actorId) as ApiKeyRow[];
}

export function getApiKey(db: Database, id: string): ApiKeyRow | null {
  return db.query("SELECT * FROM api_keys WHERE id = ?1").get(id) as ApiKeyRow | null;
}

export function deleteApiKey(db: Database, id: string): boolean {
  const existing = db.query("SELECT id, revoked_at FROM api_keys WHERE id = ?1").get(id) as {
    id: string;
    revoked_at: string | null;
  } | null;
  if (!existing) throw apiError("NOT_FOUND", "API key not found");
  if (!existing.revoked_at) {
    db.query("UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2").run(now(), id);
  }
  return true;
}

/** Crea una key para un actor. Devuelve la key en claro UNA sola vez. */
export function createApiKey(
  db: Database,
  input: { actorId: string; name: string },
): { row: ApiKeyRow; key: string } {
  const actor = getActor(db, input.actorId);
  if (!actor) throw apiError("NOT_FOUND", "Actor not found");
  if (actor.status !== "active") {
    throw apiError("UNAUTHORIZED", "Only active actors can receive API keys");
  }
  if (!input.name.trim()) throw apiError("VALIDATION_FAILED", "API key name cannot be empty");

  const key = generateApiKey();
  const id = newId();
  db.query(
    "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(id, input.actorId, input.name.trim(), hashApiKey(key), now());
  const row = db.query("SELECT * FROM api_keys WHERE id = ?1").get(id) as ApiKeyRow;
  return { row, key };
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
}

function invitationStatus(db: Database, row: ActorInvitationRow): ActorInvitationRow {
  if (row.status === "pending" && Date.parse(row.expires_at) <= Date.now()) {
    db.query("UPDATE actor_invitations SET status = 'expired' WHERE id = ?1").run(row.id);
    return { ...row, status: "expired" };
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

export function getActorInvitation(db: Database, id: string): ActorInvitationRow | null {
  const row = db
    .query("SELECT * FROM actor_invitations WHERE id = ?1")
    .get(id) as ActorInvitationRow | null;
  return row ? invitationStatus(db, row) : null;
}

export function listActorInvitations(db: Database, includeRevoked = false): ActorInvitationRow[] {
  const rows = db
    .query(
      `SELECT * FROM actor_invitations
       ${includeRevoked ? "" : "WHERE status = 'pending'"}
       ORDER BY created_at, id`,
    )
    .all() as ActorInvitationRow[];
  const current = rows.map((row) => invitationStatus(db, row));
  return includeRevoked ? current : current.filter((row) => row.status === "pending");
}

function normalizedOptional(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
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
): { row: ActorInvitationRow; token: string } {
  const email = normalizedOptional(input.email);
  const name = normalizedOptional(input.name);
  const type = input.type?.toLowerCase() || null;
  if (type !== null && type !== "human" && type !== "agent") {
    throw apiError("VALIDATION_FAILED", `Invalid actor type: ${input.type}`);
  }
  if (email) {
    const existing = db
      .query(
        "SELECT id FROM actor_invitations WHERE lower(email) = lower(?1) AND status = 'pending'",
      )
      .get(email);
    if (existing)
      throw apiError("VALIDATION_FAILED", "A pending invitation already exists for this email");
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
  db.query(
    `INSERT INTO actor_invitations
      (id, email, name, type, token_hash, status, invited_by, metadata_json, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9)`,
  ).run(id, email, name, type, hashApiKey(token), invitedBy, metadata, timestamp, expiresAt);
  return { row: getActorInvitation(db, id)!, token };
}

export function revokeActorInvitation(db: Database, id: string): ActorInvitationRow {
  const existing = getActorInvitation(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Actor invitation not found");
  if (existing.status !== "pending") {
    throw apiError("VALIDATION_FAILED", "Only pending invitations can be revoked");
  }
  db.query("UPDATE actor_invitations SET status = 'revoked', revoked_at = ?1 WHERE id = ?2").run(
    now(),
    id,
  );
  return getActorInvitation(db, id)!;
}

export function acceptActorInvitation(
  db: Database,
  token: string,
  input: { name?: string | null; type?: string | null },
): { actor: ActorRow; invitation: ActorInvitationRow; key: string } {
  let result: { actor: ActorRow; invitation: ActorInvitationRow; key: string } | null = null;
  db.transaction(() => {
    const row = db
      .query("SELECT * FROM actor_invitations WHERE token_hash = ?1")
      .get(hashApiKey(token)) as ActorInvitationRow | null;
    if (!row) throw apiError("UNAUTHORIZED", "Invalid actor invitation token");
    if (row.status !== "pending" || Date.parse(row.expires_at) <= Date.now()) {
      if (row.status === "pending") {
        db.query("UPDATE actor_invitations SET status = 'expired' WHERE id = ?1").run(row.id);
      }
      throw apiError("UNAUTHORIZED", "Invalid actor invitation token");
    }

    // Reservar la invitación dentro de la misma transacción evita que dos
    // aceptaciones concurrentes creen dos actores para un único bearer token.
    db.query(
      "UPDATE actor_invitations SET status = 'accepted' WHERE id = ?1 AND status = 'pending'",
    ).run(row.id);
    const reserved = db.query("SELECT status FROM actor_invitations WHERE id = ?1").get(row.id) as {
      status: ActorInvitationStatus;
    };
    if (reserved.status !== "accepted") {
      throw apiError("UNAUTHORIZED", "Invalid actor invitation token");
    }

    const name =
      normalizedOptional(input.name) ?? row.name ?? (row.email ? row.email.split("@")[0] : null);
    if (!name)
      throw apiError("VALIDATION_FAILED", "Actor name is required to accept an invitation");
    const type = (input.type ?? row.type ?? "human").toLowerCase();
    if (type !== "human" && type !== "agent") {
      throw apiError("VALIDATION_FAILED", `Invalid actor type: ${input.type}`);
    }
    const actor = createActor(db, { name, type, email: row.email });
    const { key } = createApiKey(db, { actorId: actor.id, name: "invitation key" });
    const timestamp = now();
    db.query("UPDATE actor_invitations SET actor_id = ?1, accepted_at = ?2 WHERE id = ?3").run(
      actor.id,
      timestamp,
      row.id,
    );
    result = { actor: getActor(db, actor.id)!, invitation: getActorInvitation(db, row.id)!, key };
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

function actorOrNotFound(db: Database, id: string): ActorRow {
  const actor = getActor(db, id);
  if (!actor) throw apiError("NOT_FOUND", "Actor not found");
  return actor;
}

export function suspendActor(db: Database, id: string, suspendedBy: string): ActorRow {
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

export function reactivateActor(db: Database, id: string): ActorRow {
  const actor = actorOrNotFound(db, id);
  if (actor.status === "left")
    throw apiError("VALIDATION_FAILED", "A left actor cannot be reactivated");
  if (actor.status === "active") return actor;
  db.query(
    "UPDATE actors SET status = 'active', suspended_at = NULL, suspended_by = NULL, updated_at = ?1 WHERE id = ?2",
  ).run(now(), id);
  return actorOrNotFound(db, id);
}

function markActorLeft(db: Database, id: string): ActorRow {
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
export function revokeActor(db: Database, id: string): ActorRow {
  return markActorLeft(db, id);
}

/** Un actor puede salir por sí mismo; la operación conserva sus referencias históricas. */
export function leaveActor(db: Database, id: string): ActorRow {
  return markActorLeft(db, id);
}
