import type { WorkspaceContext } from "./workspace-context.ts";

/**
 * Predicados SQL para el esquema PostgreSQL de transición.
 *
 * PRB-678 agrega columnas de Workspace a las tablas de dominio. Mientras esa
 * migración no exista, el grafo de pertenencia es la única fuente segura de
 * alcance: los Teams se vinculan mediante Memberships activas y los recursos
 * dependientes heredan ese límite. Este adaptador evita lookups sin alcance.
 */
export type PostgresWorkspaceContext = WorkspaceContext;

export function workspaceIdOf(context: PostgresWorkspaceContext): string {
  return context.workspaceId;
}

export function actorWorkspaceScope(alias: string, workspaceParam: string): string {
  return `EXISTS (
    SELECT 1
      FROM workspace_memberships AS scope_actor_membership
     WHERE scope_actor_membership.actor_id = ${alias}.id
       AND scope_actor_membership.workspace_id = ${workspaceParam}
       AND scope_actor_membership.status = 'active'
  )`;
}

export function workspaceMembershipScope(alias: string, workspaceParam: string): string {
  return `${alias}.workspace_id = ${workspaceParam} AND ${alias}.status = 'active'`;
}

export function teamWorkspaceScope(teamIdExpression: string, workspaceParam: string): string {
  return `EXISTS (
    SELECT 1
      FROM team_memberships AS scope_team_membership
      JOIN workspace_memberships AS scope_team_workspace
        ON scope_team_workspace.actor_id = scope_team_membership.actor_id
       AND scope_team_workspace.workspace_id = ${workspaceParam}
       AND scope_team_workspace.status = 'active'
     WHERE scope_team_membership.team_id = ${teamIdExpression}
  )`;
}

export function issueWorkspaceScope(alias: string, workspaceParam: string): string {
  return teamWorkspaceScope(`${alias}.team_id`, workspaceParam);
}

export function issueIdWorkspaceScope(issueIdExpression: string, workspaceParam: string): string {
  return `EXISTS (
    SELECT 1
      FROM issues AS scope_issue
     WHERE scope_issue.id = ${issueIdExpression}
       AND ${issueWorkspaceScope("scope_issue", workspaceParam)}
  )`;
}

export function projectWorkspaceScope(alias: string, workspaceParam: string): string {
  return `EXISTS (
    SELECT 1
      FROM project_teams AS scope_project_team
     WHERE scope_project_team.project_id = ${alias}.id
       AND ${teamWorkspaceScope("scope_project_team.team_id", workspaceParam)}
  )`;
}

export function milestoneWorkspaceScope(alias: string, workspaceParam: string): string {
  return `EXISTS (
    SELECT 1
      FROM projects AS scope_milestone_project
     WHERE scope_milestone_project.id = ${alias}.project_id
       AND ${projectWorkspaceScope("scope_milestone_project", workspaceParam)}
  )`;
}

export function labelWorkspaceScope(alias: string, workspaceParam: string): string {
  // Las Labels globales no tienen owner en el esquema de transición. Solo se
  // exponen mientras la base conserva el singleton documentado. Al agregar
  // otro Workspace se ocultan para cerrar la fuga. Las Labels de Team heredan
  // el alcance del Team.
  return `(
    (${alias}.team_id IS NOT NULL AND ${teamWorkspaceScope(`${alias}.team_id`, workspaceParam)})
    OR (${alias}.team_id IS NULL AND (SELECT count(*) FROM workspace) = 1)
  )`;
}

export function issueRelationWorkspaceScope(alias: string, workspaceParam: string): string {
  return `(${issueIdWorkspaceScope(`${alias}.issue_id`, workspaceParam)} AND ${issueIdWorkspaceScope(`${alias}.related_id`, workspaceParam)})`;
}

/** Devuelve un límite de compatibilidad que solo permite el singleton legacy. */
export function legacyWorkspaceScope(): string {
  return "(SELECT count(*) FROM workspace) = 1";
}

export function scopedWorkspacePredicate(
  context: PostgresWorkspaceContext | undefined,
  predicate: (workspaceParam: string) => string,
  workspaceParam: string,
): string {
  return context ? predicate(workspaceParam) : legacyWorkspaceScope();
}
