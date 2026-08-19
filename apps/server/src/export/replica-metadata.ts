// Metadatos versionados de la Repository Replica.
//
// El formato mantiene un scope legible (`workspace` o `team:KEY`) para que los
// exports existentes sigan siendo fáciles de inspeccionar, pero agrega la
// identidad estable del Workspace. El importador acepta la forma histórica sin
// versión como compatibilidad de lectura; las escrituras siempre usan v1.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REPLICA_METADATA_VERSION = 1 as const;
export const WORKSPACE_SCOPE = "workspace" as const;

type TeamScope = `team:${string}`;
export type ReplicaScope = typeof WORKSPACE_SCOPE | TeamScope;

export interface ReplicaMetadata {
  version: typeof REPLICA_METADATA_VERSION;
  workspaceId: string;
  scope: ReplicaScope;
}

export interface LegacyReplicaMetadata {
  /** Exports anteriores a PRB-403 no declaraban una versión ni workspaceId. */
  version: null;
  workspaceId: null;
  scope: ReplicaScope;
}

export type ReadReplicaMetadata = ReplicaMetadata | LegacyReplicaMetadata;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseScope(value: unknown): ReplicaScope {
  // La cadena compacta es la representación en disco de v1 y la histórica.
  if (value === WORKSPACE_SCOPE) return WORKSPACE_SCOPE;
  if (typeof value === "string" && /^team:[A-Z][A-Z0-9]{0,7}$/.test(value)) {
    return value as TeamScope;
  }

  // Lee la forma objeto reservada para un formato futuro, sin emitirla ni
  // habilitarla hoy. Así el rechazo queda explícito en vez de tratar en silencio
  // otro alcance como un reemplazo de todo el Workspace.
  if (isRecord(value) && value.kind === "workspace") return WORKSPACE_SCOPE;
  if (
    isRecord(value) &&
    value.kind === "team" &&
    typeof value.teamKey === "string" &&
    /^[A-Z][A-Z0-9]{0,7}$/.test(value.teamKey)
  ) {
    return `team:${value.teamKey}`;
  }

  throw new Error(`Invalid export scope: ${String(value)}`);
}

/** Valida metadatos de la réplica sin inferir un alcance por ausencia de campos. */
export function parseReplicaMetadata(value: unknown): ReadReplicaMetadata {
  if (!isRecord(value)) throw new Error("Invalid meta/export.json: expected object");

  const scope = parseScope(value.scope);
  const hasVersion = Object.prototype.hasOwnProperty.call(value, "version");
  const hasWorkspaceId = Object.prototype.hasOwnProperty.call(value, "workspaceId");

  if (!hasVersion && !hasWorkspaceId) {
    return { version: null, workspaceId: null, scope };
  }
  if (value.version !== REPLICA_METADATA_VERSION) {
    throw new Error(`Invalid export metadata version: ${String(value.version)}`);
  }
  if (!nonEmptyString(value.workspaceId)) {
    throw new Error("Invalid export metadata: workspaceId is required");
  }
  return {
    version: REPLICA_METADATA_VERSION,
    workspaceId: value.workspaceId,
    scope,
  };
}

export function createReplicaMetadata(
  workspaceId: string,
  scope: ReplicaScope = WORKSPACE_SCOPE,
): ReplicaMetadata {
  if (!nonEmptyString(workspaceId)) throw new Error("Invalid workspace id");
  // Ejecuta la misma validación usada para leer datos del disco.
  const parsed = parseReplicaMetadata({
    version: REPLICA_METADATA_VERSION,
    workspaceId,
    scope,
  });
  if (parsed.version === null || parsed.workspaceId === null) {
    throw new Error("Invalid replica metadata");
  }
  return parsed;
}

export function readReplicaMetadata(rootDir: string): ReadReplicaMetadata | null {
  const path = join(rootDir, ".prime-board", "meta", "export.json");
  if (!existsSync(path)) return null;
  try {
    return parseReplicaMetadata(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Invalid meta/export.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Obtiene la identidad del único Workspace operativo para exportarla. */
export function getReplicaWorkspaceId(db: Database): string {
  const rows = db.query("SELECT id FROM workspace ORDER BY id").all() as Array<{ id: string }>;
  if (rows.length === 0 || !nonEmptyString(rows[0]!.id)) {
    throw new Error("Workspace is not initialized");
  }
  if (rows.length > 1) {
    throw new Error(
      "Cannot export a multi-Workspace database: target scoping is reserved for a future topology",
    );
  }
  return rows[0]!.id;
}
