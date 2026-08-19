import { createHash } from "node:crypto";
import baseline from "./0001_baseline.sql" with { type: "text" };
import workspaceSingleton from "./0002_workspace_singleton.sql" with { type: "text" };
import actorNameUnique from "./0003_actor_name_unique.sql" with { type: "text" };

export interface PostgresMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
  { version: 1, name: "baseline", sql: baseline },
  { version: 2, name: "workspace_singleton", sql: workspaceSingleton },
  { version: 3, name: "actor_name_unique", sql: actorNameUnique },
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
): Promise<void> {
  const ordered = normalizeMigrations(migrations);
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
