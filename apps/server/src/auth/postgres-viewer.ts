import type { Persistence } from "../db/persistence.ts";
import { hashApiKey } from "./keys.ts";
import type { ApiKeyScope } from "../domain/actors.ts";
import type { ActorRow, AuthContext } from "./viewer.ts";
import { now } from "../db/util.ts";

/** Resuelve una API key contra las tablas PostgreSQL del dominio migrado. */
export async function resolvePostgresAuth(
  persistence: Persistence,
  authorization: string | null,
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
  await persistence.execute("UPDATE api_keys SET last_used_at = $1 WHERE id = $2", [now(), key.id]);
  const actor = await persistence.one<ActorRow>("SELECT * FROM actors WHERE id = $1", [
    key.actor_id,
  ]);
  if (!actor) return null;
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
    scopes: scopes.length ? scopes.map((row) => row.scope) : ["read", "write", "admin"],
    teamIds: teams.length ? teams.map((row) => row.team_id) : null,
    expiresAt: key.expires_at,
  };
}
