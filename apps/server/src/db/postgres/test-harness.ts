import { randomUUID } from "node:crypto";
import { migratePostgres } from "./migrator.ts";

export interface PostgresHarnessOptions {
  readonly url: string;
  readonly schemaPrefix?: string;
  readonly lockKey?: string;
}

export interface PostgresHarness {
  readonly schema: string;
  readonly sql: Bun.ReservedSQL;
  close(): Promise<void>;
}

function identifierPart(value: string): string {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9_]/g, "_");
  return normalized.replace(/^[^a-z_]+/, "") || "test";
}

function schemaName(prefix: string | undefined): string {
  const safePrefix = identifierPart(prefix ?? "prime_board_test");
  return `${safePrefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/**
 * Reserves one PostgreSQL connection, creates an isolated schema and applies
 * the PostgreSQL migrator with that schema as search_path. Parallel harnesses
 * therefore never share tables or data.
 */
export async function createPostgresHarness(
  options: PostgresHarnessOptions,
): Promise<PostgresHarness> {
  const pool = new Bun.SQL({ url: options.url, max: 4, connectionTimeout: 5 });
  const schema = schemaName(options.schemaPrefix);
  let connection: Bun.ReservedSQL | undefined;
  try {
    connection = await pool.reserve();
    await connection`CREATE SCHEMA ${connection(schema)}`;
    await connection`SET search_path TO ${connection(schema)}, public`;
    await migratePostgres(connection, undefined, options.lockKey ?? "prime-board-test-schema");
    return {
      schema,
      sql: connection,
      async close() {
        connection?.release();
        connection = undefined;
        try {
          await pool.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).simple();
        } finally {
          await pool.close({ timeout: 5 });
        }
      },
    };
  } catch (error) {
    connection?.release();
    await pool
      .unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      .simple()
      .catch(() => undefined);
    await pool.close({ timeout: 5 });
    throw error;
  }
}
