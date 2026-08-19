/**
 * Valida lock, checksum y rollback del migrator PostgreSQL.
 * Uso: PRIME_BOARD_POSTGRES_URL='postgres://...' bun run scripts/validate-postgres-migrator.ts
 */
import {
  migratePostgres,
  type PostgresMigration,
} from "../apps/server/src/db/postgres/migrator.ts";

const url = process.env.PRIME_BOARD_POSTGRES_URL;
if (!url) {
  console.error("PRIME_BOARD_POSTGRES_URL is required");
  process.exit(2);
}

const options = { url, max: 1, connectionTimeout: 5 };
const first = new Bun.SQL(options);
const second = new Bun.SQL(options);
const lockKey = "prime-board-migrator-validation";
const version = 9001;
const table = "prime_board_migrator_validation";
const migration: PostgresMigration = {
  version,
  name: "validation",
  sql: `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`,
};
const report: Record<string, unknown> = {};

try {
  await first.unsafe(`DROP TABLE IF EXISTS ${table}`).simple();
  await first`DELETE FROM schema_migrations WHERE version >= ${version}`;

  await Promise.all([
    migratePostgres(first, [migration], lockKey),
    migratePostgres(second, [migration], lockKey),
  ]);
  const applied =
    await first`SELECT count(*)::int AS count FROM schema_migrations WHERE version = ${version}`;
  const tables = await first`
    SELECT count(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  report.concurrent = applied[0]?.count === 1 && tables[0]?.count === 1;

  try {
    await migratePostgres(
      first,
      [{ version, name: "validation-edited", sql: `${migration.sql} ` }],
      lockKey,
    );
    report.checksum = false;
  } catch (error) {
    report.checksum = error instanceof Error && error.name === "PostgresMigrationError";
  }

  const failedVersion = version + 1;
  try {
    await migratePostgres(
      first,
      [
        {
          version: failedVersion,
          name: "failed",
          sql: `CREATE TABLE prime_board_migrator_failed (id INTEGER); SELECT * FROM missing_migration_table`,
        },
      ],
      lockKey,
    );
    report.rollback = false;
  } catch (error) {
    const row =
      await first`SELECT count(*)::int AS count FROM schema_migrations WHERE version = ${failedVersion}`;
    const failedTable = await first`
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'prime_board_migrator_failed'
    `;
    report.rollback =
      error instanceof Error &&
      error.name === "PostgresMigrationError" &&
      row[0]?.count === 0 &&
      failedTable[0]?.count === 0;
  }

  const passed = report.concurrent === true && report.checksum === true && report.rollback === true;
  console.log(JSON.stringify({ passed, report }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    await first.unsafe(`DROP TABLE IF EXISTS ${table}`).simple();
    await first`DELETE FROM schema_migrations WHERE version >= ${version}`;
  } finally {
    await Promise.all([first.close({ timeout: 5 }), second.close({ timeout: 5 })]);
  }
}
