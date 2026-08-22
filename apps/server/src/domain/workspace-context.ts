// Frontera de alcance del Workspace para cada request de API.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { getWorkspace } from "./workspaces.ts";

/**
 * Identidad efectiva del Workspace de una operación.
 *
 * En el modo actual siempre se resuelve al único Workspace de la instalación.
 * El caller no puede elegirlo mediante un input GraphQL; una futura selección
 * deberá resolverse desde autenticación/membership antes de construir el contexto.
 */
export interface WorkspaceContext {
  workspaceId: string;
}

export function resolveWorkspaceContext(db: Database, requestedId?: string): WorkspaceContext {
  const workspace = getWorkspace(db, requestedId);
  if (!workspace) throw apiError("NOT_FOUND", "Workspace is not initialized");
  return { workspaceId: workspace.id };
}

/** Rechaza referencias de entidades que no pertenezcan al Workspace efectivo. */
export function assertWorkspaceId(context: WorkspaceContext, workspaceId: string): void {
  if (workspaceId !== context.workspaceId) {
    throw apiError("NOT_FOUND", "Resource not found in the active Workspace");
  }
}
