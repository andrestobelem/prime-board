// Configuración por variables de entorno con prefijo PRIME_BOARD_ (spec §2).
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePersistenceBackend, type PersistenceBackend } from "./db/backend.ts";

export interface Config {
  port: number;
  dbPath: string;
  /** PostgreSQL URL used only when PRIME_BOARD_PERSISTENCE=postgres. */
  postgresUrl?: string;
  /** Backend elegido para la migración incremental; SQLite sigue siendo default. */
  persistenceBackend?: PersistenceBackend;
  dev: boolean;
  /** Carpeta con la UI buildeada (apps/web/dist); si no existe, la raíz responde JSON. */
  webDist: string;
  /** Raíz del repo donde replicar el board en cada escritura (AT-158). */
  repoRoot: string | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: Number(env.PRIME_BOARD_PORT ?? 3333),
    dbPath: env.PRIME_BOARD_DB ?? join(homedir(), ".prime-board", "prime-board.db"),
    postgresUrl: env.PRIME_BOARD_POSTGRES_URL,
    persistenceBackend: resolvePersistenceBackend(env.PRIME_BOARD_PERSISTENCE),
    dev: env.NODE_ENV !== "production",
    webDist: env.PRIME_BOARD_WEB_DIST ?? join(import.meta.dir, "..", "..", "web", "dist"),
    repoRoot: env.PRIME_BOARD_REPO ?? null,
  };
}
