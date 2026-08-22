import type { Persistence } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { hashApiKey } from "./keys.ts";
import type { ApiKeyScope } from "../domain/actors.ts";
import type { ActorRow, AuthContext } from "./viewer.ts";
import { now } from "../db/util.ts";

interface WorkspaceRow {
  id: string;
  url_key: string;
}

async function resolveWorkspace(
  persistence: Persistence,
  selector: string | null,
): Promise<string | null> {
  const rows = await persistence.many<WorkspaceRow>(
    selector
      ? "SELECT id, url_key FROM workspace WHERE id = $1 OR url_key = $1"
      : "SELECT id, url_key FROM workspace ORDER BY created_at, id",
    selector ? [selector] : [],
  );
  if (selector) {
    // PostgreSQL todavía no tiene la tabla de grants de 0026. No permite que
    // un selector atraviese una instalación con más de un Workspace hasta que
    // PRB-412/413 migre también esta persistencia.
    const all = await persistence.many<{ id: string }>("SELECT id FROM workspace");
    if (all.length !== 1 || rows.length !== 1) {
      throw apiError("UNAUTHORIZED", "Workspace access is not granted");
    }
    return rows[0]!.id;
  }
  if (rows.length === 1) return rows[0]!.id;
  if (rows.length > 1) throw apiError("WORKSPACE_REQUIRED", "A Workspace selector is required");
  return null;
}

/** Resolves the Workspace Admin for a local instance without credentials. */
export async function resolveLocalPostgresAuth(
  persistence: Persistence,
): Promise<AuthContext | null> {
  const actors = await persistence.many<ActorRow>(
    "SELECT * FROM actors WHERE workspace_role = 'admin' AND status = 'active' ORDER BY created_at, id",
  );
  const workspace = await resolveWorkspace(persistence, null);
  // No elige un admin arbitrario cuando la instalación deja de ser inequívoca.
  if (actors.length !== 1 || !workspace) return null;
  return {
    actor: actors[0]!,
    keyId: "local",
    workspaceId: workspace,
    scopes: ["read", "write", "admin"],
    teamIds: null,
    expiresAt: null,
  };
}

/** Resuelve una API key contra las tablas PostgreSQL del dominio migrado. */
export async function resolvePostgresAuth(
  persistence: Persistence,
  authorization: string | null,
  workspaceSelector: string | null = null,
): Promise<AuthContext | null> {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(pb_[A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const key = await persistence.one<{
    id: string;
    actor_id: string;
    expires_at: string | null;
  }>(
    `SELECT api_keys.id, api_keys.actor_id, api_keys.expires_at
     FROM api_keys JOIN actors ON actors.id = api_keys.actor_id
     WHERE api_keys.hash = $1 AND api_keys.revoked_at IS NULL
       AND actors.status = 'active'`,
    [hashApiKey(match[1]!)],
  );
  if (!key) return null;
  if (key.expires_at) {
    const expiresAt = Date.parse(key.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  }
  const workspaceId = await resolveWorkspace(persistence, workspaceSelector);
  if (!workspaceId) return null;

  const actor = await persistence.one<ActorRow>("SELECT * FROM actors WHERE id = $1", [
    key.actor_id,
  ]);
  if (!actor) return null;
  // La ruta PostgreSQL aún conserva el modelo single-workspace; el selector se
  // valida contra esa única fila hasta que su migración incorpore grants.
  await persistence.execute("UPDATE api_keys SET last_used_at = $1 WHERE id = $2", [now(), key.id]);
  const scopes = await persistence.many<{ scope: ApiKeyScope }>(
    "SELECT scope FROM api_key_scopes WHERE api_key_id = $1 ORDER BY CASE scope WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 END",
    [key.id],
  );
  const teams = await persistence.many<{ team_id: string }>(
    "SELECT team_id FROM api_key_team_limits WHERE api_key_id = $1 ORDER BY team_id",
    [key.id],
  );
  return {
    actor,
    keyId: key.id,
    workspaceId,
    scopes: scopes.length ? scopes.map((row) => row.scope) : ["read", "write", "admin"],
    teamIds: teams.length ? teams.map((row) => row.team_id) : null,
    expiresAt: key.expires_at,
  };
}
