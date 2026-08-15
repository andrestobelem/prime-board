// Contexto compartido por todos los resolvers.
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { ActorRow } from "../auth/viewer.ts";
import type { RepoSync } from "../export/repo-sync.ts";
import type { WebhookDispatcher } from "../webhooks/dispatcher.ts";

export interface Context {
  db: Database;
  config: Config;
  viewer: ActorRow | null;
  events: WebhookDispatcher;
  /** Replica del board en el repo; null si PRIME_BOARD_REPO no está configurado. */
  repo: RepoSync | null;
}
