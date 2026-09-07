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
import workflowStateDescriptionReserved from "./0014_workflow_state_description_reserved.sql" with { type: "text" };
import teamWorkflowAutomation from "./0015_team_workflow_automation.sql" with { type: "text" };
import { newId, now } from "../util.ts";

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
  {
    version: 14,
    name: "workflow_state_description_reserved",
    sql: workflowStateDescriptionReserved,
  },
  { version: 15, name: "team_workflow_automation", sql: teamWorkflowAutomation },
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

async function seedPostgresReservedDuplicateStates(sql: PostgresSql): Promise<void> {
  const teams = await sql<{ id: string; default_state_id: string | null }[]>`
    SELECT id, default_state_id FROM teams
  `;
  for (const team of teams) {
    const duplicateRows = await sql<{ id: string }[]>`
      SELECT id FROM workflow_states
      WHERE team_id = ${team.id} AND lower(name) = lower('Duplicate')
      LIMIT 1
    `;
    const maxRows = await sql<{ max: number }[]>`
      SELECT coalesce(max(position), -1) AS max
      FROM workflow_states WHERE team_id = ${team.id}
    `;
    const duplicateId = duplicateRows[0]?.id ?? newId();
    const timestamp = now();
    if (duplicateRows[0]) {
      await sql`
        UPDATE workflow_states
        SET name = 'Duplicate', type = 'canceled', color = '#95a2b3',
            description = 'System-managed status for duplicate issues.',
            is_reserved = TRUE, position = ${(maxRows[0]?.max ?? -1) + 1}, updated_at = ${timestamp}
        WHERE id = ${duplicateId}
      `;
    } else {
      await sql`
        INSERT INTO workflow_states
          (id, team_id, name, type, color, position, created_at, updated_at, description, is_reserved)
        VALUES
          (${duplicateId}, ${team.id}, 'Duplicate', 'canceled', '#95a2b3',
           ${(maxRows[0]?.max ?? -1) + 1}, ${timestamp}, ${timestamp},
           'System-managed status for duplicate issues.', TRUE)
      `;
    }
    if (team.default_state_id === duplicateId) {
      const fallbackRows = await sql<{ id: string }[]>`
        SELECT id FROM workflow_states
        WHERE team_id = ${team.id} AND is_reserved = FALSE
        ORDER BY position, id LIMIT 1
      `;
      if (fallbackRows[0]) {
        await sql`UPDATE teams SET default_state_id = ${fallbackRows[0].id} WHERE id = ${team.id}`;
      }
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
        if (migration.version === 14) await seedPostgresReservedDuplicateStates(tx);
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
