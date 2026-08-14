// Resuelve el actor autenticado a partir del header Authorization (spec §5).
import type { Database } from "bun:sqlite";
import { hashApiKey } from "./keys.ts";
import { now } from "../db/util.ts";

export interface ActorRow {
  id: string;
  name: string;
  email: string | null;
  type: "human" | "agent";
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export function resolveViewer(db: Database, authorization: string | null): ActorRow | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(pb_[A-Za-z0-9_-]+)$/);
  if (!match) return null;

  const hash = hashApiKey(match[1]!);
  const key = db
    .query("SELECT id, actor_id FROM api_keys WHERE hash = ?1")
    .get(hash) as { id: string; actor_id: string } | null;
  if (!key) return null;

  db.query("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2").run(now(), key.id);
  return db
    .query("SELECT * FROM actors WHERE id = ?1")
    .get(key.actor_id) as ActorRow | null;
}
