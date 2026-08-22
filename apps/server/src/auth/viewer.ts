// Resuelve el actor autenticado y su Workspace efectivo a partir del header Authorization.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
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
  /** Workspace elegido por el grant y la Membership, nunca por un input GraphQL. */
  workspaceId: string;
  scopes: ApiKeyScope[];
  /** Límites de Team del grant efectivo; null significa todos los Teams del Workspace. */
  teamIds: string[] | null;
  expiresAt: string | null;
}

function listScopes(db: Database, keyId: string): ApiKeyScope[] {
  const rows = db
    .query(
      "SELECT scope FROM api_key_scopes WHERE api_key_id = ?1 ORDER BY CASE scope WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 END",
    )
    .all(keyId) as Array<{ scope: ApiKeyScope }>;
  // Bases creadas antes de la migración se tratan como legacy-full.
  return rows.length ? rows.map((row) => row.scope) : ["read", "write", "admin"];
}

function listTeamIds(db: Database, keyId: string, workspaceId: string): string[] | null {
  const rows = db
    .query(
      "SELECT team_id FROM api_key_team_limits WHERE api_key_id = ?1 AND workspace_id = ?2 ORDER BY team_id",
    )
    .all(keyId, workspaceId) as Array<{ team_id: string }>;
  return rows.length ? rows.map((row) => row.team_id) : null;
}

/**
 * Selecciona un grant que también tenga una Membership activa del Actor.
 * Un selector no concedido usa el mismo mensaje que un selector inválido para
 * no revelar si existe otro Workspace en la base.
 */
function resolveWorkspaceGrant(
  db: Database,
  keyId: string,
  actorId: string,
  selector: string | null,
): string {
  const rows = db
    .query(
      `SELECT grants.workspace_id, grants.is_default
       FROM api_key_workspaces AS grants
       JOIN workspace AS workspaces ON workspaces.id = grants.workspace_id
       JOIN workspace_memberships AS memberships
         ON memberships.workspace_id = grants.workspace_id
        AND memberships.actor_id = ?2
        AND memberships.status = 'active'
       WHERE grants.api_key_id = ?1
         AND (?3 IS NULL OR workspaces.id = ?3 OR workspaces.url_key = ?3)
       ORDER BY grants.is_default DESC, grants.workspace_id`,
    )
    .all(keyId, actorId, selector) as Array<{ workspace_id: string; is_default: number }>;

  if (selector !== null) {
    if (rows.length !== 1) throw apiError("UNAUTHORIZED", "Workspace access is not granted");
    return rows[0]!.workspace_id;
  }

  if (rows.length === 0) throw apiError("UNAUTHORIZED", "Workspace access is not granted");
  if (rows.length === 1) return rows[0]!.workspace_id;

  const defaults = rows.filter((row) => row.is_default === 1);
  if (defaults.length === 1) return defaults[0]!.workspace_id;
  throw apiError("WORKSPACE_REQUIRED", "A Workspace selector is required");
}

/** Resuelve el admin local solo cuando la instalación tiene un Workspace inequívoco. */
export function resolveLocalAuth(db: Database): AuthContext | null {
  const actors = db
    .query(
      `SELECT actors.*, workspace.id AS workspace_id
       FROM actors CROSS JOIN workspace
       WHERE actors.workspace_role = 'admin' AND actors.status = 'active'
       ORDER BY actors.created_at, actors.id`,
    )
    .all() as Array<ActorRow & { workspace_id: string }>;
  // No elige un admin arbitrario cuando la instalación deja de ser inequívoca.
  const workspaces = db.query("SELECT id FROM workspace").all() as Array<{ id: string }>;
  if (actors.length !== 1 || workspaces.length !== 1) return null;
  const actor = actors[0]!;
  return {
    actor,
    keyId: "local",
    workspaceId: workspaces[0]!.id,
    scopes: ["read", "write", "admin"],
    teamIds: null,
    expiresAt: null,
  };
}

export function resolveAuth(
  db: Database,
  authorization: string | null,
  workspaceSelector: string | null = null,
): AuthContext | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(pb_[A-Za-z0-9_-]+)$/);
  if (!match) return null;

  const hash = hashApiKey(match[1]!);
  // Validar key, Actor, grant y Membership antes de tocar last_used_at.
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

  const workspaceId = resolveWorkspaceGrant(db, key.id, key.actor_id, workspaceSelector);
  const actor = db.query("SELECT * FROM actors WHERE id = ?1").get(key.actor_id) as ActorRow | null;
  if (!actor) return null;

  db.query("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2").run(now(), key.id);
  return {
    actor,
    keyId: key.id,
    workspaceId,
    scopes: listScopes(db, key.id),
    teamIds: listTeamIds(db, key.id, workspaceId),
    expiresAt: key.expires_at,
  };
}

export function resolveViewer(
  db: Database,
  authorization: string | null,
  workspaceSelector: string | null = null,
): ActorRow | null {
  return resolveAuth(db, authorization, workspaceSelector)?.actor ?? null;
}
