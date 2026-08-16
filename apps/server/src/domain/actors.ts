// Dominio de actores (humanos y agentes) y sus API keys.
import type { Database } from "bun:sqlite";
import type { ActorRow } from "../auth/viewer.ts";
import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";

export function mapActor(row: ActorRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    type: row.type,
    createdAt: row.created_at,
  };
}

export function getActor(db: Database, id: string): ActorRow | null {
  return db.query("SELECT * FROM actors WHERE id = ?1").get(id) as ActorRow | null;
}

export function listActors(db: Database, type?: string | null): ActorRow[] {
  if (type) {
    return db
      .query("SELECT * FROM actors WHERE type = ?1 ORDER BY created_at")
      .all(type) as ActorRow[];
  }
  return db.query("SELECT * FROM actors ORDER BY created_at").all() as ActorRow[];
}

export function createActor(
  db: Database,
  input: { name: string; type: string; email?: string | null },
): ActorRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Actor name cannot be empty");
  if (input.type !== "human" && input.type !== "agent") {
    throw apiError("VALIDATION_FAILED", `Invalid actor type: ${input.type}`);
  }
  const duplicate = db.query("SELECT id FROM actors WHERE lower(name) = lower(?1)").get(name);
  if (duplicate) throw apiError("VALIDATION_FAILED", "Actor name already exists");
  const id = newId();
  const timestamp = now();
  db.query(
    "INSERT INTO actors (id, name, email, type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(id, name, input.email ?? null, input.type, timestamp, timestamp);
  return getActor(db, id)!;
}

export function updateActor(
  db: Database,
  id: string,
  input: { name?: string | null; email?: string | null },
): ActorRow {
  const existing = getActor(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Actor not found");

  const name = input.name === undefined || input.name === null ? existing.name : input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Actor name cannot be empty");
  const duplicate = db
    .query("SELECT id FROM actors WHERE lower(name) = lower(?1) AND id <> ?2")
    .get(name, id);
  if (duplicate) throw apiError("VALIDATION_FAILED", "Actor name already exists");

  const email = input.email === undefined ? existing.email : input.email?.trim() || null;
  db.query("UPDATE actors SET name = ?1, email = ?2, updated_at = ?3 WHERE id = ?4").run(
    name,
    email,
    now(),
    id,
  );
  return getActor(db, id)!;
}

export interface ApiKeyRow {
  id: string;
  actor_id: string;
  name: string;
  hash: string;
  last_used_at: string | null;
  created_at: string;
}

export function mapApiKey(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    actorId: row.actor_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function listApiKeys(db: Database, actorId: string): ApiKeyRow[] {
  return db
    .query("SELECT * FROM api_keys WHERE actor_id = ?1 ORDER BY created_at")
    .all(actorId) as ApiKeyRow[];
}

export function deleteApiKey(db: Database, id: string): boolean {
  const existing = db.query("SELECT id FROM api_keys WHERE id = ?1").get(id);
  if (!existing) throw apiError("NOT_FOUND", "API key not found");
  db.query("DELETE FROM api_keys WHERE id = ?1").run(id);
  return true;
}

/** Crea una key para un actor. Devuelve la key en claro UNA sola vez. */
export function createApiKey(
  db: Database,
  input: { actorId: string; name: string },
): { row: ApiKeyRow; key: string } {
  const actor = getActor(db, input.actorId);
  if (!actor) throw apiError("NOT_FOUND", "Actor not found");
  if (!input.name.trim()) throw apiError("VALIDATION_FAILED", "API key name cannot be empty");

  const key = generateApiKey();
  const id = newId();
  db.query(
    "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(id, input.actorId, input.name.trim(), hashApiKey(key), now());
  const row = db.query("SELECT * FROM api_keys WHERE id = ?1").get(id) as ApiKeyRow;
  return { row, key };
}
