import { openDatabase } from "./database.ts";
import { createSqlitePersistence } from "./sqlite-persistence.ts";
import { createPostgresPersistence } from "./postgres/persistence.ts";
import type { Persistence } from "./persistence.ts";

export type PersistenceBackend = "sqlite" | "postgres";

export interface PersistenceOptions {
  backend?: PersistenceBackend;
  path: string;
  /** PostgreSQL connection URL, required for the postgres backend. */
  url?: string;
}

/**
 * Resuelve el backend configurado sin exponer tipos del driver al dominio.
 * SQLite sigue siendo el fallback compatible durante la migración incremental;
 * PostgreSQL requiere una URL explícita y se cierra mediante el mismo contrato.
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
  if (!options.url) {
    throw new Error("PostgreSQL persistence backend requires a connection URL");
  }
  return createPostgresPersistence(
    new Bun.SQL({ url: options.url, max: 10, connectionTimeout: 5 }),
  );
}
