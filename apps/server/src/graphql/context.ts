// Contexto compartido por todos los resolvers.
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { ActorRow, AuthContext } from "../auth/viewer.ts";
import type { TrackedRepoSync } from "./repo-sync-dispatch.ts";
import type { WebhookEventSink } from "../webhooks/dispatcher.ts";
import type { WorkspaceContext } from "../domain/workspace-context.ts";
import type { Persistence } from "../db/persistence.ts";

export interface Context {
  db: Database;
  config: Config;
  /** Base URL pública con el puerto efectivo del servidor. */
  baseUrl: string;
  /** Workspace efectivo; hoy siempre es el singleton de la instalación. */
  workspace: WorkspaceContext;
  viewer: ActorRow | null;
  /** Credencial efectiva, incluyendo límites por key; null para requests anónimos. */
  auth: AuthContext | null;
  events: WebhookEventSink;
  /**
   * Replica del board en el repo; null si PRIME_BOARD_REPO no está configurado.
   * Es un TrackedRepoSync (AT-191): preflight() reserva el lock y sync() /
   * syncIssue() dejan la reserva lista para completar cuando el resolver
   * termina. El despacho rastrea si se llamó a un sync de respaldo.
   */
  repo: TrackedRepoSync | null;
  /** Persistencia async usada por los dominios ya migrados a PostgreSQL. */
  persistence?: Persistence;
}
