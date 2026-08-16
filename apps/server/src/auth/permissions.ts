// Políticas de autorización del workspace (PRB-235).
import type { Database } from "bun:sqlite";
import type { ActorRow } from "./viewer.ts";
import { getApiKey } from "../domain/actors.ts";
import { apiError } from "../graphql/errors.ts";

export function isWorkspaceAdmin(actor: ActorRow): boolean {
  return actor.workspace_role === "admin";
}

export function assertWorkspaceAdmin(actor: ActorRow): void {
  if (!isWorkspaceAdmin(actor)) {
    throw apiError("UNAUTHORIZED", "Workspace admin permission is required");
  }
}

export function assertCanManageActor(viewer: ActorRow, actorId: string): void {
  if (!isWorkspaceAdmin(viewer) && viewer.id !== actorId) {
    throw apiError("UNAUTHORIZED", "You can only manage your own actor");
  }
}

export function assertCanManageApiKey(db: Database, viewer: ActorRow, keyId: string): void {
  const key = getApiKey(db, keyId);
  if (!key || isWorkspaceAdmin(viewer) || key.actor_id === viewer.id) return;
  throw apiError("UNAUTHORIZED", "You can only manage your own API keys");
}
