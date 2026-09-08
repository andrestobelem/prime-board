import type { WorkspaceContext } from "./workspace-context.ts";

/**
 * Predicados SQL para el esquema PostgreSQL de transición.
 *
 * PRB-678 agrega columnas de Workspace a las tablas de dominio. Las consultas
 * nuevas usan esas columnas. El adaptador legacy solo permite el singleton y
 * falla cerrado cuando hay más de un Workspace. Así ningún caller puede omitir
 * el límite por accidente.
 */
export type PostgresWorkspaceContext = WorkspaceContext;

export function workspaceIdOf(context: PostgresWorkspaceContext): string {
  return context.workspaceId;
}

export function workspaceColumnScope(alias: string, workspaceParam: string): string {
  return `${alias}.workspace_id = ${workspaceParam}`;
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
  return workspaceColumnScope(`${alias}`, workspaceParam);
}

export function issueIdWorkspaceScope(issueIdExpression: string, workspaceParam: string): string {
  return `EXISTS (SELECT 1 FROM issues AS scope_issue WHERE scope_issue.id = ${issueIdExpression} AND ${workspaceColumnScope("scope_issue", workspaceParam)})`;
}

export function projectWorkspaceScope(alias: string, workspaceParam: string): string {
  return workspaceColumnScope(`${alias}`, workspaceParam);
}

export function milestoneWorkspaceScope(alias: string, workspaceParam: string): string {
  return workspaceColumnScope(`${alias}`, workspaceParam);
}

export function labelWorkspaceScope(alias: string, workspaceParam: string): string {
  return workspaceColumnScope(`${alias}`, workspaceParam);
}

export function issueRelationWorkspaceScope(alias: string, workspaceParam: string): string {
  return workspaceColumnScope(alias, workspaceParam);
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
