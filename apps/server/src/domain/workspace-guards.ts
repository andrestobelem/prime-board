// Guards de acceso por Workspace para lecturas y referencias GraphQL.
//
// El modelo operativo sigue siendo single-workspace: las tablas no tienen una
// columna workspace_id y no se agrega una migración para simularla. Este módulo
// concentra la frontera para que los lookups no vuelvan a aceptar referencias
// desnudas cuando el modelo soporte más de un Workspace.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { getWorkspace } from "./workspaces.ts";
import { assertWorkspaceId, type WorkspaceContext } from "./workspace-context.ts";
import { getActor } from "./actors.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { getIssue, getIssueByRef, listChildren, listIssues, type IssueRow } from "./issues.ts";
import { getProject, type ProjectRow } from "./projects.ts";
import { getTeam, type TeamRow } from "./teams.ts";
import { listWebhooks } from "./webhooks.ts";
import { listRelations, type RelationView } from "./relations.ts";
import type { WebhookRow } from "../webhooks/dispatcher.ts";

/** El subconjunto de Context que necesitan los guards; evita un ciclo de imports. */
export interface WorkspaceLookupContext {
  db: Database;
  workspace: WorkspaceContext;
}

/**
 * Comprueba que el contexto todavía apunta a un Workspace operativo.
 *
 * `resolveWorkspaceContext` ya hace esta comprobación al construir el contexto,
 * pero repetirla en el seam de lookup evita que un resolver futuro pueda saltar
 * la frontera pasando un contexto fabricado o stale.
 */
export function assertActiveWorkspace(context: WorkspaceLookupContext): void {
  const active = getWorkspace(context.db, context.workspace.workspaceId);
  if (!active) throw apiError("NOT_FOUND", "Workspace is not initialized");
  assertWorkspaceId(context.workspace, active.id);
}

/**
 * Valida la pertenencia de una fila cuando una versión futura del modelo la
 * exponga. En el modelo actual todas las filas de la DB operativa pertenecen al
 * único Workspace, por lo que se valida únicamente el contexto activo.
 */
export function scopeWorkspaceRow<T extends object>(context: WorkspaceLookupContext, row: T): T {
  assertActiveWorkspace(context);
  const candidate = row as T & { workspace_id?: unknown; workspaceId?: unknown };
  const rowWorkspaceId = candidate.workspace_id ?? candidate.workspaceId;
  if (typeof rowWorkspaceId === "string") {
    assertWorkspaceId(context.workspace, rowWorkspaceId);
  }
  return row;
}

export function scopeWorkspaceRows<T extends object>(
  context: WorkspaceLookupContext,
  rows: T[],
): T[] {
  assertActiveWorkspace(context);
  return rows.filter((row) => {
    const candidate = row as T & { workspace_id?: unknown; workspaceId?: unknown };
    const rowWorkspaceId = candidate.workspace_id ?? candidate.workspaceId;
    return typeof rowWorkspaceId !== "string" || rowWorkspaceId === context.workspace.workspaceId;
  });
}

export function lookupIssue(context: WorkspaceLookupContext, ref: string): IssueRow | null {
  const row = getIssueByRef(context.db, ref);
  if (!row) {
    assertActiveWorkspace(context);
    return null;
  }
  return scopeWorkspaceRow(context, row);
}

export function requireIssue(context: WorkspaceLookupContext, ref: string): IssueRow {
  const row = lookupIssue(context, ref);
  if (!row) throw apiError("NOT_FOUND", `Issue not found: ${ref}`);
  return row;
}

export function listIssuesInWorkspace<T extends Parameters<typeof listIssues>[1]>(
  context: WorkspaceLookupContext,
  options: T,
): ReturnType<typeof listIssues> {
  const page = listIssues(context.db, options);
  return { ...page, rows: scopeWorkspaceRows(context, page.rows) };
}

export function listChildrenInWorkspace(
  context: WorkspaceLookupContext,
  issueId: string,
  includeArchived = false,
): IssueRow[] {
  return scopeWorkspaceRows(context, listChildren(context.db, issueId, includeArchived));
}

export function listRelationsInWorkspace(
  context: WorkspaceLookupContext,
  issueId: string,
): RelationView[] {
  return listRelations(context.db, issueId).filter((relation) => {
    // listRelations ya parte de un issue scoped; filtrar el otro extremo evita
    // que un relation huérfano llegue a un nested resolver obligatorio.
    return lookupIssueById(context, relation.relatedId) !== null;
  });
}

export function lookupIssueById(context: WorkspaceLookupContext, id: string): IssueRow | null {
  const row = getIssue(context.db, id);
  if (!row) {
    assertActiveWorkspace(context);
    return null;
  }
  return scopeWorkspaceRow(context, row);
}

export function lookupTeam(
  context: WorkspaceLookupContext,
  ref: { id?: string | null; key?: string | null },
): TeamRow | null {
  const row = getTeam(context.db, ref);
  if (!row) {
    assertActiveWorkspace(context);
    return null;
  }
  return scopeWorkspaceRow(context, row);
}

export function requireTeam(
  context: WorkspaceLookupContext,
  ref: { id?: string | null; key?: string | null },
): TeamRow {
  const row = lookupTeam(context, ref);
  if (!row) {
    const reference = ref.id ?? ref.key ?? "";
    throw apiError("NOT_FOUND", `Team not found: ${reference}`);
  }
  return row;
}

export function lookupProject(context: WorkspaceLookupContext, id: string): ProjectRow | null {
  const row = getProject(context.db, id);
  if (!row) {
    assertActiveWorkspace(context);
    return null;
  }
  return scopeWorkspaceRow(context, row);
}

export function requireProject(context: WorkspaceLookupContext, id: string): ProjectRow {
  const row = lookupProject(context, id);
  if (!row) throw apiError("NOT_FOUND", `Project not found: ${id}`);
  return row;
}

export function lookupActor(context: WorkspaceLookupContext, id: string): ActorRow | null {
  const row = getActor(context.db, id);
  if (!row) {
    assertActiveWorkspace(context);
    return null;
  }
  return scopeWorkspaceRow(context, row);
}

export function requireActor(context: WorkspaceLookupContext, id: string): ActorRow {
  const row = lookupActor(context, id);
  if (!row) throw apiError("NOT_FOUND", `Actor not found: ${id}`);
  return row;
}

export function listActorsInWorkspace(
  context: WorkspaceLookupContext,
  type?: string | null,
): ActorRow[] {
  assertActiveWorkspace(context);
  const query = `
    SELECT actors.id, actors.name, actors.email, actors.type,
           memberships.role AS workspace_role,
           memberships.status AS status,
           actors.avatar_url, actors.created_at, actors.updated_at
      FROM actors
      JOIN workspace_memberships AS memberships
        ON memberships.actor_id = actors.id
       AND memberships.workspace_id = ?1
     ${type ? "WHERE actors.type = ?2" : ""}
     ORDER BY actors.created_at, actors.id`;
  return (
    type
      ? context.db.query(query).all(context.workspace.workspaceId, type)
      : context.db.query(query).all(context.workspace.workspaceId)
  ) as ActorRow[];
}

/**
 * Lista Webhooks después de cruzar la frontera. El filtro de ownership sigue
 * siendo responsabilidad del dominio; este helper solo fija el Workspace.
 */
export function listWebhooksInWorkspace(
  context: WorkspaceLookupContext,
  actorId: string,
  isAdmin: boolean,
): WebhookRow[] {
  return scopeWorkspaceRows(context, listWebhooks(context.db, actorId, isAdmin));
}

export function lookupWebhook(context: WorkspaceLookupContext, id: string): WebhookRow | null {
  const row = context.db.query("SELECT * FROM webhooks WHERE id = ?1").get(id) as WebhookRow | null;
  if (!row) {
    assertActiveWorkspace(context);
    return null;
  }
  return scopeWorkspaceRow(context, row);
}

export function requireWebhook(context: WorkspaceLookupContext, id: string): WebhookRow {
  const row = lookupWebhook(context, id);
  if (!row) throw apiError("NOT_FOUND", `Webhook not found: ${id}`);
  return row;
}

/**
 * Un relation solo es visible si ambos extremos resuelven dentro del Workspace.
 * Así un nested resolver no puede convertir una fila parcialmente huérfana en
 * una referencia cross-workspace cuando el esquema evolucione.
 */
export interface ScopedRelationRow {
  id: string;
  issue_id: string;
  related_id: string;
  type: "blocks" | "related" | "duplicate_of";
  created_at: string;
}

export function lookupRelation(
  context: WorkspaceLookupContext,
  id: string,
): ScopedRelationRow | null {
  const row = context.db
    .query("SELECT * FROM issue_relations WHERE id = ?1")
    .get(id) as ScopedRelationRow | null;
  if (!row) {
    assertActiveWorkspace(context);
    return null;
  }
  scopeWorkspaceRow(context, row);
  if (!lookupIssueById(context, row.issue_id) || !lookupIssueById(context, row.related_id)) {
    return null;
  }
  return row;
}

export function requireRelation(context: WorkspaceLookupContext, id: string): ScopedRelationRow {
  const row = lookupRelation(context, id);
  if (!row) throw apiError("NOT_FOUND", `Relation not found: ${id}`);
  return row;
}
