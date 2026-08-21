// Resuelve el actor autenticado a partir del header Authorization (spec §5).
import type { Database } from "bun:sqlite";
import { hashApiKey } from "./keys.ts";
import { now } from "../db/util.ts";
import type { ApiKeyScope } from "../domain/actors.ts";

export interface ActorRow {
  id: string;
  name: string;
  email: string | null;
  type: "human" | "agent";
  workspace_role: "admin" | "member";
  status: "active" | "suspended" | "left";
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthContext {
  actor: ActorRow;
  keyId: string;
  scopes: ApiKeyScope[];
  teamIds: string[] | null;
  expiresAt: string | null;
}

function listScopes(db: Database, keyId: string): ApiKeyScope[] {
  const rows = db
    .query(
      "SELECT scope FROM api_key_scopes WHERE api_key_id = ?1 ORDER BY CASE scope WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 END",
    )
    .all(keyId) as Array<{ scope: ApiKeyScope }>;
  // Bases creadas manualmente antes de la migración se tratan como legacy-full.
  return rows.length ? rows.map((row) => row.scope) : ["read", "write", "admin"];
}

function listTeamIds(db: Database, keyId: string): string[] | null {
  const rows = db
    .query("SELECT team_id FROM api_key_team_limits WHERE api_key_id = ?1 ORDER BY team_id")
    .all(keyId) as Array<{ team_id: string }>;
  return rows.length ? rows.map((row) => row.team_id) : null;
}

/**
 * Resolves the seeded Workspace Admin for a loopback-only local instance.
 *
 * Local mode has no credential to scope, so it grants the same full access as
 * the local bootstrap key while keeping the actor visible in activity records.
 */
export function resolveLocalAuth(db: Database): AuthContext | null {
  const actors = db
    .query(
      "SELECT * FROM actors WHERE workspace_role = 'admin' AND status = 'active' ORDER BY created_at, id",
    )
    .all() as ActorRow[];
  // El modo local no tiene credencial ni selector de Workspace. No elige un
  // admin arbitrario cuando la instalación deja de ser inequívoca.
  if (actors.length !== 1) return null;
  const actor = actors[0]!;
  return {
    actor,
    keyId: "local",
    scopes: ["read", "write", "admin"],
    teamIds: null,
    expiresAt: null,
  };
}

export function resolveAuth(db: Database, authorization: string | null): AuthContext | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(pb_[A-Za-z0-9_-]+)$/);
  if (!match) return null;

  const hash = hashApiKey(match[1]!);
  // Cruzar la key con el actor antes de tocar last_used_at evita que una
  // credencial suspendida/expirada deje actividad o vuelva a operar.
  const key = db
    .query(
      `SELECT api_keys.id, api_keys.actor_id, api_keys.expires_at
       FROM api_keys JOIN actors ON actors.id = api_keys.actor_id
       WHERE api_keys.hash = ?1 AND api_keys.revoked_at IS NULL
         AND actors.status = 'active'`,
    )
    .get(hash) as { id: string; actor_id: string; expires_at: string | null } | null;
  if (!key) return null;
  if (key.expires_at) {
    const expiresAt = Date.parse(key.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  }

  db.query("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2").run(now(), key.id);
  const actor = db.query("SELECT * FROM actors WHERE id = ?1").get(key.actor_id) as ActorRow | null;
  if (!actor) return null;
  return {
    actor,
    keyId: key.id,
    scopes: listScopes(db, key.id),
    teamIds: listTeamIds(db, key.id),
    expiresAt: key.expires_at,
  };
}

export function resolveViewer(db: Database, authorization: string | null): ActorRow | null {
  return resolveAuth(db, authorization)?.actor ?? null;
}
