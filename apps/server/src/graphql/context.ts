// Contexto compartido por todos los resolvers.
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { ActorRow } from "../auth/viewer.ts";

export interface Context {
  db: Database;
  config: Config;
  viewer: ActorRow | null;
}
