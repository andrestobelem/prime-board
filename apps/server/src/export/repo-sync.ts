// Sincronización con el repo en cada escritura (AT-158, Fase 3).
//
// Cada mutación deja el evento en el repo en el momento en que ocurre, no
// cuando alguien se acuerda de exportar: el repo es la copia durable y
// `rebuild` puede reconstruir la DB desde ahí en cualquier momento.
//
// Los logs son append-only y `.gitattributes` los marca `merge=union`, así
// dos agentes que escriben en branches distintas mergean sin conflicto
// (verificado experimentalmente en la investigación de AT-153).
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { exportBoard, exportIssue } from "./exporter.ts";

export interface RepoSync {
  /** Regenera el repo completo (cambios de metadata, borrados). */
  sync(): void;
  /** Camino caliente: reescribe solo el issue afectado (AT-166). */
  syncIssue(issueId: string): void;
  readonly root: string;
}

export function createRepoSync(db: Database, root: string | null): RepoSync | null {
  if (!root) return null;
  if (!existsSync(root)) {
    console.error(`PRIME_BOARD_REPO points to a missing directory: ${root}`);
    return null;
  }
  ensureGitAttributes(root);
  return {
    root,
    sync() {
      try {
        exportBoard(db, root);
      } catch (error) {
        // Nunca romper una mutación por un problema de escritura en el repo.
        console.error(`repo sync failed: ${error}`);
      }
    },
    syncIssue(issueId: string) {
      try {
        // Un repo vacío o histórico sin metadata todavía no es una réplica
        // reconstruible: inicializarlo con el export completo deja también la
        // identidad y el alcance del Workspace.
        const metadata = join(root, ".prime-board", "meta", "export.json");
        if (!existsSync(metadata) || !exportIssue(db, root, issueId)) exportBoard(db, root);
      } catch (error) {
        console.error(`repo sync failed: ${error}`);
      }
    },
  };
}

const UNION_RULE = ".prime-board/log/*.jsonl merge=union";

/** Deja el driver `union` configurado: sin esto, dos appends dan conflicto. */
export function ensureGitAttributes(root: string): void {
  const path = join(root, ".gitattributes");
  const current = existsSync(path) ? require("node:fs").readFileSync(path, "utf8") : "";
  if (current.includes(UNION_RULE)) return;
  const header = "# Los logs de prime-board son append-only: se mergean por unión.\n";
  const next = current
    ? `${current.replace(/\n*$/, "\n")}\n${header}${UNION_RULE}\n`
    : `${header}${UNION_RULE}\n`;
  require("node:fs").writeFileSync(path, next);
}
