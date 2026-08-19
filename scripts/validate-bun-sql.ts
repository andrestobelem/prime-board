/**
 * Spike reproducible para validar Bun.SQL contra PostgreSQL.
 *
 * Uso local (no guarda ni imprime la URL):
 * PRIME_BOARD_POSTGRES_URL='postgres://...' bun run scripts/validate-bun-sql.ts
 */

const url = process.env.PRIME_BOARD_POSTGRES_URL;
if (!url) {
  console.error("PRIME_BOARD_POSTGRES_URL is required");
  process.exit(2);
}

const sql = new Bun.SQL({
  url,
  max: 2,
  idleTimeout: 5,
  maxLifetime: 60,
  connectionTimeout: 5,
});
const table = "prime_board_bun_sql_validation";
const report: Record<string, unknown> = {};

try {
  await sql`DROP TABLE IF EXISTS ${sql(table)}`;
  await sql`CREATE TABLE ${sql(table)} (
    id SERIAL PRIMARY KEY,
    payload JSONB NOT NULL,
    value INTEGER NOT NULL
  )`;

  const inserted = await sql`
    INSERT INTO ${sql(table)} (payload, value)
    VALUES (${{ source: "bun-sql", nested: { valid: true } }}, ${7})
    RETURNING id, payload, value
  `;
  const insertedRow = inserted[0] as { payload: { nested: { valid: boolean } }; value: number };
  report.returning =
    inserted.length === 1 && insertedRow.value === 7 && insertedRow.payload.nested.valid;

  const selected = await sql`SELECT payload, value FROM ${sql(table)} WHERE value = ${7}`;
  report.json = selected[0]?.payload?.nested?.valid === true;

  const updated = await sql`UPDATE ${sql(table)} SET value = ${8} WHERE value = ${7}`;
  const updateResult = updated as unknown as { count: number };
  report.rowCount = updateResult.count === 1;
  report.resultMetadata = Object.keys(updated).sort();

  await sql
    .begin(async (tx) => {
      await tx`INSERT INTO ${sql(table)} (payload, value) VALUES (${{ rollback: true }}, ${9})`;
      throw new Error("rollback-check");
    })
    .catch((error) => {
      report.rollbackError = error instanceof Error && error.message === "rollback-check";
    });
  const rolledBack = await sql`SELECT count(*)::int AS count FROM ${sql(table)} WHERE value = ${9}`;
  report.rollback = rolledBack[0]?.count === 0;

  try {
    await sql`SELECT * FROM table_that_does_not_exist`;
    report.errors = false;
  } catch (error) {
    report.errors = error?.constructor?.name === "PostgresError";
    report.errorCode = (error as { code?: string }).code;
  }

  const [transactionPid, outsidePid] = await sql.begin(async (tx) => {
    const transactionRow = (await tx`SELECT pg_backend_pid() AS pid`)[0] as { pid: number };
    const outsideQuery = sql`SELECT pg_backend_pid() AS pid, pg_sleep(0.05) AS waited`;
    await tx`SELECT pg_sleep(0.1)`;
    const outsideRow = (await outsideQuery)[0] as { pid: number };
    return [transactionRow.pid, outsideRow.pid];
  });
  report.dedicatedTransactionConnection = transactionPid !== outsidePid;

  const expected = [
    "dedicatedTransactionConnection",
    "errors",
    "json",
    "returning",
    "rollback",
    "rollbackError",
    "rowCount",
  ];
  const passed = expected.every((key) => report[key] === true);
  console.log(JSON.stringify({ passed, report }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    await sql`DROP TABLE IF EXISTS ${sql(table)}`;
  } catch {
    // La conexión puede no haber llegado a abrirse; no ocultar el diagnóstico original.
  } finally {
    await sql.close({ timeout: 5 });
  }
}
