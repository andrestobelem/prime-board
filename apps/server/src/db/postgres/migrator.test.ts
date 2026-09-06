import { describe, expect, it } from "bun:test";
import { createPostgresHarness } from "./test-harness.ts";
import { POSTGRES_MIGRATIONS, migratePostgres } from "./migrator.ts";

const postgresUrl = process.env.PRIME_BOARD_POSTGRES_URL;

describe("PostgreSQL projector checkpoint migration", () => {
  it("mantiene versiones únicas y ordenadas al registrar Views", () => {
    const versions = POSTGRES_MIGRATIONS.map((migration) => migration.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort((left, right) => left - right));
    expect(POSTGRES_MIGRATIONS.find((migration) => migration.version === 13)).toMatchObject({
      name: "views_preferences",
    });
  });

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
        WHERE version = 10
      `;
      expect(migrations[0]?.count).toBe(1);
    } finally {
      await harness.close();
    }
  });
  realMigrationTest(
    "applies Views migration and reruns it idempotently on PostgreSQL",
    async () => {
      const harness = await createPostgresHarness({
        url: postgresUrl!,
        schemaPrefix: "views-preferences",
      });
      try {
        const columnsBeforeRepeat = await harness.sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'saved_views'
          AND column_name IN ('workspace_id', 'project_id', 'initiative_id')
        ORDER BY column_name
      `;
        expect(columnsBeforeRepeat.map((row: { column_name: string }) => row.column_name)).toEqual([
          "initiative_id",
          "project_id",
          "workspace_id",
        ]);
        const tables = await harness.sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('view_preferences', 'view_subscriptions')
        ORDER BY table_name
      `;
        expect(tables.map((row: { table_name: string }) => row.table_name)).toEqual([
          "view_preferences",
          "view_subscriptions",
        ]);

        await migratePostgres(harness.sql as unknown as Bun.SQL);

        const migrations = await harness.sql`
        SELECT count(*)::int AS count
        FROM schema_migrations
        WHERE version = 13 AND name = 'views_preferences'
      `;
        expect(migrations[0]?.count).toBe(1);
      } finally {
        await harness.close();
      }
    },
  );
});
