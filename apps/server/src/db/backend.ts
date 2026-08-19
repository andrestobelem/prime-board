import { openDatabase } from "./database.ts";
import { createSqlitePersistence } from "./sqlite-persistence.ts";
import type { Persistence } from "./persistence.ts";

export type PersistenceBackend = "sqlite" | "postgres";

export interface PersistenceOptions {
  backend?: PersistenceBackend;
  path: string;
}

/**
 * Resuelve el backend configurado sin exponer tipos del driver al dominio.
 * PostgreSQL queda reservado para su adaptador futuro; SQLite es el fallback
 * compatible durante la migración incremental.
 */
export function resolvePersistenceBackend(value: string | undefined): PersistenceBackend {
  if (value === undefined || value === "" || value === "sqlite") return "sqlite";
  if (value === "postgres") return "postgres";
  throw new Error(`Unsupported persistence backend: ${value}`);
}

export function openPersistence(options: PersistenceOptions): Persistence {
  const backend = options.backend ?? "sqlite";
  if (backend === "sqlite") {
    return createSqlitePersistence(openDatabase(options.path));
  }
  throw new Error("PostgreSQL persistence backend is not available yet");
}
