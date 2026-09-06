import { createHash } from "node:crypto";
import baseline from "./0001_baseline.sql" with { type: "text" };
import workspaceSingleton from "./0002_workspace_singleton.sql" with { type: "text" };
import actorNameUnique from "./0003_actor_name_unique.sql" with { type: "text" };
import issueSearch from "./0004_issue_search.sql" with { type: "text" };
import documents from "./0005_documents.sql" with { type: "text" };
import issueSubscribers from "./0006_issue_subscribers.sql" with { type: "text" };
import workspaceAuth from "./0007_workspace_auth.sql" with { type: "text" };
import apiKeyTeamLimitsWorkspace from "./0008_api_key_team_limits_workspace.sql" with { type: "text" };
import apiKeyWorkspaceGrantScope from "./0009_api_key_workspace_grant_scope.sql" with { type: "text" };
import projectorCheckpoints from "./0010_projector_checkpoints.sql" with { type: "text" };
import documentsRetirement from "./0011_documents_retirement.sql" with { type: "text" };
import planningSettings from "./0012_planning_settings.sql" with { type: "text" };
import { verifyDocumentRows } from "../../export/documents-archive.ts";

export interface PostgresMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
  { version: 1, name: "baseline", sql: baseline },
  { version: 2, name: "workspace_singleton", sql: workspaceSingleton },
  { version: 3, name: "actor_name_unique", sql: actorNameUnique },
  { version: 4, name: "issue_search", sql: issueSearch },
  { version: 5, name: "documents", sql: documents },
  { version: 6, name: "issue_subscribers", sql: issueSubscribers },
  { version: 7, name: "workspace_auth", sql: workspaceAuth },
  { version: 8, name: "api_key_team_limits_workspace", sql: apiKeyTeamLimitsWorkspace },
  { version: 9, name: "api_key_workspace_grant_scope", sql: apiKeyWorkspaceGrantScope },
  { version: 10, name: "projector_checkpoints", sql: projectorCheckpoints },
  { version: 11, name: "documents_retirement", sql: documentsRetirement },
  { version: 12, name: "planning_settings", sql: planningSettings },
];

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export type PostgresSql = Bun.SQL;

export class PostgresMigrationError extends Error {
  readonly version?: number;
  readonly code: "INVALID_REGISTRY" | "CHECKSUM_MISMATCH" | "MIGRATION_FAILED";
  override readonly cause: unknown;

  constructor(
    code: PostgresMigrationError["code"],
    message: string,
    options: { version?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PostgresMigrationError";
    this.code = code;
    this.version = options.version;
    this.cause = options.cause;
  }
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function normalizeMigrations(migrations: readonly PostgresMigration[]): PostgresMigration[] {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const versions = new Set<number>();
  for (const migration of ordered) {
    if (
      !Number.isInteger(migration.version) ||
      migration.version < 1 ||
      versions.has(migration.version)
    ) {
      throw new PostgresMigrationError("INVALID_REGISTRY", "Invalid PostgreSQL migration registry");
    }
    versions.add(migration.version);
  }
  return ordered;
}

function validateAppliedRows(
  applied: readonly AppliedMigration[],
  migrations: readonly PostgresMigration[],
): void {
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) {
      throw new PostgresMigrationError(
        "INVALID_REGISTRY",
        `Applied PostgreSQL migration ${row.version} is missing from the registry`,
        { version: row.version },
      );
    }
    if (row.name !== migration.name || row.checksum !== checksum(migration.sql)) {
      throw new PostgresMigrationError(
        "CHECKSUM_MISMATCH",
        `Checksum mismatch for PostgreSQL migration ${row.version}`,
        { version: row.version },
      );
    }
  }
}

export interface PostgresMigrationOptions {
  /** Archivo externo ya creado por el operador, fuera de la réplica. */
  readonly documentsArchivePath?: string;
}

function configuredDocumentsArchivePath(options: PostgresMigrationOptions): string | undefined {
  const configured = options.documentsArchivePath ?? process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
  const trimmed = configured?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Verifica la fuente PostgreSQL antes de ejecutar el SQL de retiro. Esta puerta
 * solo lee PostgreSQL y el manifest externo; nunca escribe datos en ninguno de
 * los dos. El archivo lo produce el comando archive-documents.
 */
async function verifyPostgresDocuments(
  tx: Bun.SQL | Bun.TransactionSQL,
  archivePath: string | undefined,
  lockTable = false,
): Promise<void> {
  const table = (await tx<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'documents'
    ) AS exists
  `) as Array<{ exists: boolean }>;
  if (!table[0]?.exists) return;
  // The destructive migration must inspect a stable snapshot. Without this
  // lock, a writer could add a Document between the preflight query and DROP.
  if (lockTable) await tx.unsafe('LOCK TABLE "documents" IN ACCESS EXCLUSIVE MODE').simple();
  const rows = (await tx.unsafe<Array<Record<string, unknown>>>(
    "SELECT * FROM documents ORDER BY id",
  )) as Array<Record<string, unknown>>;
  if (!rows.length) return;
  if (!archivePath) {
    throw new Error(
      "Cannot retire PostgreSQL Documents with data: provide PRIME_BOARD_DOCUMENTS_ARCHIVE after running archive-documents",
    );
  }
  verifyDocumentRows(rows, archivePath, "postgres");
}

/**
 * Puerta previa al migrador. Consulta PostgreSQL y valida el manifest antes de
 * abrir la transacción que aplicará el SQL de retiro. La comprobación dentro de
 * la transacción se repite para cerrar la ventana de carrera.
 */
export async function preflightPostgresDocumentRetirement(
  sql: PostgresSql,
  archivePath?: string,
): Promise<void> {
  await verifyPostgresDocuments(sql, archivePath);
}

/**
 * Applies trusted, versioned PostgreSQL SQL while holding an advisory
 * transaction lock. Migration SQL is repository-owned and is intentionally
 * executed through `unsafe(...).simple()` because a baseline contains many
 * statements; callers must never pass user input as a migration.
 */
export async function migratePostgres(
  sql: PostgresSql,
  migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS,
  lockKey = "prime-board-schema",
  options: PostgresMigrationOptions = {},
): Promise<void> {
  const ordered = normalizeMigrations(migrations);
  if (
    ordered.some(
      (migration) => migration.version === 11 && migration.name === "documents_retirement",
    )
  ) {
    await preflightPostgresDocumentRetirement(sql, configuredDocumentsArchivePath(options));
  }
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const applied = (await tx<AppliedMigration[]>`
      SELECT version, name, checksum
      FROM schema_migrations
      ORDER BY version
    `) as AppliedMigration[];
    validateAppliedRows(applied, ordered);
    const appliedVersions = new Set(applied.map((row) => row.version));

    for (const migration of ordered) {
      if (appliedVersions.has(migration.version)) continue;
      try {
        if (migration.version === 11 && migration.name === "documents_retirement") {
          await verifyPostgresDocuments(tx, configuredDocumentsArchivePath(options), true);
        }
        await tx.unsafe(migration.sql).simple();
        await tx`
          INSERT INTO schema_migrations (version, name, checksum)
          VALUES (${migration.version}, ${migration.name}, ${checksum(migration.sql)})
        `;
      } catch (cause) {
        throw new PostgresMigrationError(
          "MIGRATION_FAILED",
          `PostgreSQL migration ${migration.version} failed`,
          { version: migration.version, cause },
        );
      }
    }
  });
}
