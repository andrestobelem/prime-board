// Configuración por variables de entorno con prefijo PRIME_BOARD_ (spec §2).
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePersistenceBackend, type PersistenceBackend } from "./db/backend.ts";

export type AuthMode = "api-key" | "local";

export interface Config {
  port: number;
  /** Interface where the HTTP server listens. Local auth always uses loopback. */
  host: string;
  /** Authentication mode. Local mode trusts only the loopback listener. */
  authMode: AuthMode;
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

function resolveAuthMode(value: string | undefined): AuthMode {
  if (!value || value === "api-key") return "api-key";
  if (value === "local") return "local";
  throw new Error(`Invalid PRIME_BOARD_AUTH_MODE: ${value}. Use api-key or local.`);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const authMode = resolveAuthMode(env.PRIME_BOARD_AUTH_MODE);
  return {
    port: Number(env.PRIME_BOARD_PORT ?? 3333),
    host: authMode === "local" ? "127.0.0.1" : (env.PRIME_BOARD_HOST ?? "0.0.0.0"),
    authMode,
    dbPath: env.PRIME_BOARD_DB ?? join(homedir(), ".prime-board", "prime-board.db"),
    postgresUrl: env.PRIME_BOARD_POSTGRES_URL,
    persistenceBackend: resolvePersistenceBackend(env.PRIME_BOARD_PERSISTENCE),
    dev: env.NODE_ENV !== "production",
    webDist: env.PRIME_BOARD_WEB_DIST ?? join(import.meta.dir, "..", "..", "web", "dist"),
    repoRoot: env.PRIME_BOARD_REPO ?? null,
  };
}
