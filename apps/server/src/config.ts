// Configuración por variables de entorno con prefijo PRIME_BOARD_ (spec §2).
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  dbPath: string;
  dev: boolean;
  /** Carpeta con la UI buildeada (apps/web/dist); si no existe, la raíz responde JSON. */
  webDist: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: Number(env.PRIME_BOARD_PORT ?? 3333),
    dbPath: env.PRIME_BOARD_DB ?? join(homedir(), ".prime-board", "prime-board.db"),
    dev: env.NODE_ENV !== "production",
    webDist: env.PRIME_BOARD_WEB_DIST ?? join(import.meta.dir, "..", "..", "web", "dist"),
  };
}
