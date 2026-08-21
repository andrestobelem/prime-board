import type { Persistence } from "../persistence.ts";
import { generateApiKey, hashApiKey } from "../../auth/keys.ts";
import {
  DEFAULT_WORKFLOW,
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_URL_KEY,
} from "../defaults.ts";
import { newId, now } from "../util.ts";

export interface PostgresBootstrapResult {
  created: boolean;
  adminApiKey?: string;
}

/** Inicializa el singleton Workspace y su actor admin en PostgreSQL. */
export async function bootstrapPostgres(
  persistence: Persistence,
): Promise<PostgresBootstrapResult> {
  if (await persistence.one("SELECT id FROM workspace LIMIT 1")) return { created: false };
  const apiKey = generateApiKey();
  const created = await persistence.transaction(async (tx) => {
    await tx.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      "prime-board-workspace-bootstrap",
    ]);
    if (await tx.one("SELECT id FROM workspace LIMIT 1")) return false;
    const timestamp = now();
    const workspaceId = newId();
    const teamId = newId();
    const adminId = newId();
    await tx.execute(
      `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [workspaceId, DEFAULT_WORKSPACE_NAME, DEFAULT_WORKSPACE_URL_KEY, timestamp],
    );
    await tx.execute(
      `INSERT INTO teams (id, name, key, description, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [teamId, "Prime Board", "PB", "Default team", timestamp],
    );
    let firstStateId: string | null = null;
    for (const [index, state] of DEFAULT_WORKFLOW.entries()) {
      const stateId = newId();
      firstStateId ??= stateId;
      await tx.execute(
        `INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [stateId, teamId, state.name, state.type, state.color, index, timestamp],
      );
    }
    await tx.execute("UPDATE teams SET default_state_id = $1 WHERE id = $2", [
      firstStateId,
      teamId,
    ]);
    await tx.execute(
      `INSERT INTO actors (id, name, type, workspace_role, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin', $4, $4)`,
      [adminId, "admin", "human", timestamp],
    );
    await tx.execute(
      `INSERT INTO api_keys (id, actor_id, name, hash, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId(), adminId, "admin bootstrap key", hashApiKey(apiKey), timestamp],
    );
    const keyId = await tx.one<{ id: string }>(
      "SELECT id FROM api_keys WHERE actor_id = $1 AND hash = $2",
      [adminId, hashApiKey(apiKey)],
    );
    for (const scope of ["read", "write", "admin"]) {
      await tx.execute("INSERT INTO api_key_scopes (api_key_id, scope) VALUES ($1, $2)", [
        keyId!.id,
        scope,
      ]);
    }
    await tx.execute(
      `INSERT INTO team_memberships (id, team_id, actor_id, role, created_at)
       VALUES ($1, $2, $3, 'owner', $4)`,
      [newId(), teamId, adminId, timestamp],
    );
    return true;
  });
  return created ? { created: true, adminApiKey: apiKey } : { created: false };
}
