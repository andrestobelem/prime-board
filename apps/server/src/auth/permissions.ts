// Políticas de autorización del workspace (PRB-235).
import type { Database } from "bun:sqlite";
import type { ActorRow, AuthContext } from "./viewer.ts";
import type { ApiKeyScope } from "../domain/actors.ts";
import type { Context } from "../graphql/context.ts";
import { getApiKey } from "../domain/actors.ts";
import { assertTeamActive, getTeam } from "../domain/teams.ts";
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
  // El dominio conserva NOT_FOUND para mutations sobre teams inexistentes.
  if (!getTeam(db, { id: teamId })) return;
  assertTeamActive(db, teamId);
  if (isWorkspaceAdmin(viewer)) return;
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
  if (!teamId) return;
  assertTeamActive(db, teamId);
  if (isWorkspaceAdmin(viewer)) return;
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
  const destinations =
    teamIds == null
      ? db
          .query("SELECT id FROM teams WHERE archived_at IS NULL ORDER BY id")
          .values()
          .map((row) => row[0] as string)
      : teamIds;
  // Deja que el dominio conserve sus errores de validación/not-found.
  if (destinations.length === 0) return;
  if (destinations.some((teamId) => !getTeam(db, { id: teamId }))) return;
  for (const teamId of destinations) assertTeamActive(db, teamId);
  if (isWorkspaceAdmin(viewer)) return;
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
  if (teamIds.length === 0) return;
  // La mutación debe poder seguir produciendo NOT_FOUND para teams inválidos.
  if (teamIds.some((teamId) => !getTeam(db, { id: teamId }))) return;
  for (const teamId of teamIds) assertTeamActive(db, teamId);
  if (isWorkspaceAdmin(viewer)) return;
  if (teamIds.some((teamId) => !isTeamMember(db, teamId, viewer.id))) {
    throw apiError("UNAUTHORIZED", "Project team membership is required");
  }
}

const SCOPE_LEVEL: Record<ApiKeyScope, number> = { read: 1, write: 2, admin: 3 };

/** La jerarquía permite que ADMIN incluya WRITE y READ, y WRITE incluya READ. */
export function hasApiKeyScope(auth: AuthContext | null, required: ApiKeyScope): boolean {
  if (!auth) return false;
  const requiredLevel = SCOPE_LEVEL[required] ?? 0;
  return auth.scopes.some((scope) => (SCOPE_LEVEL[scope] ?? 0) >= requiredLevel);
}

export function assertApiKeyScope(context: Context, required: ApiKeyScope): void {
  if (!context.auth || !hasApiKeyScope(context.auth, required)) {
    throw apiError("UNAUTHORIZED", `API key scope ${required.toUpperCase()} is required`);
  }
}

/** Un límite vacío/null representa todos los Teams por compatibilidad. */
export function hasApiKeyTeamLimit(auth: AuthContext | null): boolean {
  return Boolean(auth?.teamIds);
}

export function apiKeyTeamsWithinLimit(
  auth: AuthContext | null,
  teamIds: readonly string[],
): boolean {
  if (!auth?.teamIds) return true;
  const allowed = new Set(auth.teamIds);
  return teamIds.every((teamId) => allowed.has(teamId));
}

export function assertApiKeyTeams(context: Context, teamIds: readonly string[]): void {
  if (!apiKeyTeamsWithinLimit(context.auth, teamIds)) {
    throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
  }
}

export function assertUnrestrictedApiKey(context: Context): void {
  if (hasApiKeyTeamLimit(context.auth)) {
    throw apiError("UNAUTHORIZED", "This operation requires an unrestricted API key");
  }
}

export function scopesWithin(
  parent: readonly ApiKeyScope[],
  child: readonly ApiKeyScope[],
): boolean {
  const parentLevel = parent.reduce((level, scope) => Math.max(level, SCOPE_LEVEL[scope] ?? 0), 0);
  return child.every((scope) => (SCOPE_LEVEL[scope] ?? 0) <= parentLevel);
}

export function teamIdsWithin(parent: string[] | null, child: string[] | null): boolean {
  if (!parent) return true;
  if (!child) return false;
  const allowed = new Set(parent);
  return child.every((teamId) => allowed.has(teamId));
}

export function assertChildApiKey(
  context: Context,
  target: ActorRow,
  input: { scopes?: readonly string[] | null; teamIds?: readonly string[] | null },
  normalized: { scopes: ApiKeyScope[]; teamIds: string[] },
): void {
  // ADMIN in a member's key is only a declared upper bound: the existing
  // actor role checks still reject every workspace-admin operation.
  if (context.auth && context.viewer?.id === target.id) {
    if (!scopesWithin(context.auth.scopes, normalized.scopes)) {
      throw apiError("UNAUTHORIZED", "A key cannot mint scopes beyond its own capabilities");
    }
    if (
      !teamIdsWithin(context.auth.teamIds, normalized.teamIds.length ? normalized.teamIds : null)
    ) {
      throw apiError("UNAUTHORIZED", "A key cannot mint access beyond its Team limits");
    }
  }
}
