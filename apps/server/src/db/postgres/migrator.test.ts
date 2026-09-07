import { describe, expect, it } from "bun:test";
import { createPostgresHarness } from "./test-harness.ts";
import { POSTGRES_MIGRATIONS, migratePostgres } from "./migrator.ts";

const postgresUrl = process.env.PRIME_BOARD_POSTGRES_URL;

describe("PostgreSQL projector checkpoint migration", () => {
  it("keeps historical Documents migration and appends retirement migration", () => {
    expect(POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 5)).toMatchObject({
      name: "documents",
    });
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 11);
    expect(migration).toMatchObject({ name: "documents_retirement" });
    expect(migration?.sql).toContain("DROP TABLE documents");
  });

  it("registers migration 0010 with the checkpoint schema", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 10);
    expect(migration).toMatchObject({ name: "projector_checkpoints" });
    expect(migration?.sql).toContain("stream TEXT PRIMARY KEY");
    expect(migration?.sql).toContain("event_id TEXT NOT NULL");
    expect(migration?.sql).toContain("occurred_at TEXT NOT NULL");
    expect(migration?.sql).toContain("processed BOOLEAN NOT NULL");
    expect(migration?.sql).toContain("updated_at TIMESTAMPTZ NOT NULL");
  });

  it("registers migration 0016 with per-event projector receipts", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 16);
    expect(migration).toMatchObject({ name: "projector_events" });
    expect(migration?.sql).toContain("stream TEXT NOT NULL");
    expect(migration?.sql).toContain("event_id TEXT NOT NULL");
    expect(migration?.sql).toContain("processed_at TIMESTAMPTZ NOT NULL");
  });

  const realMigrationTest = postgresUrl ? it : it.skip;
  realMigrationTest("applies migration and reruns it idempotently on PostgreSQL", async () => {
    const harness = await createPostgresHarness({
      url: postgresUrl!,
      schemaPrefix: "projector-checkpoints",
    });
    try {
      await migratePostgres(harness.sql as unknown as Bun.SQL);
      const table = await harness.sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'projector_checkpoints'
        ORDER BY ordinal_position
      `;
      expect(table.map((row: { column_name: string }) => row.column_name)).toEqual([
        "stream",
        "event_id",
        "occurred_at",
        "processed",
        "updated_at",
      ]);
      const migrations = await harness.sql`
        SELECT count(*)::int AS count
        FROM schema_migrations
        WHERE version IN (10, 16)
      `;
      expect(migrations[0]?.count).toBe(2);
    } finally {
      await harness.close();
    }
  });
});
