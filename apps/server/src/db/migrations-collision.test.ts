import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { migrate, openDatabase } from "./database.ts";
import { bootstrap } from "./seed.ts";

function databaseWithMigrationsThrough(versionLimit: number): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );

  const migrationDirectory = join(import.meta.dir, "migrations");
  for (const filename of readdirSync(migrationDirectory).sort()) {
    const version = Number(filename.slice(0, 4));
    if (!Number.isInteger(version) || version > versionLimit) continue;
    if (version === 25) db.exec("PRAGMA foreign_keys = OFF");
    db.exec(readFileSync(join(migrationDirectory, filename), "utf8"));
    if (version === 25) db.exec("PRAGMA foreign_keys = ON");
    const name = version === 32 ? "notification_preferences" : filename.slice(5, -4);
    db.query("INSERT INTO _migrations (version, name, applied_at) VALUES (?1, ?2, ?3)").run(
      version,
      name,
      "2026-01-01T00:00:00.000Z",
    );
  }
  return db;
}

function restoreLegacySavedViews(db: Database): void {
  db.exec(`
    CREATE TABLE saved_views (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'team', 'workspace')),
      team_id TEXT,
      owner_id TEXT NOT NULL REFERENCES actors(id),
      filter_json TEXT NOT NULL DEFAULT '{}',
      order_by TEXT NOT NULL DEFAULT 'CREATED_DESC',
      group_by TEXT NOT NULL DEFAULT 'state',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      columns_json TEXT NOT NULL DEFAULT '[]',
      workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
      CHECK ((scope = 'team' AND team_id IS NOT NULL) OR (scope != 'team' AND team_id IS NULL)),
      FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id)
    );
    CREATE UNIQUE INDEX idx_saved_views_workspace_id ON saved_views(workspace_id, id);
    CREATE INDEX idx_saved_views_scope ON saved_views(scope, team_id);
    CREATE INDEX idx_saved_views_owner ON saved_views(owner_id);
  `);
}

function seedLegacyNotificationAndViewData(db: Database): void {
  bootstrap(db);
  const workspace = db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
  const actor = db.query("SELECT id FROM actors LIMIT 1").get() as { id: string };
  const team = db.query("SELECT id FROM teams LIMIT 1").get() as { id: string };
  const timestamp = "2026-01-01T00:00:00.000Z";

  db.query(
    `INSERT INTO saved_views
      (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
       created_at, updated_at, archived_at, columns_json, workspace_id)
     VALUES ('view-legacy', 'Legacy View', 'team', ?1, ?2, '{}', 'CREATED_DESC', 'state',
       ?3, ?3, NULL, '[]', ?4)`,
  ).run(team.id, actor.id, timestamp, workspace.id);
  db.query(
    `INSERT INTO favorites
      (id, actor_id, project_id, saved_view_id, position, created_at, workspace_id)
     VALUES ('favorite-legacy', ?1, NULL, 'view-legacy', 0, ?2, ?3)`,
  ).run(actor.id, timestamp, workspace.id);
  db.query(
    `INSERT INTO notification_preferences
      (workspace_id, actor_id, category, channel, enabled, email_delivery, created_at, updated_at)
     VALUES (?1, ?2, 'mentions', 'email', 1, 'immediate', ?3, ?3)`,
  ).run(workspace.id, actor.id, timestamp);
}

function seedLegacyViewsMigrationMarker(db: Database): void {
  bootstrap(db);
  db.exec(`
    INSERT INTO saved_views
      (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
       created_at, updated_at, archived_at, columns_json, workspace_id)
    SELECT 'view-legacy', 'Legacy View', 'team', teams.id, actors.id, '{}', 'CREATED_DESC', 'state',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, '[]', workspace.id
      FROM workspace
      JOIN actors ON actors.name = 'admin'
      JOIN teams ON teams.workspace_id = workspace.id
     LIMIT 1;
    INSERT INTO favorites
      (id, actor_id, project_id, saved_view_id, position, created_at, workspace_id)
    SELECT 'favorite-legacy', actors.id, NULL, 'view-legacy', 0,
           '2026-01-01T00:00:00.000Z', workspace.id
      FROM workspace
      JOIN actors ON actors.name = 'admin'
     LIMIT 1;
  `);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(readFileSync(join(import.meta.dir, "migrations", "0033_views_preferences.sql"), "utf8"));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    INSERT INTO view_preferences
      (id, workspace_id, view_id, actor_id, view_type, scope, layout, order_by, group_by,
       columns_json, created_at, updated_at)
    SELECT 'view-preference-legacy', workspace.id, 'view-legacy', actors.id, 'issue', 'actor',
           'list', 'UPDATED_DESC', 'state', '[]', '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z'
      FROM workspace
      JOIN actors ON actors.name = 'admin'
     LIMIT 1;
    INSERT INTO view_subscriptions
      (id, workspace_id, view_id, actor_id, issue_changes, slack, created_at, updated_at)
    SELECT 'view-subscription-legacy', workspace.id, 'view-legacy', actors.id, 1, 0,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      FROM workspace
      JOIN actors ON actors.name = 'admin'
     LIMIT 1;
  `);
  db.query(
    "INSERT INTO _migrations (version, name, applied_at) VALUES (32, 'views_preferences', ?1)",
  ).run("2026-01-01T00:00:00.000Z");
}

function seedPreWorkspaceConstraintSavedViewBase(db: Database): void {
  db.exec(`
    INSERT INTO workspace (id, name, url_key, created_at, updated_at)
    VALUES ('workspace-0025', 'Workspace 0025', 'workspace-0025',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO actors
      (id, name, email, type, avatar_url, created_at, updated_at, workspace_role, status,
       suspended_at, suspended_by, left_at)
    VALUES ('actor-0025', 'admin', 'admin@example.test', 'human', NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'admin', 'active',
            NULL, NULL, NULL);
    INSERT INTO teams
      (id, name, key, description, next_issue_number, created_at, updated_at, default_state_id,
       archived_at, visibility, access_policy, workspace_id)
    VALUES ('team-0025', 'Team 0025', 'T25', NULL, 1,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL,
            'public', 'team_members', 'workspace-0025');
    INSERT INTO workflow_states
      (id, team_id, name, type, color, position, created_at, updated_at)
    VALUES ('state-0025', 'team-0025', 'Backlog', 'backlog', '#6B7280', 0,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    UPDATE teams SET default_state_id = 'state-0025' WHERE id = 'team-0025';
    INSERT INTO saved_views
      (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
       created_at, updated_at, archived_at, columns_json, workspace_id)
    VALUES ('view-0025', 'View 0025', 'team', 'team-0025', 'actor-0025', '{}', 'CREATED_DESC',
            'state', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, '[]',
            'workspace-0025');
  `);
}

function seedPreWorkspaceConstraintSavedViews(db: Database): void {
  seedPreWorkspaceConstraintSavedViewBase(db);
  db.exec(`
    CREATE INDEX saved_views_custom_name_main ON saved_views(name);
    CREATE UNIQUE INDEX saved_views_custom_owner_name_unique ON saved_views(owner_id, name);
    CREATE INDEX saved_views_custom_active_name_partial
      ON saved_views(name)
      WHERE archived_at IS NULL;
    CREATE VIEW saved_views_custom_by_name AS
      SELECT id, name FROM saved_views INDEXED BY saved_views_custom_name_main;
    CREATE TABLE saved_views_trigger_audit (saved_view_id TEXT PRIMARY KEY);
    CREATE TRIGGER saved_views_custom_index_trigger
    AFTER INSERT ON favorites
    WHEN NEW.saved_view_id IS NOT NULL
    BEGIN
      INSERT OR REPLACE INTO saved_views_trigger_audit(saved_view_id)
      SELECT id FROM saved_views INDEXED BY saved_views_custom_name_main
       WHERE id = NEW.saved_view_id;
    END;
  `);
}

describe("colisión de migraciones SQLite", () => {
  it("preserva índices MAIN, UNIQUE y partial de Views al migrar 0025→0032→0033", () => {
    const db = databaseWithMigrationsThrough(24);
    try {
      seedPreWorkspaceConstraintSavedViews(db);
      const beforeView = db
        .query(
          `SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
                  created_at, updated_at, archived_at, columns_json, workspace_id
             FROM saved_views
            WHERE id = 'view-0025'`,
        )
        .get();
      expect(beforeView).not.toBeNull();
      expect(db.query("SELECT id, name FROM saved_views_custom_by_name").all()).toEqual([
        { id: "view-0025", name: "View 0025" },
      ]);

      migrate(db);

      expect(
        db
          .query(
            `SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
                    created_at, updated_at, archived_at, columns_json, workspace_id
               FROM saved_views
              WHERE id = 'view-0025'`,
          )
          .get(),
      ).toEqual(beforeView);
      for (const index of [
        "saved_views_custom_name_main",
        "saved_views_custom_owner_name_unique",
        "saved_views_custom_active_name_partial",
        "idx_saved_views_workspace_id",
      ]) {
        expect(
          db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1").get(index),
        ).toEqual({ name: index });
      }
      expect(
        db
          .query(
            `SELECT "unique" AS unique_value
               FROM pragma_index_list('saved_views')
              WHERE name = 'saved_views_custom_owner_name_unique'`,
          )
          .get(),
      ).toEqual({ unique_value: 1 });
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE name = 'saved_views_custom_active_name_partial'",
          )
          .get(),
      ).toEqual({
        sql: expect.stringMatching(/WHERE\s+archived_at\s+IS\s+NULL/i),
      });
      expect(db.query("SELECT id, name FROM saved_views_custom_by_name").all()).toEqual([
        { id: "view-0025", name: "View 0025" },
      ]);
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'saved_views_custom_index_trigger'",
          )
          .get(),
      ).toEqual({ name: "saved_views_custom_index_trigger" });
      db.query(
        `INSERT INTO favorites
           (id, actor_id, project_id, saved_view_id, position, created_at, workspace_id)
         VALUES ('favorite-0025', 'actor-0025', NULL, 'view-0025', 0,
                 '2026-01-02T00:00:00.000Z', 'workspace-0025')`,
      ).run();
      expect(db.query("SELECT * FROM saved_views_trigger_audit").all()).toEqual([
        { saved_view_id: "view-0025" },
      ]);
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const markers = db.query("SELECT version, name FROM _migrations ORDER BY version").all();
      migrate(db);
      expect(db.query("SELECT version, name FROM _migrations ORDER BY version").all()).toEqual(
        markers,
      );
      expect(db.query("SELECT id, name FROM saved_views_custom_by_name").all()).toEqual([
        { id: "view-0025", name: "View 0025" },
      ]);
    } finally {
      db.close();
    }
  });

  it("falla sin escribir si índice, VIEW y trigger INDEXED BY no son preservables", () => {
    const db = databaseWithMigrationsThrough(24);
    try {
      seedPreWorkspaceConstraintSavedViewBase(db);
      db.exec(`
        ALTER TABLE saved_views ADD COLUMN legacy_marker TEXT;
        UPDATE saved_views SET legacy_marker = 'legacy';
        CREATE INDEX saved_views_legacy_marker ON saved_views(legacy_marker);
        CREATE VIEW saved_views_legacy_marker_view AS
          SELECT id FROM saved_views INDEXED BY saved_views_legacy_marker;
        CREATE TABLE saved_views_trigger_audit (saved_view_id TEXT PRIMARY KEY);
        CREATE TRIGGER saved_views_legacy_marker_trigger
        AFTER INSERT ON favorites
        WHEN NEW.saved_view_id IS NOT NULL
        BEGIN
          INSERT OR REPLACE INTO saved_views_trigger_audit(saved_view_id)
          SELECT id FROM saved_views INDEXED BY saved_views_legacy_marker
           WHERE id = NEW.saved_view_id;
        END;
      `);
      const beforeView = db.query("SELECT * FROM saved_views").all();
      const beforeMarkers = db
        .query("SELECT version, name FROM _migrations ORDER BY version")
        .all();

      expect(() => migrate(db)).toThrow(/legacy_marker|preserv|index|VIEW/i);
      expect(db.query("SELECT * FROM saved_views").all()).toEqual(beforeView);
      expect(db.query("SELECT version, name FROM _migrations ORDER BY version").all()).toEqual(
        beforeMarkers,
      );
      expect(db.query("SELECT version FROM _migrations WHERE version = 25").get()).toBeNull();
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'saved_views_legacy_marker'",
          )
          .get(),
      ).toEqual({ name: "saved_views_legacy_marker" });
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'saved_views_legacy_marker_view'",
          )
          .get(),
      ).toEqual({ name: "saved_views_legacy_marker_view" });
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'saved_views_legacy_marker_trigger'",
          )
          .get(),
      ).toEqual({ name: "saved_views_legacy_marker_trigger" });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => migrate(db)).toThrow(/legacy_marker|preserv|index|VIEW/i);

      db.exec(`
        DROP VIEW saved_views_legacy_marker_view;
        DROP TRIGGER saved_views_legacy_marker_trigger;
        DROP INDEX saved_views_legacy_marker;
      `);
      migrate(db);
      expect(
        db.query("SELECT version, name FROM _migrations WHERE version >= 25").all(),
      ).toContainEqual({ version: 25, name: "workspace_constraints" });
      expect(
        db
          .query("SELECT 1 FROM pragma_table_info('saved_views') WHERE name = 'legacy_marker'")
          .get(),
      ).toBeNull();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("aplica Notifications y Views con versiones, tablas e índices únicos", () => {
    const db = openDatabase(":memory:");
    try {
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual({ count: 32 });
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      const versions = (
        db.query("SELECT version FROM _migrations ORDER BY version").values() as Array<[number]>
      ).map(([version]) => version);
      expect(new Set(versions).size).toBe(versions.length);
      expect(versions).toEqual([...versions].sort((left, right) => left - right));

      for (const table of ["notification_preferences", "view_preferences", "view_subscriptions"]) {
        expect(
          db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table),
        ).toEqual({ name: table });
      }
      for (const index of [
        "idx_saved_views_workspace_id",
        "idx_notification_preferences_actor_workspace",
        "idx_view_preferences_key",
        "idx_view_preferences_view",
        "idx_view_preferences_actor",
        "idx_view_subscriptions_view",
        "idx_view_subscriptions_actor",
      ]) {
        expect(
          db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1").get(index),
        ).toEqual({ name: index });
      }
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("actualiza una base con Notifications 0032 sin perder Views, favoritos ni preferencias", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      const beforeView = db
        .query(
          `SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
                  created_at, updated_at, archived_at, columns_json, workspace_id
           FROM saved_views WHERE id = 'view-legacy'`,
        )
        .get();
      const beforeFavorite = db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get();
      const beforeNotification = db
        .query("SELECT * FROM notification_preferences WHERE category = 'mentions'")
        .get();
      db.exec("CREATE UNIQUE INDEX idx_saved_views_name ON saved_views(name)");

      migrate(db);

      expect(db.query("SELECT name FROM _migrations WHERE version = 32").get()).toEqual({
        name: "notification_preferences",
      });
      expect(db.query("SELECT name FROM _migrations WHERE version = 33").get()).toEqual({
        name: "views_preferences",
      });
      expect(
        db
          .query(
            `SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
                    created_at, updated_at, archived_at, columns_json, workspace_id
             FROM saved_views WHERE id = 'view-legacy'`,
          )
          .get(),
      ).toEqual(beforeView);
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM notification_preferences WHERE category = 'mentions'").get(),
      ).toEqual(beforeNotification);
      expect(
        db
          .query("SELECT project_id, initiative_id FROM saved_views WHERE id = 'view-legacy'")
          .get(),
      ).toEqual({ project_id: null, initiative_id: null });
      for (const index of ["idx_saved_views_workspace_id", "idx_saved_views_name"]) {
        expect(
          db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1").get(index),
        ).toEqual({ name: index });
      }
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const migrationCount = db.query("SELECT count(*) AS count FROM _migrations").get();
      migrate(db);
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(migrationCount);
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
    } finally {
      db.close();
    }
  });

  it("revierte el rebuild cuando un índice legacy no puede restaurarse", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec("ALTER TABLE saved_views ADD COLUMN legacy_marker TEXT");
      db.exec("CREATE INDEX idx_saved_views_legacy_marker ON saved_views(legacy_marker)");
      const beforeView = db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get();
      const beforeFavorite = db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get();
      const beforeNotification = db
        .query("SELECT * FROM notification_preferences WHERE category = 'mentions'")
        .get();

      expect(() => migrate(db)).toThrow(/legacy_marker/);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();
      expect(db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get()).toEqual(
        beforeView,
      );
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM notification_preferences WHERE category = 'mentions'").get(),
      ).toEqual(beforeNotification);
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1")
          .get("idx_saved_views_legacy_marker"),
      ).toEqual({ name: "idx_saved_views_legacy_marker" });
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      db.exec("DROP INDEX idx_saved_views_legacy_marker");
      migrate(db);
      expect(db.query("SELECT version, name FROM _migrations WHERE version >= 32").all()).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
    } finally {
      db.close();
    }
  });

  it("revierte el rebuild de Views si falla y permite reintentar sin pérdida", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      const beforeView = db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get();
      const beforeFavorite = db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get();
      const beforeNotification = db
        .query("SELECT * FROM notification_preferences WHERE category = 'mentions'")
        .get();
      db.exec("CREATE INDEX idx_saved_views_project ON actors(name)");

      expect(() => migrate(db)).toThrow(/idx_saved_views_project/);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();
      for (const table of ["_prb390_saved_views", "view_preferences", "view_subscriptions"]) {
        expect(
          db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table),
        ).toBeNull();
      }
      expect(db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get()).toEqual(
        beforeView,
      );
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM notification_preferences WHERE category = 'mentions'").get(),
      ).toEqual(beforeNotification);
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      db.exec("DROP INDEX idx_saved_views_project");
      migrate(db);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM notification_preferences WHERE category = 'mentions'").get(),
      ).toEqual(beforeNotification);
    } finally {
      db.close();
    }
  });

  it("reconcilia Views legacy marcadas como 0032, aplica Notifications y conserva metadata", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      const beforeView = db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get();
      const beforeFavorite = db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get();
      const beforeViewPreference = db
        .query("SELECT * FROM view_preferences WHERE id = 'view-preference-legacy'")
        .get();
      const beforeViewSubscription = db
        .query("SELECT * FROM view_subscriptions WHERE id = 'view-subscription-legacy'")
        .get();
      expect(beforeView).not.toBeNull();
      expect(beforeFavorite).not.toBeNull();
      expect(beforeViewPreference).not.toBeNull();
      expect(beforeViewSubscription).not.toBeNull();

      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_preferences'",
          )
          .get(),
      ).toBeNull();
      migrate(db);

      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      expect(db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get()).toEqual(
        beforeView,
      );
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM view_preferences WHERE id = 'view-preference-legacy'").get(),
      ).toEqual(beforeViewPreference);
      expect(
        db.query("SELECT * FROM view_subscriptions WHERE id = 'view-subscription-legacy'").get(),
      ).toEqual(beforeViewSubscription);
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_preferences'",
          )
          .get(),
      ).not.toBeNull();
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'view_preferences'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'view_subscriptions'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_saved_views_workspace_id'",
          )
          .get(),
      ).toEqual({ name: "idx_saved_views_workspace_id" });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const markers = db.query("SELECT version, name FROM _migrations ORDER BY version").all();
      migrate(db);
      expect(db.query("SELECT version, name FROM _migrations ORDER BY version").all()).toEqual(
        markers,
      );
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM view_preferences WHERE id = 'view-preference-legacy'").get(),
      ).toEqual(beforeViewPreference);
      expect(
        db.query("SELECT * FROM view_subscriptions WHERE id = 'view-subscription-legacy'").get(),
      ).toEqual(beforeViewSubscription);
    } finally {
      db.close();
    }
  });

  it("revierte la reconciliación legacy si Notifications falla y permite reintentar", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      db.exec("CREATE INDEX idx_notification_preferences_actor_workspace ON actors(name)");
      const beforeView = db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get();
      const beforeFavorite = db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get();
      const beforeViewPreference = db
        .query("SELECT * FROM view_preferences WHERE id = 'view-preference-legacy'")
        .get();
      const beforeViewSubscription = db
        .query("SELECT * FROM view_subscriptions WHERE id = 'view-subscription-legacy'")
        .get();
      expect(beforeView).not.toBeNull();
      expect(beforeFavorite).not.toBeNull();
      expect(beforeViewPreference).not.toBeNull();
      expect(beforeViewSubscription).not.toBeNull();
      const beforeMarkers = db
        .query("SELECT version, name FROM _migrations ORDER BY version")
        .all();

      expect(() => migrate(db)).toThrow(/idx_notification_preferences_actor_workspace/);
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_preferences'",
          )
          .get(),
      ).toBeNull();
      expect(db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get()).toEqual(
        beforeView,
      );
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM view_preferences WHERE id = 'view-preference-legacy'").get(),
      ).toEqual(beforeViewPreference);
      expect(
        db.query("SELECT * FROM view_subscriptions WHERE id = 'view-subscription-legacy'").get(),
      ).toEqual(beforeViewSubscription);
      expect(db.query("SELECT version, name FROM _migrations ORDER BY version").all()).toEqual(
        beforeMarkers,
      );
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      db.exec("DROP INDEX idx_notification_preferences_actor_workspace");
      migrate(db);
      expect(db.query("SELECT name FROM _migrations WHERE version = 33").get()).toEqual({
        name: "views_preferences",
      });
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM view_preferences WHERE id = 'view-preference-legacy'").get(),
      ).toEqual(beforeViewPreference);
      expect(
        db.query("SELECT * FROM view_subscriptions WHERE id = 'view-subscription-legacy'").get(),
      ).toEqual(beforeViewSubscription);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante una Views legacy parcial sin cambiar datos ni markers", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      db.exec("DROP TABLE view_subscriptions");
      const beforeView = db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get();
      const beforeMarkers = db
        .query("SELECT version, name FROM _migrations ORDER BY version")
        .all();

      expect(() => migrate(db)).toThrow(/legacy Views migration.*incomplete|incompatible/i);
      expect(db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get()).toEqual(
        beforeView,
      );
      expect(db.query("SELECT version, name FROM _migrations ORDER BY version").all()).toEqual(
        beforeMarkers,
      );
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'view_preferences'",
          )
          .get(),
      ).not.toBeNull();
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'view_subscriptions'",
          )
          .get(),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante un nombre de migration contradictorio", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      db.query("UPDATE _migrations SET name = 'notification_preferences' WHERE version = 32").run();
      const beforeView = db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get();
      const beforeMarkers = db
        .query("SELECT version, name FROM _migrations ORDER BY version")
        .all();

      expect(() => migrate(db)).toThrow(/migration 0032.*marker.*Views|contradictory/i);
      expect(db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get()).toEqual(
        beforeView,
      );
      expect(db.query("SELECT version, name FROM _migrations ORDER BY version").all()).toEqual(
        beforeMarkers,
      );
    } finally {
      db.close();
    }
  });

  it("rechaza una base sin SavedView, conserva 0032 y permite reparar y reintentar", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TABLE saved_views");
      db.exec("PRAGMA foreign_keys = ON");

      expect(() => migrate(db)).toThrow(/migration 0033.*saved_views is missing.*retry/i);
      expect(db.query("SELECT version FROM _migrations WHERE version = 32").get()).toEqual({
        version: 32,
      });
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'saved_views'")
          .get(),
      ).toBeNull();
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_preferences'",
          )
          .get(),
      ).toEqual({ name: "notification_preferences" });
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      restoreLegacySavedViews(db);
      migrate(db);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      for (const table of ["saved_views", "view_preferences", "view_subscriptions"]) {
        expect(
          db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table),
        ).toEqual({ name: table });
      }

      const migrationCount = db.query("SELECT count(*) AS count FROM _migrations").get();
      migrate(db);
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(migrationCount);
    } finally {
      db.close();
    }
  });

  it("rechaza un esquema SavedView incompatible antes de reconstruirlo", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TABLE saved_views");
      db.exec("CREATE TABLE saved_views (id TEXT PRIMARY KEY)");
      db.exec("PRAGMA foreign_keys = ON");

      expect(() => migrate(db)).toThrow(
        /migration 0033.*incompatible schema.*missing columns: name/i,
      );
      expect(db.query("SELECT version FROM _migrations WHERE version = 32").get()).toEqual({
        version: 32,
      });
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name = '_prb390_saved_views'").get(),
      ).toBeNull();
      expect(
        db.query("SELECT count(*) AS count FROM pragma_table_info('saved_views')").get(),
      ).toEqual({ count: 1 });
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });

  it("rechaza restricciones y filas inválidas sin escribir 0033 y permite reparar", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      db.exec(`
        INSERT INTO workspace (id, name, url_key, created_at, updated_at)
        VALUES
          ('workspace-a', 'Workspace A', 'workspace-a', '2026-01-01', '2026-01-01'),
          ('workspace-b', 'Workspace B', 'workspace-b', '2026-01-01', '2026-01-01');
        INSERT INTO actors
          (id, name, type, workspace_role, status, created_at, updated_at)
        VALUES ('actor-a', 'Actor A', 'agent', 'admin', 'active', '2026-01-01', '2026-01-01');
        INSERT INTO teams
          (id, workspace_id, name, key, description, created_at, updated_at)
        VALUES ('team-a', 'workspace-a', 'Team A', 'A', NULL, '2026-01-01', '2026-01-01');
      `);
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TABLE saved_views");
      db.exec(`
        CREATE TABLE saved_views (
          id TEXT,
          name TEXT,
          scope TEXT,
          team_id TEXT,
          owner_id TEXT,
          filter_json TEXT,
          order_by TEXT,
          group_by TEXT,
          created_at TEXT,
          updated_at TEXT,
          archived_at TEXT,
          columns_json TEXT,
          workspace_id TEXT
        );
        INSERT INTO saved_views
          (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
           created_at, updated_at, archived_at, columns_json, workspace_id)
        VALUES
          ('missing-refs', 'Missing refs', 'personal', NULL, 'actor-missing', '{}',
           'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]', 'workspace-missing'),
          ('cross-workspace', 'Cross workspace', 'team', 'team-a', 'actor-a', '{}',
           'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]', 'workspace-b');
      `);
      db.exec("PRAGMA foreign_keys = ON");

      const beforeSavedViews = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeMigrations = db.query("SELECT count(*) AS count FROM _migrations").get();
      const runMigration = () => migrate(db);

      expect(runMigration).toThrow(
        /migration 0033.*missing foreign keys.*missing indexes.*owner_id references a missing Actor.*workspace_id references a missing Workspace.*team_id crosses the saved view Workspace/i,
      );
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(beforeMigrations);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeSavedViews);
      for (const table of ["_prb390_saved_views", "view_preferences", "view_subscriptions"]) {
        expect(
          db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table),
        ).toBeNull();
      }
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_preferences'",
          )
          .get(),
      ).toEqual({ name: "notification_preferences" });
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      expect(runMigration).toThrow(/migration 0033.*incompatible schema or data/i);
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(beforeMigrations);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeSavedViews);

      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TABLE saved_views");
      restoreLegacySavedViews(db);
      db.exec("PRAGMA foreign_keys = ON");
      db.query(
        `INSERT INTO saved_views
         (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
          created_at, updated_at, archived_at, columns_json, workspace_id)
         VALUES (?1, ?2, 'team', ?3, ?4, '{}', 'CREATED_DESC', 'state',
                 '2026-01-01', '2026-01-01', NULL, '[]', ?5)`,
      ).run("view-repaired", "Repaired", "team-a", "actor-a", "workspace-a");

      migrate(db);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(db.query("SELECT id, workspace_id, team_id, owner_id FROM saved_views").get()).toEqual(
        {
          id: "view-repaired",
          workspace_id: "workspace-a",
          team_id: "team-a",
          owner_id: "actor-a",
        },
      );
      const migrationCount = db.query("SELECT count(*) AS count FROM _migrations").get();
      migrate(db);
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(migrationCount);
    } finally {
      db.close();
    }
  });
});
