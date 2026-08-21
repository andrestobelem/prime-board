// Bootstrap del primer arranque (spec §5): workspace, team default, actor admin
// y su API key, que se devuelve UNA sola vez para que el caller la muestre.
import type { Database } from "bun:sqlite";
import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { DEFAULT_WORKFLOW, DEFAULT_WORKSPACE_NAME, DEFAULT_WORKSPACE_URL_KEY } from "./defaults.ts";
import { newId, now } from "./util.ts";

export interface BootstrapResult {
  created: boolean;
  adminApiKey?: string;
}

export function seedTeamWorkflow(db: Database, teamId: string): void {
  const timestamp = now();
  const insert = db.query(
    "INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  );
  let firstId: string | null = null;
  DEFAULT_WORKFLOW.forEach((state, index) => {
    const id = newId();
    firstId ??= id;
    insert.run(id, teamId, state.name, state.type, state.color, index, timestamp, timestamp);
  });
  // El default queda explícito desde el arranque (AT-180): Backlog, no "el primero
  // por posición" — reordenar estados ya no lo cambia en silencio.
  db.query("UPDATE teams SET default_state_id = ?1 WHERE id = ?2").run(firstId, teamId);
}

/** Crea los datos iniciales si la DB está vacía. Idempotente entre reinicios. */
export function bootstrap(db: Database): BootstrapResult {
  const existing = db.query("SELECT id FROM workspace LIMIT 1").get();
  if (existing) {
    return { created: false };
  }

  const apiKey = generateApiKey();
  db.transaction(() => {
    const timestamp = now();
    db.query(
      "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).run(newId(), DEFAULT_WORKSPACE_NAME, DEFAULT_WORKSPACE_URL_KEY, timestamp, timestamp);

    const teamId = newId();
    db.query(
      "INSERT INTO teams (id, name, key, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).run(teamId, "Prime Board", "PB", "Default team", timestamp, timestamp);
    seedTeamWorkflow(db, teamId);

    const adminId = newId();
    db.query(
      "INSERT INTO actors (id, name, type, workspace_role, created_at, updated_at) VALUES (?1, ?2, ?3, 'admin', ?4, ?5)",
    ).run(adminId, "admin", "human", timestamp, timestamp);

    const bootstrapKeyId = newId();
    db.query(
      "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).run(bootstrapKeyId, adminId, "admin bootstrap key", hashApiKey(apiKey), timestamp);
    for (const scope of ["read", "write", "admin"]) {
      db.query("INSERT INTO api_key_scopes (api_key_id, scope) VALUES (?1, ?2)").run(
        bootstrapKeyId,
        scope,
      );
    }
    db.query(
      "INSERT INTO team_memberships (id, team_id, actor_id, role, created_at) VALUES (?1, ?2, ?3, 'owner', ?4)",
    ).run(newId(), teamId, adminId, timestamp);
  })();

  return { created: true, adminApiKey: apiKey };
}
