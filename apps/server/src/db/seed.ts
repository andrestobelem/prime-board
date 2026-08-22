// Bootstrap y seed de Workspaces. Las credenciales se devuelven UNA sola vez.
import type { Database } from "bun:sqlite";
import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { DEFAULT_WORKFLOW, DEFAULT_WORKSPACE_NAME, DEFAULT_WORKSPACE_URL_KEY } from "./defaults.ts";
import { newId, now } from "./util.ts";

export interface BootstrapResult {
  created: boolean;
  adminApiKey?: string;
}

export interface WorkspaceSeedInput {
  name: string;
  urlKey: string;
  /** Actor que administra el Workspace. Por defecto, usa un admin activo existente. */
  adminActorId?: string;
  /** API key que solicitó el bootstrap del Workspace adicional. */
  apiKeyId?: string;
  /** Team inicial. Si no se indica, se elige una key disponible. */
  teamName?: string;
  teamKey?: string;
  workspaceId?: string;
}

export interface WorkspaceSeedResult {
  created: boolean;
  workspaceId: string;
  teamId: string;
  adminActorId: string;
  adminApiKey?: string;
}

export function seedTeamWorkflow(db: Database, teamId: string, workspaceId: string): void {
  const timestamp = now();
  const insert = db.query(
    "INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  );
  let firstId: string | null = null;
  DEFAULT_WORKFLOW.forEach((state, index) => {
    const id = newId();
    firstId ??= id;
    insert.run(
      id,
      teamId,
      state.name,
      state.type,
      state.color,
      index,
      timestamp,
      timestamp,
      workspaceId,
    );
  });
  db.query("UPDATE teams SET default_state_id = ?1 WHERE id = ?2").run(firstId, teamId);
}

function availableTeamKey(
  db: Database,
  requested: string | undefined,
  workspaceId: string,
  firstWorkspace: boolean,
): string {
  const preferred = requested?.trim().toUpperCase() || (firstWorkspace ? "PB" : "WS");
  const exists = (key: string): boolean =>
    Boolean(
      db.query("SELECT id FROM teams WHERE workspace_id = ?1 AND key = ?2").get(workspaceId, key),
    );
  if (!exists(preferred)) return preferred;
  if (requested) throw new Error(`Team key already exists: ${preferred}`);
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${preferred}${suffix}`;
    if (!exists(candidate)) return candidate;
  }
}

function findOrCreateAdmin(
  db: Database,
  input: WorkspaceSeedInput,
  timestamp: string,
  createApiKeyForNewActor: boolean,
): { id: string; apiKey?: string } {
  if (input.adminActorId) {
    const actor = db
      .query("SELECT id, status FROM actors WHERE id = ?1")
      .get(input.adminActorId) as {
      id: string;
      status: string;
    } | null;
    if (!actor) throw new Error("Workspace seed admin Actor not found");
    if (actor.status !== "active") throw new Error("Workspace seed admin Actor is not active");
    return { id: actor.id };
  }
  const existing = db
    .query(
      "SELECT id FROM actors WHERE workspace_role = 'admin' AND status = 'active' ORDER BY created_at, id LIMIT 1",
    )
    .get() as { id: string } | null;
  if (existing) return { id: existing.id };
  if (!createApiKeyForNewActor) {
    throw new Error("Workspace seed requires an active admin Actor");
  }
  const id = newId();
  db.query(
    "INSERT INTO actors (id, name, type, workspace_role, created_at, updated_at) VALUES (?1, 'admin', 'human', 'admin', ?2, ?2)",
  ).run(id, timestamp);
  const apiKey = generateApiKey();
  const keyId = newId();
  db.query(
    "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES (?1, ?2, 'admin bootstrap key', ?3, ?4)",
  ).run(keyId, id, hashApiKey(apiKey), timestamp);
  for (const scope of ["read", "write", "admin"]) {
    db.query("INSERT INTO api_key_scopes (api_key_id, scope) VALUES (?1, ?2)").run(keyId, scope);
  }
  return { id, apiKey };
}

/**
 * Siembra un Workspace y únicamente sus recursos iniciales.
 * Repetir el mismo urlKey no crea filas ni regenera credenciales.
 */
export function seedWorkspace(db: Database, input: WorkspaceSeedInput): WorkspaceSeedResult {
  const name = input.name.trim();
  const urlKey = input.urlKey.trim();
  if (!name) throw new Error("Workspace name cannot be empty");
  if (!urlKey) throw new Error("Workspace url key cannot be empty");

  const existing = db.query("SELECT id FROM workspace WHERE url_key = ?1").get(urlKey) as {
    id: string;
  } | null;
  if (existing) {
    const team = db
      .query("SELECT id FROM teams WHERE workspace_id = ?1 ORDER BY created_at, id LIMIT 1")
      .get(existing.id) as {
      id: string;
    } | null;
    const admin = db
      .query(
        "SELECT actor_id FROM workspace_memberships WHERE workspace_id = ?1 AND role = 'admin' ORDER BY created_at, actor_id LIMIT 1",
      )
      .get(existing.id) as { actor_id: string } | null;
    if (!team || !admin) throw new Error("Existing Workspace has incomplete seed data");
    return {
      created: false,
      workspaceId: existing.id,
      teamId: team.id,
      adminActorId: admin.actor_id,
    };
  }

  const firstWorkspace =
    (db.query("SELECT count(*) AS count FROM workspace").get() as { count: number }).count === 0;
  const timestamp = now();
  let result: WorkspaceSeedResult | null = null;
  db.transaction(() => {
    const workspaceId = input.workspaceId ?? newId();
    db.query(
      "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    ).run(workspaceId, name, urlKey, timestamp);

    const admin = findOrCreateAdmin(db, input, timestamp, firstWorkspace);
    if (
      input.apiKeyId &&
      db
        .query("SELECT 1 FROM api_key_team_limits WHERE api_key_id = ?1 LIMIT 1")
        .get(input.apiKeyId)
    ) {
      throw new Error("A Team-limited API key cannot create a Workspace");
    }
    // El trigger de compatibilidad crea esta Membership en el primer Workspace.
    // La inserción con conflicto mantiene ambos caminos idempotentes.
    db.query(
      `INSERT INTO workspace_memberships
       (id, workspace_id, actor_id, role, status, created_at, updated_at)
       SELECT ?1, ?2, id, 'admin', status, created_at, updated_at FROM actors WHERE id = ?3
       ON CONFLICT (workspace_id, actor_id) DO UPDATE SET role = 'admin'`,
    ).run(newId(), workspaceId, admin.id);

    const teamId = newId();
    const teamKey = availableTeamKey(db, input.teamKey, workspaceId, firstWorkspace);
    db.query(
      "INSERT INTO teams (id, workspace_id, name, key, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
    ).run(
      teamId,
      workspaceId,
      input.teamName?.trim() || "Prime Board",
      teamKey,
      "Default team",
      timestamp,
    );
    seedTeamWorkflow(db, teamId, workspaceId);
    db.query(
      "INSERT INTO team_memberships (id, team_id, actor_id, role, created_at, workspace_id) VALUES (?1, ?2, ?3, 'owner', ?4, ?5)",
    ).run(newId(), teamId, admin.id, timestamp, workspaceId);

    // Solo la credencial que inició la operación recibe el grant del nuevo
    // Workspace. No se amplían otras credenciales del mismo Actor.
    if (input.apiKeyId) {
      db.query(
        `INSERT OR IGNORE INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
         SELECT id, ?1, 0, ?2 FROM api_keys WHERE id = ?3 AND actor_id = ?4`,
      ).run(workspaceId, timestamp, input.apiKeyId, admin.id);
    }
    if (admin.apiKey) {
      const key = db
        .query(
          "SELECT id FROM api_keys WHERE actor_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .get(admin.id) as { id: string };
      db.query(
        "INSERT OR IGNORE INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at) VALUES (?1, ?2, 1, ?3)",
      ).run(key.id, workspaceId, timestamp);
    }
    result = {
      created: true,
      workspaceId,
      teamId,
      adminActorId: admin.id,
      ...(admin.apiKey ? { adminApiKey: admin.apiKey } : {}),
    };
  })();
  return result!;
}

/** Crea los datos iniciales si la DB está vacía. Idempotente entre reinicios. */
export function bootstrap(db: Database): BootstrapResult {
  const existing = db.query("SELECT id FROM workspace ORDER BY created_at, id LIMIT 1").get() as {
    id: string;
  } | null;
  if (existing) return { created: false };
  const result = seedWorkspace(db, {
    name: DEFAULT_WORKSPACE_NAME,
    urlKey: DEFAULT_WORKSPACE_URL_KEY,
    teamName: "Prime Board",
    teamKey: "PB",
  });
  return { created: result.created, adminApiKey: result.adminApiKey };
}
