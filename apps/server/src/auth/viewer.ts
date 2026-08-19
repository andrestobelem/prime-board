// Resuelve el actor autenticado a partir del header Authorization (spec §5).
import type { Database } from "bun:sqlite";
import { hashApiKey } from "./keys.ts";
import { now } from "../db/util.ts";

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

export function resolveViewer(db: Database, authorization: string | null): ActorRow | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(pb_[A-Za-z0-9_-]+)$/);
  if (!match) return null;

  const hash = hashApiKey(match[1]!);
  // Cruzar la key con el actor antes de tocar last_used_at evita que una
  // credencial suspendida deje actividad y, sobre todo, que vuelva a operar.
  const key = db
    .query(
      `SELECT api_keys.id, api_keys.actor_id
       FROM api_keys JOIN actors ON actors.id = api_keys.actor_id
       WHERE api_keys.hash = ?1 AND api_keys.revoked_at IS NULL
         AND actors.status = 'active'`,
    )
    .get(hash) as {
    id: string;
    actor_id: string;
  } | null;
  if (!key) return null;

  db.query("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2").run(now(), key.id);
  return db.query("SELECT * FROM actors WHERE id = ?1").get(key.actor_id) as ActorRow | null;
}
