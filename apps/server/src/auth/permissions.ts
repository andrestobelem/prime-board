// Políticas de autorización del workspace (PRB-235).
import type { Database } from "bun:sqlite";
import type { ActorRow } from "./viewer.ts";
import { getApiKey } from "../domain/actors.ts";
import { getTeam } from "../domain/teams.ts";
import { isTeamOwner } from "../domain/team-memberships.ts";
import { apiError } from "../graphql/errors.ts";

export function isWorkspaceAdmin(actor: ActorRow): boolean {
  return actor.workspace_role === "admin";
}

export function assertWorkspaceAdmin(actor: ActorRow): void {
  if (!isWorkspaceAdmin(actor)) {
    throw apiError("UNAUTHORIZED", "Workspace admin permission is required");
  }
}

/** La configuración del team pertenece al admin del workspace o a sus owners. */
export function assertCanManageTeam(db: Database, viewer: ActorRow, teamId: string): void {
  if (isWorkspaceAdmin(viewer)) return;
  // El dominio conserva NOT_FOUND para mutations sobre teams inexistentes.
  if (!getTeam(db, { id: teamId })) return;
  if (!isTeamOwner(db, teamId, viewer.id)) {
    throw apiError("UNAUTHORIZED", "Team owner permission is required");
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
