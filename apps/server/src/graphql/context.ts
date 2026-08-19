// Contexto compartido por todos los resolvers.
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { ActorRow, AuthContext } from "../auth/viewer.ts";
import type { TrackedRepoSync } from "./repo-sync-dispatch.ts";
import type { WebhookDispatcher } from "../webhooks/dispatcher.ts";
import type { WorkspaceContext } from "../domain/workspace-context.ts";

export interface Context {
  db: Database;
  config: Config;
  /** Workspace efectivo; hoy siempre es el singleton de la instalación. */
  workspace: WorkspaceContext;
  viewer: ActorRow | null;
  /** Credencial efectiva, incluyendo límites por key; null para requests anónimos. */
  auth: AuthContext | null;
  events: WebhookDispatcher;
  /**
   * Replica del board en el repo; null si PRIME_BOARD_REPO no está configurado.
   * Es un TrackedRepoSync (AT-191): además de sync()/syncIssue() (lo único que
   * los resolvers necesitan saber), rastrea si se llamó a alguno, para que el
   * despacho automático de Mutation sepa si hace falta un sync de respaldo.
   */
  repo: TrackedRepoSync | null;
}
