// Políticas de autorización del workspace (PRB-235).
import type { Database } from "bun:sqlite";
import type { ActorRow } from "./viewer.ts";
import { getApiKey } from "../domain/actors.ts";
import { getTeam } from "../domain/teams.ts";
import { getProject, listProjectTeamIds } from "../domain/projects.ts";
import { isTeamMember, isTeamOwner } from "../domain/team-memberships.ts";
import { apiError } from "../graphql/errors.ts";

export function isWorkspaceAdmin(actor: ActorRow): boolean {
  return actor.workspace_role === "admin";
}

export function assertWorkspaceAdmin(actor: ActorRow): void {
  if (!isWorkspaceAdmin(actor)) {
    throw apiError("UNAUTHORIZED", "Workspace admin permission is required");
  }
}

export function assertCanUseImportFields(
  viewer: ActorRow,
  input: {
    number?: number | null;
    createdAt?: string | null;
    creatorId?: string | null;
    authorId?: string | null;
  },
): void {
  if (isWorkspaceAdmin(viewer)) return;
  if (
    input.number != null ||
    input.createdAt != null ||
    input.creatorId != null ||
    input.authorId != null
  ) {
    throw apiError(
      "UNAUTHORIZED",
      "Historical identity, dates, and issue numbers require workspace admin permission",
    );
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

/** Los issues y sus recursos dependientes pertenecen al team del issue. */
export function assertCanManageIssue(
  db: Database,
  viewer: ActorRow,
  teamId: string | null | undefined,
): void {
  if (isWorkspaceAdmin(viewer) || !teamId) return;
  if (!isTeamMember(db, teamId, viewer.id)) {
    throw apiError("UNAUTHORIZED", "Issue team membership is required");
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

/** Los proyectos quedan bajo los teams asociados: cualquier miembro autorizado puede gestionarlos. */
export function assertCanManageProject(db: Database, viewer: ActorRow, projectId: string): void {
  if (isWorkspaceAdmin(viewer)) return;
  const project = getProject(db, projectId);
  if (!project) return;
  const teamIds = listProjectTeamIds(db, projectId);
  if (teamIds.some((teamId) => isTeamMember(db, teamId, viewer.id))) return;
  throw apiError("UNAUTHORIZED", "Project team membership is required");
}

/** Autoriza la creación de un proyecto en todos sus teams destino. */
export function assertCanCreateProject(
  db: Database,
  viewer: ActorRow,
  teamIds?: string[] | null,
): void {
  if (isWorkspaceAdmin(viewer)) return;
  const destinations =
    teamIds == null
      ? db
          .query("SELECT id FROM teams ORDER BY id")
          .values()
          .map((row) => row[0] as string)
      : teamIds;
  // Deja que el dominio conserve sus errores de validación/not-found.
  if (destinations.length === 0) return;
  if (destinations.some((teamId) => !getTeam(db, { id: teamId }))) return;
  if (destinations.some((teamId) => !isTeamMember(db, teamId, viewer.id))) {
    throw apiError("UNAUTHORIZED", "Project team membership is required");
  }
}

/** Autoriza el reemplazo del conjunto de teams de un proyecto. */
export function assertCanManageProjectTeams(
  db: Database,
  viewer: ActorRow,
  teamIds: string[],
): void {
  if (isWorkspaceAdmin(viewer) || teamIds.length === 0) return;
  // La mutación debe poder seguir produciendo NOT_FOUND para teams inválidos.
  if (teamIds.some((teamId) => !getTeam(db, { id: teamId }))) return;
  if (teamIds.some((teamId) => !isTeamMember(db, teamId, viewer.id))) {
    throw apiError("UNAUTHORIZED", "Project team membership is required");
  }
}
