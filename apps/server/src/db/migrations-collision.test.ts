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

function restoreLegacySavedViews(
  db: Database,
  scopeCheck = "CHECK (scope IN ('personal', 'team', 'workspace'))",
): void {
  db.exec(`
    CREATE TABLE saved_views (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL ${scopeCheck},
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

function replaceLegacySavedViewsScopeCheck(db: Database, scopeCheck: string): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX IF EXISTS idx_saved_views_workspace_id;
    DROP INDEX IF EXISTS idx_saved_views_scope;
    DROP INDEX IF EXISTS idx_saved_views_owner;
    ALTER TABLE saved_views RENAME TO _prb641_saved_views;
  `);
  restoreLegacySavedViews(db, scopeCheck);
  db.exec(`
    INSERT INTO saved_views
      (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
       created_at, updated_at, archived_at, columns_json, workspace_id)
    SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
           created_at, updated_at, archived_at, columns_json, workspace_id
      FROM _prb641_saved_views;
    DROP TABLE _prb641_saved_views;
    PRAGMA foreign_keys = ON;
  `);
}

function replaceSavedViewsWithIndependentForeignKeys(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX IF EXISTS idx_saved_views_workspace_id;
    DROP INDEX IF EXISTS idx_saved_views_scope;
    DROP INDEX IF EXISTS idx_saved_views_owner;
    ALTER TABLE saved_views RENAME TO _prb629_saved_views;
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
      FOREIGN KEY (workspace_id) REFERENCES teams(workspace_id),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );
    INSERT INTO saved_views (
      id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
      created_at, updated_at, archived_at, columns_json, workspace_id
    )
    SELECT
      id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
      created_at, updated_at, archived_at, columns_json, workspace_id
    FROM _prb629_saved_views;
    DROP TABLE _prb629_saved_views;
    CREATE UNIQUE INDEX idx_saved_views_workspace_id ON saved_views(workspace_id, id);
    CREATE INDEX idx_saved_views_scope ON saved_views(scope, team_id);
    CREATE INDEX idx_saved_views_owner ON saved_views(owner_id);
    PRAGMA foreign_keys = ON;
  `);
}

function restoreSavedViewsAfterRejectedSchema(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX IF EXISTS idx_saved_views_workspace_id;
    DROP INDEX IF EXISTS idx_saved_views_scope;
    DROP INDEX IF EXISTS idx_saved_views_owner;
    ALTER TABLE saved_views RENAME TO _prb629_rejected_saved_views;
  `);
  restoreLegacySavedViews(db);
  db.exec(`
    INSERT INTO saved_views (
      id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
      created_at, updated_at, archived_at, columns_json, workspace_id
    )
    SELECT
      id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
      created_at, updated_at, archived_at, columns_json, workspace_id
    FROM _prb629_rejected_saved_views;
    DROP TABLE _prb629_rejected_saved_views;
    PRAGMA foreign_keys = ON;
  `);
}

function addLegacySavedViewsNameConstraint(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX IF EXISTS idx_saved_views_workspace_id;
    DROP INDEX IF EXISTS idx_saved_views_scope;
    DROP INDEX IF EXISTS idx_saved_views_owner;
    ALTER TABLE saved_views RENAME TO _prb633_saved_views;
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
      UNIQUE (workspace_id, id),
      UNIQUE (workspace_id, name),
      CHECK ((scope = 'team' AND team_id IS NOT NULL) OR (scope != 'team' AND team_id IS NULL)),
      FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id)
    );
    INSERT INTO saved_views
      (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
       created_at, updated_at, archived_at, columns_json, workspace_id)
    SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
           created_at, updated_at, archived_at, columns_json, workspace_id
      FROM _prb633_saved_views;
    DROP TABLE _prb633_saved_views;
    CREATE UNIQUE INDEX idx_saved_views_workspace_id ON saved_views(workspace_id, id);
    CREATE INDEX idx_saved_views_scope ON saved_views(scope, team_id);
    CREATE INDEX idx_saved_views_owner ON saved_views(owner_id);
    PRAGMA foreign_keys = ON;
  `);
}

function removeViewPreferencesScopeCheck(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX IF EXISTS idx_view_preferences_key;
    DROP INDEX IF EXISTS idx_view_preferences_view;
    DROP INDEX IF EXISTS idx_view_preferences_actor;
    ALTER TABLE view_preferences RENAME TO _prb633_view_preferences;
    CREATE TABLE view_preferences (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      view_id TEXT,
      actor_id TEXT,
      view_type TEXT NOT NULL DEFAULT 'issue' CHECK (view_type IN ('issue', 'project', 'initiative', 'feed')),
      scope TEXT NOT NULL CHECK (scope IN ('actor', 'workspace')),
      layout TEXT NOT NULL DEFAULT 'list' CHECK (layout IN ('list', 'board')),
      order_by TEXT NOT NULL DEFAULT 'UPDATED_DESC' CHECK (order_by IN ('CREATED_ASC', 'CREATED_DESC', 'UPDATED_ASC', 'UPDATED_DESC')),
      group_by TEXT NOT NULL DEFAULT 'state' CHECK (group_by IN ('state', 'milestone', 'assignee', 'priority')),
      columns_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, view_id) REFERENCES saved_views(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, actor_id) REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
    );
    INSERT INTO view_preferences
      SELECT * FROM _prb633_view_preferences;
    DROP TABLE _prb633_view_preferences;
    CREATE UNIQUE INDEX idx_view_preferences_key
      ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, ''));
    CREATE INDEX idx_view_preferences_view ON view_preferences(workspace_id, view_id);
    CREATE INDEX idx_view_preferences_actor ON view_preferences(workspace_id, actor_id);
    PRAGMA foreign_keys = ON;
  `);
}

function removeViewPreferencesActorForeignKey(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX IF EXISTS idx_view_preferences_key;
    DROP INDEX IF EXISTS idx_view_preferences_view;
    DROP INDEX IF EXISTS idx_view_preferences_actor;
    ALTER TABLE view_preferences RENAME TO _prb633_view_preferences;
    CREATE TABLE view_preferences (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      view_id TEXT,
      actor_id TEXT,
      view_type TEXT NOT NULL DEFAULT 'issue' CHECK (view_type IN ('issue', 'project', 'initiative', 'feed')),
      scope TEXT NOT NULL CHECK (scope IN ('actor', 'workspace')),
      layout TEXT NOT NULL DEFAULT 'list' CHECK (layout IN ('list', 'board')),
      order_by TEXT NOT NULL DEFAULT 'UPDATED_DESC' CHECK (order_by IN ('CREATED_ASC', 'CREATED_DESC', 'UPDATED_ASC', 'UPDATED_DESC')),
      group_by TEXT NOT NULL DEFAULT 'state' CHECK (group_by IN ('state', 'milestone', 'assignee', 'priority')),
      columns_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, id),
      CHECK ((scope = 'actor' AND actor_id IS NOT NULL) OR (scope = 'workspace' AND actor_id IS NULL)),
      FOREIGN KEY (workspace_id, view_id) REFERENCES saved_views(workspace_id, id) ON DELETE CASCADE
    );
    INSERT INTO view_preferences SELECT * FROM _prb633_view_preferences;
    DROP TABLE _prb633_view_preferences;
    CREATE UNIQUE INDEX idx_view_preferences_key
      ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, ''));
    CREATE INDEX idx_view_preferences_view ON view_preferences(workspace_id, view_id);
    CREATE INDEX idx_view_preferences_actor ON view_preferences(workspace_id, actor_id);
    PRAGMA foreign_keys = ON;
  `);
}

function removeViewSubscriptionsActorForeignKey(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX IF EXISTS idx_view_subscriptions_view;
    DROP INDEX IF EXISTS idx_view_subscriptions_actor;
    ALTER TABLE view_subscriptions RENAME TO _prb633_view_subscriptions;
    CREATE TABLE view_subscriptions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      view_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      issue_changes INTEGER NOT NULL DEFAULT 1 CHECK (issue_changes IN (0, 1)),
      slack INTEGER NOT NULL DEFAULT 1 CHECK (slack IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, view_id, actor_id),
      CHECK (issue_changes = 1 OR slack = 1),
      FOREIGN KEY (workspace_id, view_id) REFERENCES saved_views(workspace_id, id) ON DELETE CASCADE
    );
    INSERT INTO view_subscriptions SELECT * FROM _prb633_view_subscriptions;
    DROP TABLE _prb633_view_subscriptions;
    CREATE INDEX idx_view_subscriptions_view ON view_subscriptions(workspace_id, view_id);
    CREATE INDEX idx_view_subscriptions_actor ON view_subscriptions(workspace_id, actor_id);
    PRAGMA foreign_keys = ON;
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

function replaceSavedViewsTrigger(db: Database, name: string, definition: string | null): void {
  switch (name) {
    case "saved_views_workspace_scope_insert":
      db.exec("DROP TRIGGER IF EXISTS saved_views_workspace_scope_insert");
      break;
    case "saved_views_workspace_required_insert":
      db.exec("DROP TRIGGER IF EXISTS saved_views_workspace_required_insert");
      break;
    case "saved_views_workspace_required_update":
      db.exec("DROP TRIGGER IF EXISTS saved_views_workspace_required_update");
      break;
    default:
      throw new Error(`Unsupported Views trigger ${name}`);
  }
  if (definition !== null) db.exec(definition);
}

function assertSavedViewsTriggerBehavior(db: Database): void {
  const workspaceValue = db.query("SELECT id FROM workspace LIMIT 1").values()[0]?.[0];
  const actorValue = db.query("SELECT id FROM actors LIMIT 1").values()[0]?.[0];
  if (typeof workspaceValue !== "string" || typeof actorValue !== "string") {
    throw new Error("Trigger behavior fixture is missing its Workspace or Actor");
  }

  db.query(
    `INSERT INTO saved_views
      (id, name, scope, team_id, project_id, initiative_id, owner_id, filter_json, order_by,
       group_by, created_at, updated_at, archived_at, columns_json, workspace_id)
     VALUES ('view-trigger-behavior', 'Trigger behavior', 'personal', NULL, NULL, NULL, ?1, '{}',
       'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]', NULL)`,
  ).run(actorValue);
  expect(
    db
      .query("SELECT workspace_id FROM saved_views WHERE id = 'view-trigger-behavior'")
      .values()[0]?.[0],
  ).toBe(workspaceValue);
  db.query(
    `INSERT INTO saved_views
      (id, name, scope, team_id, project_id, initiative_id, owner_id, filter_json, order_by,
       group_by, created_at, updated_at, archived_at, columns_json, workspace_id)
     VALUES ('view-trigger-explicit', 'Trigger explicit', 'personal', NULL, NULL, NULL, ?1, '{}',
       'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]', ?2)`,
  ).run(actorValue, workspaceValue);
  expect(
    db
      .query("SELECT workspace_id FROM saved_views WHERE id = 'view-trigger-explicit'")
      .values()[0]?.[0],
  ).toBe(workspaceValue);

  db.query(
    `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
     VALUES ('workspace-trigger-second', 'Trigger second', 'workspace-trigger-second',
       '2026-01-01', '2026-01-01')`,
  ).run();
  db.query(
    `INSERT INTO saved_views
      (id, name, scope, team_id, project_id, initiative_id, owner_id, filter_json, order_by,
       group_by, created_at, updated_at, archived_at, columns_json, workspace_id)
     VALUES ('view-trigger-cross-workspace', 'Trigger cross Workspace', 'personal', NULL, NULL,
       NULL, ?1, '{}', 'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]', ?2)`,
  ).run(actorValue, "workspace-trigger-second");
  expect(
    db
      .query("SELECT workspace_id FROM saved_views WHERE id = 'view-trigger-cross-workspace'")
      .values()[0]?.[0],
  ).toBe("workspace-trigger-second");
  db.query(
    "UPDATE saved_views SET name = 'Trigger behavior updated' WHERE id = 'view-trigger-behavior'",
  ).run();
  expect(
    db.query("SELECT name FROM saved_views WHERE id = 'view-trigger-behavior'").values()[0]?.[0],
  ).toBe("Trigger behavior updated");

  const beforeRejectedInsert = db.query("SELECT count(*) FROM saved_views").values()[0]?.[0];
  expect(() =>
    db
      .query(
        `INSERT INTO saved_views
        (id, name, scope, team_id, project_id, initiative_id, owner_id, filter_json, order_by,
         group_by, created_at, updated_at, archived_at, columns_json, workspace_id)
       VALUES ('view-trigger-rejected', 'Rejected trigger insert', 'personal', NULL, NULL, NULL,
         ?1, '{}', 'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]', NULL)`,
      )
      .run(actorValue),
  ).toThrow(/Workspace context is required for saved_views/);
  expect(db.query("SELECT count(*) FROM saved_views").values()[0]?.[0]).toBe(beforeRejectedInsert);

  expect(() =>
    db.query("UPDATE saved_views SET workspace_id = NULL WHERE id = 'view-trigger-behavior'").run(),
  ).toThrow(/Workspace context is required for saved_views/);
  expect(
    db
      .query("SELECT workspace_id FROM saved_views WHERE id = 'view-trigger-behavior'")
      .values()[0]?.[0],
  ).toBe(workspaceValue);
}

describe("colisión de migraciones SQLite", () => {
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

  it("rechaza FKs independientes aunque imiten la FK compuesta de Teams", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      replaceSavedViewsWithIndependentForeignKeys(db);

      const beforeSavedViews = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeFavorite = db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get();
      const beforeSchema = db
        .query(
          `SELECT type, name, sql
           FROM sqlite_master
           WHERE name IN (
             'saved_views', 'idx_saved_views_workspace_id', 'idx_saved_views_scope',
             'idx_saved_views_owner'
           )
           ORDER BY type, name`,
        )
        .all();
      const beforeMigrations = db.query("SELECT count(*) AS count FROM _migrations").get();
      const runMigration = () => migrate(db);

      let firstError = "";
      try {
        runMigration();
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
      }
      expect(firstError).toMatch(
        /migration 0033.*missing foreign keys.*workspace_id, team_id.*teams/i,
      );
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(beforeMigrations);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeSavedViews);
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db
          .query(
            `SELECT type, name, sql
             FROM sqlite_master
             WHERE name IN (
               'saved_views', 'idx_saved_views_workspace_id', 'idx_saved_views_scope',
               'idx_saved_views_owner'
             )
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual(beforeSchema);
      for (const table of ["_prb390_saved_views", "view_preferences", "view_subscriptions"]) {
        expect(
          db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table),
        ).toBeNull();
      }
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      let secondError = "";
      try {
        runMigration();
      } catch (error) {
        secondError = error instanceof Error ? error.message : String(error);
      }
      expect(secondError).toBe(firstError);
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(beforeMigrations);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeSavedViews);

      restoreSavedViewsAfterRejectedSchema(db);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      migrate(db);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const migrationCount = db.query("SELECT count(*) AS count FROM _migrations").get();
      migrate(db);
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(migrationCount);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("ignora CHECKs canónicos escritos en comentarios o literales y permite reparar", () => {
    const maliciousChecks = [
      "CHECK(1)/* scope IN ('personal', 'team', 'workspace') */",
      "CHECK ('scope IN (''personal'', ''team'', ''workspace'')')",
    ];

    for (const scopeCheck of maliciousChecks) {
      const db = databaseWithMigrationsThrough(32);
      try {
        replaceLegacySavedViewsScopeCheck(db, scopeCheck);
        const beforeSchema = db
          .query(
            `SELECT type, name, sql FROM sqlite_master
             WHERE tbl_name = 'saved_views' OR name LIKE 'idx_saved_views_%'
             ORDER BY type, name`,
          )
          .all();
        const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
        const runMigration = () => migrate(db);

        let firstError = "";
        try {
          runMigration();
        } catch (error) {
          firstError = error instanceof Error ? error.message : String(error);
        }
        expect(firstError).toMatch(/migration 0033.*saved_views.*CHECK/i);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
        expect(
          db
            .query(
              `SELECT type, name, sql FROM sqlite_master
               WHERE tbl_name = 'saved_views' OR name LIKE 'idx_saved_views_%'
               ORDER BY type, name`,
            )
            .all(),
        ).toEqual(beforeSchema);
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

        let secondError = "";
        try {
          runMigration();
        } catch (error) {
          secondError = error instanceof Error ? error.message : String(error);
        }
        expect(secondError).toBe(firstError);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

        db.exec("PRAGMA foreign_keys = OFF; DROP TABLE saved_views; PRAGMA foreign_keys = ON");
        restoreLegacySavedViews(db);
        migrate(db);
        expect(db.query("SELECT version, name FROM _migrations WHERE version >= 32").all()).toEqual(
          [
            { version: 32, name: "notification_preferences" },
            { version: 33, name: "views_preferences" },
          ],
        );
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    }
  });

  it("acepta un CHECK canónico con comentarios inline y multiline", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      replaceLegacySavedViewsScopeCheck(
        db,
        `CHECK (
          scope /* inline */ IN (
            'personal', /* multiline
            comment */ 'team', 'workspace'
          )
        )`,
      );

      migrate(db);
      expect(db.query("SELECT version, name FROM _migrations WHERE version >= 32").all()).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("falla cerrado en una Views legacy marcada como 0032 con CHECK eliminado y actor_id NULL", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      removeViewPreferencesScopeCheck(db);
      db.query(
        "UPDATE view_preferences SET actor_id = NULL WHERE id = 'view-preference-legacy'",
      ).run();
      const beforeRows = db.query("SELECT * FROM view_preferences ORDER BY id").all();
      const beforeSchema = db
        .query(
          `SELECT type, name, sql FROM sqlite_master
           WHERE tbl_name = 'view_preferences' OR name = 'view_preferences'
           ORDER BY type, name`,
        )
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      let firstError = "";
      try {
        runMigration();
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
      }
      expect(firstError).toMatch(/legacy Views migration.*CHECK|actor scope/i);
      expect(db.query("SELECT * FROM view_preferences ORDER BY id").all()).toEqual(beforeRows);
      expect(
        db
          .query(
            `SELECT type, name, sql FROM sqlite_master
             WHERE tbl_name = 'view_preferences' OR name = 'view_preferences'
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual(beforeSchema);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();

      let secondError = "";
      try {
        runMigration();
      } catch (error) {
        secondError = error instanceof Error ? error.message : String(error);
      }
      expect(secondError).toBe(firstError);
      expect(db.query("SELECT * FROM view_preferences ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rechaza un índice de preferencias que solo imita la definición en un comentario", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      db.exec(`
        DROP INDEX idx_view_preferences_key;
        CREATE UNIQUE INDEX idx_view_preferences_key ON view_preferences(id)
          /* ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, '')) */;
      `);
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      expect(runMigration).toThrow(
        /legacy Views migration.*incompatible|idx_view_preferences_key/i,
      );
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rechaza columnas, orden, unicidad y textos falsos del índice de preferencias", () => {
    const canonical = `
      CREATE UNIQUE INDEX idx_view_preferences_key
        ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, ''))
    `;
    const definitions = [
      `
        CREATE UNIQUE INDEX idx_view_preferences_key ON view_preferences(id)
          /* ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, '')) */
      `,
      `
        CREATE UNIQUE INDEX idx_view_preferences_key
          ON view_preferences(id || 'ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, ''))')
      `,
      `
        CREATE UNIQUE INDEX idx_view_preferences_key
          ON view_preferences(workspace_id, ifnull(actor_id, ''), view_type, ifnull(view_id, ''))
          /* ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, '')) */
      `,
      `
        CREATE INDEX idx_view_preferences_key
          ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, ''))
      `,
    ];

    for (const definition of definitions) {
      const db = databaseWithMigrationsThrough(30);
      try {
        seedLegacyViewsMigrationMarker(db);
        db.exec("DROP INDEX idx_view_preferences_key");
        db.exec(definition);
        const beforeRows = db.query("SELECT * FROM view_preferences ORDER BY id").all();
        const beforeSchema = db
          .query(
            `SELECT type, name, sql FROM sqlite_master
             WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions')
                OR name IN ('idx_view_preferences_key', 'idx_view_preferences_view',
                            'idx_view_preferences_actor', 'idx_view_subscriptions_view',
                            'idx_view_subscriptions_actor')
             ORDER BY type, name`,
          )
          .all();
        const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
        const runMigration = () => migrate(db);

        let firstError = "";
        try {
          runMigration();
        } catch (error) {
          firstError = error instanceof Error ? error.message : String(error);
        }
        expect(firstError).toMatch(
          /legacy Views migration.*incompatible|idx_view_preferences_key/i,
        );
        expect(db.query("SELECT * FROM view_preferences ORDER BY id").all()).toEqual(beforeRows);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
        expect(
          db
            .query(
              `SELECT type, name, sql FROM sqlite_master
               WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions')
                  OR name IN ('idx_view_preferences_key', 'idx_view_preferences_view',
                              'idx_view_preferences_actor', 'idx_view_subscriptions_view',
                              'idx_view_subscriptions_actor')
               ORDER BY type, name`,
            )
            .all(),
        ).toEqual(beforeSchema);

        let secondError = "";
        try {
          runMigration();
        } catch (error) {
          secondError = error instanceof Error ? error.message : String(error);
        }
        expect(secondError).toBe(firstError);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

        db.exec("DROP INDEX idx_view_preferences_key");
        db.exec(canonical);
        migrate(db);
        expect(db.query("SELECT version, name FROM _migrations WHERE version >= 32").all()).toEqual(
          [
            { version: 32, name: "notification_preferences" },
            { version: 33, name: "views_preferences" },
          ],
        );
        expect(() =>
          db
            .query(
              `INSERT INTO view_preferences (
                 id, workspace_id, view_id, actor_id, view_type, scope, layout, order_by,
                 group_by, columns_json, created_at, updated_at
               )
               SELECT 'duplicate-preference', workspace_id, view_id, actor_id, view_type, scope,
                      layout, order_by, group_by, columns_json, created_at, updated_at
                 FROM view_preferences
                WHERE id = 'view-preference-legacy'`,
            )
            .run(),
        ).toThrow();
        const migrationCount = db.query("SELECT count(*) AS count FROM _migrations").get();
        migrate(db);
        expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(migrationCount);
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    }
  });

  it("vuelve a validar el índice con markers 32 y 33 sin escribir y permite reparar", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      migrate(db);
      db.exec("DROP INDEX idx_view_preferences_key");
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_key ON view_preferences(id)
          /* ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, '')) */
      `);
      const beforeRows = db.query("SELECT * FROM view_preferences ORDER BY id").all();
      const beforeSchema = db
        .query(
          `SELECT type, name, sql FROM sqlite_master
           WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions')
              OR name IN ('idx_view_preferences_key', 'idx_view_preferences_view',
                          'idx_view_preferences_actor', 'idx_view_subscriptions_view',
                          'idx_view_subscriptions_actor')
           ORDER BY type, name`,
        )
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      let firstError = "";
      try {
        runMigration();
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
      }
      expect(firstError).toMatch(/migration 0033.*incompatible|idx_view_preferences_key/i);
      expect(db.query("SELECT * FROM view_preferences ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db
          .query(
            `SELECT type, name, sql FROM sqlite_master
             WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions')
                OR name IN ('idx_view_preferences_key', 'idx_view_preferences_view',
                            'idx_view_preferences_actor', 'idx_view_subscriptions_view',
                            'idx_view_subscriptions_actor')
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual(beforeSchema);

      let secondError = "";
      try {
        runMigration();
      } catch (error) {
        secondError = error instanceof Error ? error.message : String(error);
      }
      expect(secondError).toBe(firstError);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

      db.exec("DROP INDEX idx_view_preferences_key");
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_key
          ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, ''))
      `);
      migrate(db);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      const migrationCount = db.query("SELECT count(*) AS count FROM _migrations").get();
      migrate(db);
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(migrationCount);
    } finally {
      db.close();
    }
  });

  it("restaura un índice cross-table cuando 0033 reutiliza su nombre", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec("CREATE UNIQUE INDEX idx_view_preferences_view ON saved_views(name)");

      migrate(db);

      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('saved_views')
             WHERE name = 'idx_view_preferences_view_legacy'`,
          )
          .get(),
      ).toEqual({ name: "idx_view_preferences_view_legacy", unique_value: 1 });
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('view_preferences')
             WHERE name = 'idx_view_preferences_view'`,
          )
          .get(),
      ).toEqual({ name: "idx_view_preferences_view", unique_value: 0 });
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).not.toBeNull();

      const migrationCount = db.query("SELECT count(*) AS count FROM _migrations").get();
      migrate(db);
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(migrationCount);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("restaura una UNIQUE aunque un trigger de otra tabla use el mismo nombre", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_saved_views_legacy_unique_workspace_id_name
          ON saved_views(workspace_id, name);
        CREATE TRIGGER idx_saved_views_legacy_unique_workspace_id_name
          AFTER INSERT ON actors BEGIN SELECT 1; END;
      `);

      migrate(db);

      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('saved_views')
             WHERE name = 'idx_saved_views_legacy_unique_workspace_id_name'`,
          )
          .get(),
      ).toEqual({
        name: "idx_saved_views_legacy_unique_workspace_id_name",
        unique_value: 1,
      });
      expect(
        db
          .query(
            `SELECT type, tbl_name
             FROM sqlite_master
             WHERE name = 'idx_saved_views_legacy_unique_workspace_id_name'
             ORDER BY type`,
          )
          .all(),
      ).toEqual([
        { type: "index", tbl_name: "saved_views" },
        { type: "trigger", tbl_name: "actors" },
      ]);
      expect(() =>
        db
          .query(
            `INSERT INTO saved_views
             (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
              created_at, updated_at, archived_at, columns_json, workspace_id)
             SELECT 'view-duplicate-name', name, scope, team_id, owner_id, filter_json,
                    order_by, group_by, created_at, updated_at, archived_at, columns_json,
                    workspace_id
               FROM saved_views
              WHERE id = 'view-legacy'`,
          )
          .run(),
      ).toThrow();
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante una definición same-table incompatible y permite reparar", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        DROP INDEX idx_saved_views_scope;
        CREATE UNIQUE INDEX idx_saved_views_scope ON saved_views(name);
      `);
      const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeSchema = db
        .query(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE tbl_name = 'saved_views' OR name = 'idx_saved_views_scope'
           ORDER BY type, name`,
        )
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      expect(runMigration).toThrow(/missing indexes.*saved_views\(scope, team_id\)/i);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db
          .query(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE tbl_name = 'saved_views' OR name = 'idx_saved_views_scope'
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual(beforeSchema);
      expect(runMigration).toThrow(/missing indexes.*saved_views\(scope, team_id\)/i);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

      db.exec(`
        DROP INDEX idx_saved_views_scope;
        CREATE INDEX idx_saved_views_scope ON saved_views(scope, team_id);
      `);
      runMigration();
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
    } finally {
      db.close();
    }
  });

  it("renombra una colisión same-table si un índice equivalente conserva el preflight", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        DROP INDEX idx_saved_views_scope;
        CREATE UNIQUE INDEX idx_saved_views_scope ON saved_views(name);
        CREATE INDEX idx_saved_views_scope_equivalent ON saved_views(scope, team_id);
      `);
      const beforeRows = db
        .query(
          `SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
                  created_at, updated_at, archived_at, columns_json, workspace_id
           FROM saved_views ORDER BY id`,
        )
        .all();

      migrate(db);

      expect(
        db
          .query(
            `SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
                    created_at, updated_at, archived_at, columns_json, workspace_id
             FROM saved_views ORDER BY id`,
          )
          .all(),
      ).toEqual(beforeRows);
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('saved_views')
             WHERE name IN ('idx_saved_views_scope', 'idx_saved_views_scope_legacy')
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "idx_saved_views_scope", unique_value: 0 },
        { name: "idx_saved_views_scope_legacy", unique_value: 1 },
      ]);
      expect(
        db
          .query(
            `SELECT 1
             FROM pragma_index_list('saved_views')
             WHERE name = 'idx_saved_views_scope_equivalent'`,
          )
          .get(),
      ).toBeNull();
      expect(() =>
        db
          .query(
            `INSERT INTO saved_views
             (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
              created_at, updated_at, archived_at, columns_json, workspace_id)
             SELECT 'view-duplicate-scope', name, scope, team_id, owner_id, filter_json,
                    order_by, group_by, created_at, updated_at, archived_at, columns_json,
                    workspace_id
               FROM saved_views
              WHERE id = 'view-legacy'`,
          )
          .run(),
      ).toThrow();
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const markers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const indexes = db
        .query(
          `SELECT name, "unique" AS unique_value
           FROM pragma_index_list('saved_views')
           WHERE name IN ('idx_saved_views_scope', 'idx_saved_views_scope_legacy')
           ORDER BY name`,
        )
        .all();
      migrate(db);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(markers);
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('saved_views')
             WHERE name IN ('idx_saved_views_scope', 'idx_saved_views_scope_legacy')
             ORDER BY name`,
          )
          .all(),
      ).toEqual(indexes);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("conserva una UNIQUE de tabla representada por sqlite_autoindex durante el rebuild", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      bootstrap(db);
      db.exec(`
        INSERT INTO saved_views
          (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
           created_at, updated_at, archived_at, columns_json, workspace_id)
        SELECT 'view-unique', 'Unique legacy view', 'team', teams.id, actors.id, '{}',
               'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]', workspace.id
          FROM workspace
          JOIN actors ON actors.name = 'admin'
          JOIN teams ON teams.workspace_id = workspace.id
         LIMIT 1;
      `);
      addLegacySavedViewsNameConstraint(db);
      expect(
        db
          .query(
            `SELECT 1 FROM pragma_index_list('saved_views')
             WHERE origin = 'u' AND name LIKE 'sqlite_autoindex_saved_views_%'
             LIMIT 1`,
          )
          .get(),
      ).not.toBeNull();

      migrate(db);
      expect(
        db
          .query(
            `SELECT 1 FROM pragma_index_list('saved_views')
             WHERE name = 'idx_saved_views_legacy_unique_workspace_id_name'
               AND "unique" = 1
             LIMIT 1`,
          )
          .get(),
      ).not.toBeNull();

      expect(() =>
        db
          .query(
            `INSERT INTO saved_views
            (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
             created_at, updated_at, archived_at, columns_json, workspace_id)
          SELECT 'view-unique-duplicate', 'Unique legacy view', 'team', teams.id, actors.id, '{}',
                 'CREATED_DESC', 'state', '2026-01-02', '2026-01-02', NULL, '[]', workspace.id
            FROM workspace
            JOIN actors ON actors.name = 'admin'
            JOIN teams ON teams.workspace_id = workspace.id
           LIMIT 1`,
          )
          .run(),
      ).toThrow();
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("valida datos cuando los markers 32/33 ya existen y repite el mismo fallo sin DDL", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      migrate(db);
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.query(
        "UPDATE view_subscriptions SET issue_changes = 0, slack = 0 WHERE id = 'view-subscription-legacy'",
      ).run();
      db.exec("PRAGMA ignore_check_constraints = OFF");

      const beforeRows = db.query("SELECT * FROM view_subscriptions ORDER BY id").all();
      const beforeSchema = db
        .query(
          `SELECT type, name, sql FROM sqlite_master
           WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions')
              OR name IN ('idx_view_preferences_key', 'idx_view_preferences_view',
                          'idx_view_preferences_actor', 'idx_view_subscriptions_view',
                          'idx_view_subscriptions_actor')
           ORDER BY type, name`,
        )
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      let firstError = "";
      try {
        runMigration();
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
      }
      expect(firstError).toMatch(/migration 0033.*incompatible|invalid channel/i);
      expect(db.query("SELECT * FROM view_subscriptions ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db
          .query(
            `SELECT type, name, sql FROM sqlite_master
             WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions')
                OR name IN ('idx_view_preferences_key', 'idx_view_preferences_view',
                            'idx_view_preferences_actor', 'idx_view_subscriptions_view',
                            'idx_view_subscriptions_actor')
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual(beforeSchema);

      let secondError = "";
      try {
        runMigration();
      } catch (error) {
        secondError = error instanceof Error ? error.message : String(error);
      }
      expect(secondError).toBe(firstError);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      db.query(
        "UPDATE view_subscriptions SET issue_changes = 1 WHERE id = 'view-subscription-legacy'",
      ).run();
      migrate(db);
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rechaza FKs y defaults alterados en cada tabla de Views antes de aceptar 0033", () => {
    const cases = [
      {
        alter: removeViewPreferencesActorForeignKey,
        table: "view_preferences",
        expected: /view_preferences.*missing foreign keys/i,
      },
      {
        alter: removeViewSubscriptionsActorForeignKey,
        table: "view_subscriptions",
        expected: /view_subscriptions.*missing foreign keys/i,
      },
    ];

    for (const testCase of cases) {
      const db = openDatabase(":memory:");
      try {
        testCase.alter(db);
        const beforeSchema = db
          .query(
            `SELECT type, name, sql FROM sqlite_master
             WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions')
                OR name IN ('idx_view_preferences_key', 'idx_view_preferences_view',
                            'idx_view_preferences_actor', 'idx_view_subscriptions_view',
                            'idx_view_subscriptions_actor')
             ORDER BY type, name`,
          )
          .all();
        const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();

        expect(() => migrate(db)).toThrow(testCase.expected);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
        expect(
          db
            .query(
              `SELECT type, name, sql FROM sqlite_master
               WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions')
                  OR name IN ('idx_view_preferences_key', 'idx_view_preferences_view',
                              'idx_view_preferences_actor', 'idx_view_subscriptions_view',
                              'idx_view_subscriptions_actor')
               ORDER BY type, name`,
            )
            .all(),
        ).toEqual(beforeSchema);
        expect(
          db
            .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1`)
            .get(testCase.table),
        ).toEqual({ name: testCase.table });
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    }
  });

  it("rechaza triggers Views falsos en comentarios o literales y permite reparar", () => {
    const scopeFragment =
      "AFTER INSERT ON saved_views WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN UPDATE saved_views SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id; END";
    const requiredInsertFragment =
      "BEFORE INSERT ON saved_views WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN SELECT RAISE(ABORT, 'Workspace context is required for saved_views'); END";
    const requiredUpdateFragment =
      "BEFORE UPDATE OF workspace_id ON saved_views WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN SELECT RAISE(ABORT, 'Workspace context is required for saved_views'); END";
    const canonicalScopeTrigger = `CREATE TRIGGER saved_views_workspace_scope_insert ${scopeFragment}`;
    const canonicalRequiredInsertTrigger = `CREATE TRIGGER saved_views_workspace_required_insert ${requiredInsertFragment}`;
    const canonicalRequiredUpdateTrigger = `CREATE TRIGGER saved_views_workspace_required_update ${requiredUpdateFragment}`;
    const cases = [
      {
        name: "saved_views_workspace_scope_insert",
        malformed: null,
        repair: canonicalScopeTrigger,
      },
      {
        name: "saved_views_workspace_scope_insert",
        malformed: `CREATE TRIGGER saved_views_workspace_scope_insert
          BEFORE INSERT ON saved_views
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
          BEGIN
            SELECT 1;
            /* ${scopeFragment} */
          END`,
        repair: canonicalScopeTrigger,
      },
      {
        name: "saved_views_workspace_scope_insert",
        malformed: `CREATE TRIGGER saved_views_workspace_scope_insert
          AFTER INSERT ON saved_views
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
          BEGIN
            SELECT '${scopeFragment}';
          END`,
        repair: canonicalScopeTrigger,
      },
      {
        name: "saved_views_workspace_required_insert",
        malformed: `CREATE TRIGGER saved_views_workspace_required_insert
          AFTER INSERT ON teams
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
          BEGIN
            SELECT 1;
            /* ${requiredInsertFragment} */
          END`,
        repair: canonicalRequiredInsertTrigger,
      },
      {
        name: "saved_views_workspace_required_insert",
        malformed: `CREATE TRIGGER saved_views_workspace_required_insert
          BEFORE UPDATE OF workspace_id ON saved_views
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
          BEGIN
            SELECT 1;
            /* ${requiredInsertFragment} */
          END`,
        repair: canonicalRequiredInsertTrigger,
      },
      {
        name: "saved_views_workspace_required_update",
        malformed: `CREATE TRIGGER saved_views_workspace_required_update
          BEFORE UPDATE OF name ON saved_views
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
          BEGIN
            /* ${requiredUpdateFragment} */
            SELECT 1;
          END`,
        repair: canonicalRequiredUpdateTrigger,
      },
    ];

    for (const testCase of cases) {
      const db = databaseWithMigrationsThrough(30);
      try {
        seedLegacyViewsMigrationMarker(db);
        replaceSavedViewsTrigger(db, testCase.name, testCase.malformed);
        const beforeRows = db
          .query(
            `SELECT 'saved_views' AS table_name, id, workspace_id FROM saved_views
             UNION ALL
             SELECT 'view_preferences', id, workspace_id FROM view_preferences
             UNION ALL
             SELECT 'view_subscriptions', id, workspace_id FROM view_subscriptions
             ORDER BY table_name, id`,
          )
          .all();
        const beforeSchema = db
          .query(
            `SELECT type, name, tbl_name, sql FROM sqlite_master
             WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions', 'teams')
                OR name IN ('saved_views_workspace_scope_insert',
                            'saved_views_workspace_required_insert',
                            'saved_views_workspace_required_update')
             ORDER BY type, name`,
          )
          .all();
        const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
        const runMigration = () => migrate(db);

        let firstError = "";
        try {
          runMigration();
        } catch (error) {
          firstError = error instanceof Error ? error.message : String(error);
        }
        expect(firstError).toMatch(/legacy Views migration.*incompatible/i);
        expect(firstError).toContain(testCase.name);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
        expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();
        expect(
          db
            .query(
              `SELECT 'saved_views' AS table_name, id, workspace_id FROM saved_views
               UNION ALL
               SELECT 'view_preferences', id, workspace_id FROM view_preferences
               UNION ALL
               SELECT 'view_subscriptions', id, workspace_id FROM view_subscriptions
               ORDER BY table_name, id`,
            )
            .all(),
        ).toEqual(beforeRows);
        expect(
          db
            .query(
              `SELECT type, name, tbl_name, sql FROM sqlite_master
               WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions', 'teams')
                  OR name IN ('saved_views_workspace_scope_insert',
                              'saved_views_workspace_required_insert',
                              'saved_views_workspace_required_update')
               ORDER BY type, name`,
            )
            .all(),
        ).toEqual(beforeSchema);

        let secondError = "";
        try {
          runMigration();
        } catch (error) {
          secondError = error instanceof Error ? error.message : String(error);
        }
        expect(secondError).toBe(firstError);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

        replaceSavedViewsTrigger(db, testCase.name, testCase.repair);
        runMigration();
        expect(
          db
            .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
            .all(),
        ).toEqual([
          { version: 32, name: "notification_preferences" },
          { version: 33, name: "views_preferences" },
        ]);
        assertSavedViewsTriggerBehavior(db);
        const migrationMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
        runMigration();
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(
          migrationMarkers,
        );
      } finally {
        db.close();
      }
    }
  });

  it("revalida triggers con markers 32 y 33 sin DDL ni datos parciales", () => {
    const canonical = `BEFORE UPDATE OF workspace_id ON saved_views
      WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
      BEGIN
        SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
      END`;
    const malformed = `BEFORE UPDATE OF workspace_id ON saved_views
      WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
      BEGIN
        SELECT 1;
        /* ${canonical} */
      END`;
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      migrate(db);
      replaceSavedViewsTrigger(
        db,
        "saved_views_workspace_required_update",
        `CREATE TRIGGER saved_views_workspace_required_update ${malformed}`,
      );
      const beforeRows = db
        .query(
          `SELECT 'saved_views' AS table_name, id, workspace_id FROM saved_views
           UNION ALL
           SELECT 'view_preferences', id, workspace_id FROM view_preferences
           UNION ALL
           SELECT 'view_subscriptions', id, workspace_id FROM view_subscriptions
           ORDER BY table_name, id`,
        )
        .all();
      const beforeSchema = db
        .query(
          `SELECT type, name, tbl_name, sql FROM sqlite_master
           WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions')
              OR name IN ('saved_views_workspace_scope_insert',
                          'saved_views_workspace_required_insert',
                          'saved_views_workspace_required_update')
           ORDER BY type, name`,
        )
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      let firstError = "";
      try {
        runMigration();
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
      }
      expect(firstError).toMatch(/migration 0033.*incompatible/i);
      expect(firstError).toContain("saved_views_workspace_required_update");
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db
          .query(
            `SELECT 'saved_views' AS table_name, id, workspace_id FROM saved_views
             UNION ALL
             SELECT 'view_preferences', id, workspace_id FROM view_preferences
             UNION ALL
             SELECT 'view_subscriptions', id, workspace_id FROM view_subscriptions
             ORDER BY table_name, id`,
          )
          .all(),
      ).toEqual(beforeRows);
      expect(
        db
          .query(
            `SELECT type, name, tbl_name, sql FROM sqlite_master
             WHERE tbl_name IN ('saved_views', 'view_preferences', 'view_subscriptions')
                OR name IN ('saved_views_workspace_scope_insert',
                            'saved_views_workspace_required_insert',
                            'saved_views_workspace_required_update')
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual(beforeSchema);

      let secondError = "";
      try {
        runMigration();
      } catch (error) {
        secondError = error instanceof Error ? error.message : String(error);
      }
      expect(secondError).toBe(firstError);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

      replaceSavedViewsTrigger(
        db,
        "saved_views_workspace_required_update",
        `CREATE TRIGGER saved_views_workspace_required_update ${canonical}`,
      );
      runMigration();
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      assertSavedViewsTriggerBehavior(db);
      const migrationMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      runMigration();
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(
        migrationMarkers,
      );
    } finally {
      db.close();
    }
  });
});
