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

  it("registers the multi-Workspace schema migration without replacing history", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 12);
    expect(migration).toMatchObject({ name: "workspace_multitenancy" });
    expect(migration?.sql).toContain(
      "ALTER TABLE comments ADD COLUMN IF NOT EXISTS workspace_id TEXT",
    );
    expect(migration?.sql).toContain("comments_issue_workspace_fkey");
    expect(migration?.sql).toContain("FOREIGN KEY (workspace_id, issue_id)");
    expect(migration?.sql).toContain("DROP INDEX IF EXISTS workspace_singleton_idx");
    expect(POSTGRES_MIGRATIONS.filter((candidate) => candidate.version <= 11)).toHaveLength(11);
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
});

describe("PostgreSQL Workspace schema isolation", () => {
  const realMigrationTest = postgresUrl ? it : it.skip;

  realMigrationTest(
    "backfills the legacy singleton and rejects cross-Workspace foreign keys",
    async () => {
      const legacyMigrations = POSTGRES_MIGRATIONS.filter((candidate) => candidate.version <= 11);
      const harness = await createPostgresHarness({
        url: postgresUrl!,
        schemaPrefix: "workspace-schema",
        migrations: legacyMigrations,
      });
      try {
        await harness.sql`
        INSERT INTO workspace (id, name, url_key, created_at, updated_at)
        VALUES ('workspace-a', 'Workspace A', 'workspace-a', '2026-01-01', '2026-01-01')
      `;
        await harness.sql`
        INSERT INTO actors (id, name, type, created_at, updated_at)
        VALUES ('actor-a', 'Actor A', 'human', '2026-01-01', '2026-01-01')
      `;
        await harness.sql`
        INSERT INTO teams (id, name, key, created_at, updated_at)
        VALUES ('team-a', 'Team A', 'ENG', '2026-01-01', '2026-01-01')
      `;
        await harness.sql`
        INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at)
        VALUES ('state-a', 'team-a', 'Todo', 'unstarted', '#000000', 0, '2026-01-01', '2026-01-01')
      `;
        await harness.sql`
        INSERT INTO issues (id, team_id, number, title, state_id, creator_id, created_at, updated_at)
        VALUES ('issue-a', 'team-a', 1, 'Issue A', 'state-a', 'actor-a', '2026-01-01', '2026-01-01')
      `;

        await migratePostgres(harness.sql as unknown as Bun.SQL);

        const backfilled = await harness.sql`
        SELECT t.workspace_id AS team_workspace, i.workspace_id AS issue_workspace
        FROM teams t JOIN issues i ON i.team_id = t.id
        WHERE t.id = 'team-a' AND i.id = 'issue-a'
      `;
        expect(backfilled[0]).toEqual({
          team_workspace: "workspace-a",
          issue_workspace: "workspace-a",
        });

        const expectedScopedTables = [
          "actor_invitations",
          "activity",
          "comments",
          "cycles",
          "favorites",
          "inbox_receipts",
          "initiative_projects",
          "initiative_teams",
          "initiatives",
          "issue_labels",
          "issue_relations",
          "issues",
          "labels",
          "milestones",
          "project_teams",
          "project_updates",
          "projects",
          "reviews",
          "saved_views",
          "team_memberships",
          "teams",
          "webhooks",
          "workflow_states",
        ];
        const scopeColumns = await harness.sql`
          SELECT table_name
          FROM information_schema.columns
          WHERE table_schema = current_schema() AND column_name = 'workspace_id'
          ORDER BY table_name
        `;
        expect(scopeColumns.map((row: { table_name: string }) => row.table_name)).toEqual(
          [
            ...expectedScopedTables,
            "api_key_team_limits",
            "api_key_workspaces",
            "issue_subscribers",
            "workspace_memberships",
          ].sort(),
        );

        await harness.sql`
        INSERT INTO workspace (id, name, url_key, created_at, updated_at)
        VALUES ('workspace-b', 'Workspace B', 'workspace-b', '2026-01-01', '2026-01-01')
      `;
        await harness.sql`
        INSERT INTO teams (id, workspace_id, name, key, created_at, updated_at)
        VALUES ('team-b', 'workspace-b', 'Team B', 'ENG', '2026-01-01', '2026-01-01')
      `;
        await harness.sql`
        INSERT INTO workflow_states (id, workspace_id, team_id, name, type, color, position, created_at, updated_at)
        VALUES ('state-b', 'workspace-b', 'team-b', 'Todo', 'unstarted', '#000000', 0, '2026-01-01', '2026-01-01')
      `;
        await harness.sql`
        INSERT INTO issues (id, workspace_id, team_id, number, title, state_id, creator_id, created_at, updated_at)
        VALUES ('issue-b', 'workspace-b', 'team-b', 1, 'Issue B', 'state-b', 'actor-a', '2026-01-01', '2026-01-01')
      `;

        await harness.sql`
          INSERT INTO labels (id, workspace_id, name, color, team_id, created_at)
          VALUES ('label-a', 'workspace-a', 'Bug', '#ff0000', 'team-a', '2026-01-01')
        `;
        await harness.sql`
          INSERT INTO labels (id, workspace_id, name, color, team_id, created_at)
          VALUES ('label-b', 'workspace-b', 'Bug', '#0000ff', 'team-b', '2026-01-01')
        `;
        await harness.sql`
          INSERT INTO issue_labels (workspace_id, issue_id, label_id)
          VALUES ('workspace-a', 'issue-a', 'label-a')
        `;
        await harness.sql`
          INSERT INTO issue_labels (workspace_id, issue_id, label_id)
          VALUES ('workspace-b', 'issue-b', 'label-b')
        `;

        const sameKey = await harness.sql`
        SELECT count(*)::int AS count FROM teams WHERE key = 'ENG'
      `;
        expect(sameKey[0]?.count).toBe(2);
        const sameNumber = await harness.sql`
        SELECT count(*)::int AS count FROM issues WHERE number = 1
      `;
        expect(sameNumber[0]?.count).toBe(2);

        let crossWorkspaceRejected = false;
        try {
          await harness.sql`
          INSERT INTO comments (id, workspace_id, issue_id, actor_id, body, created_at)
          VALUES ('comment-cross', 'workspace-a', 'issue-b', 'actor-a', 'cross', '2026-01-01')
        `;
        } catch {
          crossWorkspaceRejected = true;
        }
        expect(crossWorkspaceRejected).toBe(true);

        let crossLabelRejected = false;
        try {
          await harness.sql`
            INSERT INTO issue_labels (workspace_id, issue_id, label_id)
            VALUES ('workspace-a', 'issue-a', 'label-b')
          `;
        } catch {
          crossLabelRejected = true;
        }
        expect(crossLabelRejected).toBe(true);

        const comments = await harness.sql`
        INSERT INTO comments (id, workspace_id, issue_id, actor_id, body, created_at)
        VALUES ('comment-a', 'workspace-a', 'issue-a', 'actor-a', 'local', '2026-01-01')
        RETURNING workspace_id, issue_id
      `;
        expect(comments[0]).toEqual({ workspace_id: "workspace-a", issue_id: "issue-a" });

        const foreignKeys = await harness.sql`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'comments'::regclass
          AND conname IN ('comments_workspace_fkey', 'comments_issue_workspace_fkey')
        ORDER BY conname
      `;
        expect(foreignKeys.map((row: { conname: string }) => row.conname)).toEqual([
          "comments_issue_workspace_fkey",
          "comments_workspace_fkey",
        ]);
        const indexes = await harness.sql`
          SELECT indexdef
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname IN ('idx_comments_issue', 'idx_issues_team_state')
          ORDER BY indexname
        `;
        expect(indexes.map((row: { indexdef: string }) => row.indexdef)).toEqual([
          expect.stringContaining("(workspace_id, issue_id)"),
          expect.stringContaining("(workspace_id, team_id, state_id)"),
        ]);

        const singleton = await harness.sql`
        SELECT count(*)::int AS count
        FROM pg_class index_class
        JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
        WHERE namespace.nspname = current_schema()
          AND index_class.relname = 'workspace_singleton_idx'
      `;
        expect(singleton[0]?.count).toBe(0);

        const migrationMarker = await harness.sql`
        SELECT count(*)::int AS count FROM schema_migrations WHERE version = 12
      `;
        expect(migrationMarker[0]?.count).toBe(1);
      } finally {
        await harness.close();
      }
    },
  );

  realMigrationTest(
    "aborts an ambiguous backfill without columns or migration marker",
    async () => {
      const legacyMigrations = POSTGRES_MIGRATIONS.filter((candidate) => candidate.version <= 11);
      const harness = await createPostgresHarness({
        url: postgresUrl!,
        schemaPrefix: "workspace-backfill",
        migrations: legacyMigrations,
      });
      try {
        await harness.sql`
        INSERT INTO workspace (id, name, url_key, created_at, updated_at)
        VALUES ('workspace-a', 'Workspace A', 'workspace-a', '2026-01-01', '2026-01-01')
      `;
        await harness.sql`DROP INDEX workspace_singleton_idx`;
        await harness.sql`
        INSERT INTO workspace (id, name, url_key, created_at, updated_at)
        VALUES ('workspace-b', 'Workspace B', 'workspace-b', '2026-01-01', '2026-01-01')
      `;
        await harness.sql`
        INSERT INTO teams (id, name, key, created_at, updated_at)
        VALUES ('team-a', 'Team A', 'ENG', '2026-01-01', '2026-01-01')
      `;

        let migrationRejected = false;
        try {
          await migratePostgres(harness.sql as unknown as Bun.SQL);
        } catch {
          migrationRejected = true;
        }
        expect(migrationRejected).toBe(true);

        const column = await harness.sql`
        SELECT count(*)::int AS count
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'teams'
          AND column_name = 'workspace_id'
      `;
        expect(column[0]?.count).toBe(0);
        const marker = await harness.sql`
        SELECT count(*)::int AS count FROM schema_migrations WHERE version = 12
      `;
        expect(marker[0]?.count).toBe(0);
        const team =
          await harness.sql`SELECT count(*)::int AS count FROM teams WHERE id = 'team-a'`;
        expect(team[0]?.count).toBe(1);
      } finally {
        await harness.close();
      }
    },
  );
});
