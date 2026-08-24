import type { Persistence } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { hashApiKey } from "./keys.ts";
import type { ApiKeyScope } from "../domain/actors.ts";
import type { ActorRow, AuthContext } from "./viewer.ts";
import { now } from "../db/util.ts";

interface WorkspaceGrantRow {
  workspace_id: string;
  is_default: number;
  workspace_role: "admin" | "member";
  workspace_status: "active" | "suspended" | "left";
}

type ActorIdentityRow = Omit<ActorRow, "workspace_role" | "status">;

function selectWorkspaceGrant(
  rows: readonly WorkspaceGrantRow[],
  selector: string | null,
): WorkspaceGrantRow {
  if (selector !== null) {
    if (rows.length !== 1) throw apiError("UNAUTHORIZED", "Workspace access is not granted");
    return rows[0]!;
  }
  if (rows.length === 0) throw apiError("UNAUTHORIZED", "Workspace access is not granted");
  if (rows.length === 1) return rows[0]!;
  const defaults = rows.filter((row) => row.is_default === 1);
  if (defaults.length === 1) return defaults[0]!;
  throw apiError("WORKSPACE_REQUIRED", "A Workspace selector is required");
}

/** Resolves the Workspace Admin for a local instance without credentials. */
export async function resolveLocalPostgresAuth(
  persistence: Persistence,
): Promise<AuthContext | null> {
  const rows = await persistence.many<
    ActorIdentityRow & {
      workspace_id: string;
      membership_role: "admin" | "member";
      membership_status: "active" | "suspended" | "left";
    }
  >(
    `SELECT actors.id, actors.name, actors.email, actors.type, actors.avatar_url,
            actors.created_at, actors.updated_at, workspace.id AS workspace_id,
            memberships.role AS membership_role,
            memberships.status AS membership_status
     FROM actors
     JOIN workspace_memberships AS memberships
       ON memberships.actor_id = actors.id
      AND memberships.status = 'active'
      AND memberships.role = 'admin'
     JOIN workspace ON workspace.id = memberships.workspace_id
     ORDER BY actors.created_at, actors.id`,
  );
  // No elige un admin arbitrario cuando la instalación deja de ser inequívoca.
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const actor = {
    ...row,
    workspace_role: row.membership_role,
    status: row.membership_status,
  };
  return {
    actor,
    keyId: "local",
    workspaceId: row.workspace_id,
    workspaceRole: row.membership_role,
    workspaceStatus: row.membership_status,
    scopes: ["read", "write", "admin"],
    teamIds: null,
    expiresAt: null,
  };
}

/** Resuelve una API key contra las tablas migradas de PostgreSQL. */
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
    `SELECT id, actor_id, expires_at
     FROM api_keys
     WHERE hash = $1 AND revoked_at IS NULL`,
    [hashApiKey(match[1]!)],
  );
  if (!key) return null;
  if (key.expires_at) {
    const expiresAt = Date.parse(key.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  }

  // La credencial es efectiva solo si su grant y Membership activa coinciden
  // con el Workspace seleccionado. El selector no concede acceso por sí mismo.
  const grants = await persistence.many<WorkspaceGrantRow>(
    `SELECT grants.workspace_id,
            grants.is_default,
            memberships.role AS workspace_role,
            memberships.status AS workspace_status
     FROM api_key_workspaces AS grants
     JOIN workspace ON workspace.id = grants.workspace_id
     JOIN workspace_memberships AS memberships
       ON memberships.workspace_id = grants.workspace_id
      AND memberships.actor_id = $1
      AND memberships.status = 'active'
     WHERE grants.api_key_id = $2
       AND ($3::text IS NULL OR workspace.id = $3::text OR workspace.url_key = $3::text)
     ORDER BY grants.is_default DESC, grants.workspace_id`,
    [key.actor_id, key.id, workspaceSelector],
  );
  const grant = selectWorkspaceGrant(grants, workspaceSelector);

  const actorRow = await persistence.one<ActorIdentityRow>(
    `SELECT id, name, email, type, avatar_url, created_at, updated_at
     FROM actors WHERE id = $1`,
    [key.actor_id],
  );
  if (!actorRow) return null;
  const actor = {
    ...actorRow,
    workspace_role: grant.workspace_role,
    status: grant.workspace_status,
  };

  const scopes = await persistence.many<{ scope: ApiKeyScope }>(
    "SELECT scope FROM api_key_scopes WHERE api_key_id = $1 ORDER BY CASE scope WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 END",
    [key.id],
  );
  const teamRows = await persistence.many<{
    team_id: string;
    workspace_id: string;
    has_workspace_grant: boolean;
  }>(
    `SELECT limits.team_id,
            limits.workspace_id,
            EXISTS (
              SELECT 1
              FROM api_key_workspaces AS limit_grants
              WHERE limit_grants.api_key_id = limits.api_key_id
                AND limit_grants.workspace_id = limits.workspace_id
            ) AS has_workspace_grant
     FROM api_key_team_limits AS limits
     WHERE limits.api_key_id = $1
     ORDER BY limits.workspace_id, limits.team_id`,
    [key.id],
  );
  if (teamRows.some((row) => !row.has_workspace_grant)) {
    throw apiError("UNAUTHORIZED", "API key Team limits are not granted in a Workspace");
  }
  const teams = teamRows.filter((row) => row.workspace_id === grant.workspace_id);
  // Actualiza el uso solo después de validar toda la autenticación.
  await persistence.execute("UPDATE api_keys SET last_used_at = $1 WHERE id = $2", [now(), key.id]);
  return {
    actor,
    keyId: key.id,
    workspaceId: grant.workspace_id,
    workspaceRole: grant.workspace_role,
    workspaceStatus: grant.workspace_status,
    scopes: scopes.length ? scopes.map((row) => row.scope) : ["read", "write", "admin"],
    teamIds: teams.length ? teams.map((row) => row.team_id) : null,
    expiresAt: key.expires_at,
  };
}
