import { Database, type SQLQueryBindings } from "bun:sqlite";
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

function installUppercaseNotificationSchema(db: Database): void {
  db.exec(`
    CREATE TABLE "NOTIFICATION_PREFERENCES" (
      "WORKSPACE_ID" TEXT NOT NULL,
      "ACTOR_ID" TEXT NOT NULL,
      "CATEGORY" TEXT NOT NULL,
      "CHANNEL" TEXT NOT NULL,
      "ENABLED" INTEGER NOT NULL DEFAULT 1 CHECK ("ENABLED" IN (0, 1)),
      "EMAIL_DELIVERY" TEXT CHECK ("EMAIL_DELIVERY" IN ('digest', 'immediate')),
      "CREATED_AT" TEXT NOT NULL,
      "UPDATED_AT" TEXT NOT NULL,
      PRIMARY KEY ("WORKSPACE_ID", "ACTOR_ID", "CATEGORY", "CHANNEL"),
      CHECK ("CATEGORY" IN ('assignments', 'mentions', 'comments', 'status_changes', 'reviews', 'project_updates')),
      CHECK ("CHANNEL" IN ('inbox', 'desktop', 'mobile', 'email', 'slack')),
      CHECK (("CHANNEL" = 'email' AND "EMAIL_DELIVERY" IS NOT NULL)
        OR ("CHANNEL" <> 'email' AND "EMAIL_DELIVERY" IS NULL)),
      FOREIGN KEY ("WORKSPACE_ID", "ACTOR_ID")
        REFERENCES "WORKSPACE_MEMBERSHIPS"("WORKSPACE_ID", "ACTOR_ID") ON DELETE CASCADE
    );
    CREATE INDEX "IDX_NOTIFICATION_PREFERENCES_ACTOR_WORKSPACE"
      ON "NOTIFICATION_PREFERENCES"("ACTOR_ID", "WORKSPACE_ID");
    INSERT INTO _migrations (version, name, applied_at)
      VALUES (32, 'notification_preferences', '2026-01-01T00:00:00.000Z');
  `);
}

function replaceNotificationSchema(db: Database, transform: (sql: string) => string): void {
  db.exec(
    "DROP INDEX idx_notification_preferences_actor_workspace; DROP TABLE notification_preferences;",
  );
  const migration = readFileSync(
    join(import.meta.dir, "migrations", "0032_notification_preferences.sql"),
    "utf8",
  );
  db.exec(transform(migration));
}

function restoreNotificationSchema(db: Database): void {
  db.exec(
    "DROP INDEX IF EXISTS idx_notification_preferences_actor_workspace; DROP TABLE notification_preferences;",
  );
  db.exec(
    readFileSync(join(import.meta.dir, "migrations", "0032_notification_preferences.sql"), "utf8"),
  );
}

function notificationSchemaSnapshot(db: Database): unknown[] {
  return db
    .query(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE tbl_name = 'notification_preferences'
          OR name = 'idx_notification_preferences_actor_workspace'
       ORDER BY type, name`,
    )
    .all();
}

function insertInvalidNotificationRow(
  db: Database,
  category: string,
  channel: string,
  enabled: number | string,
  emailDelivery: string | null,
): void {
  db.exec("PRAGMA ignore_check_constraints = ON");
  try {
    db.query(
      `INSERT INTO notification_preferences
           (workspace_id, actor_id, category, channel, enabled, email_delivery, created_at, updated_at)
         SELECT workspace.id, actors.id, ?1, ?2, ?3, ?4, ?5, ?5
           FROM workspace
           JOIN actors ON actors.name = 'admin'
          LIMIT 1`,
    ).run(category, channel, enabled, emailDelivery, "2026-01-01");
  } finally {
    db.exec("PRAGMA ignore_check_constraints = OFF");
  }
}

function insertOrphanNotificationRow(db: Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.query(
      `INSERT INTO notification_preferences
         (workspace_id, actor_id, category, channel, enabled, email_delivery, created_at, updated_at)
       VALUES ('workspace-missing', 'actor-missing', 'mentions', 'inbox', 1, NULL, '2026-01-01', '2026-01-01')`,
    ).run();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function quoteTestIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteTestLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renameTestTable(db: Database, current: string, next: string): void {
  const temporary = `__prb655_${current}`;
  db.exec(
    `ALTER TABLE ${quoteTestIdentifier(current)} RENAME TO ${quoteTestIdentifier(temporary)}`,
  );
  db.exec(`ALTER TABLE ${quoteTestIdentifier(temporary)} RENAME TO ${quoteTestIdentifier(next)}`);
}

function renameTestColumn(db: Database, table: string, current: string, next: string): void {
  const temporary = `__prb655_${current}`;
  db.exec(
    `ALTER TABLE ${quoteTestIdentifier(table)} RENAME COLUMN ${quoteTestIdentifier(current)} TO ${quoteTestIdentifier(temporary)}`,
  );
  db.exec(
    `ALTER TABLE ${quoteTestIdentifier(table)} RENAME COLUMN ${quoteTestIdentifier(temporary)} TO ${quoteTestIdentifier(next)}`,
  );
}

function uppercaseLegacySchema(db: Database, includeNotification: boolean): void {
  db.exec(`
    DROP TRIGGER IF EXISTS saved_views_workspace_scope_insert;
    DROP TRIGGER IF EXISTS saved_views_workspace_required_insert;
    DROP TRIGGER IF EXISTS saved_views_workspace_required_update;
  `);

  const indexNames = [
    "idx_saved_views_workspace_id",
    "idx_saved_views_scope",
    "idx_saved_views_owner",
    "idx_saved_views_project",
    "idx_saved_views_initiative",
    "idx_view_preferences_key",
    "idx_view_preferences_view",
    "idx_view_preferences_actor",
    "idx_view_subscriptions_view",
    "idx_view_subscriptions_actor",
    "idx_notification_preferences_actor_workspace",
  ];
  for (const index of indexNames) {
    db.exec(`DROP INDEX IF EXISTS ${quoteTestIdentifier(index)}`);
  }

  const tables: Array<[string, string]> = [
    ["saved_views", "SAVED_VIEWS"],
    ["view_preferences", "VIEW_PREFERENCES"],
    ["view_subscriptions", "VIEW_SUBSCRIPTIONS"],
    ["workspace", "WORKSPACE"],
    ["actors", "ACTORS"],
    ["teams", "TEAMS"],
    ["projects", "PROJECTS"],
    ["initiatives", "INITIATIVES"],
    ["workspace_memberships", "WORKSPACE_MEMBERSHIPS"],
  ];
  if (includeNotification) tables.push(["notification_preferences", "NOTIFICATION_PREFERENCES"]);
  for (const [current, next] of tables) renameTestTable(db, current, next);

  const columns: Array<[string, string, string]> = [
    ["SAVED_VIEWS", "id", "ID"],
    ["SAVED_VIEWS", "name", "NAME"],
    ["SAVED_VIEWS", "scope", "SCOPE"],
    ["SAVED_VIEWS", "team_id", "TEAM_ID"],
    ["SAVED_VIEWS", "project_id", "PROJECT_ID"],
    ["SAVED_VIEWS", "initiative_id", "INITIATIVE_ID"],
    ["SAVED_VIEWS", "owner_id", "OWNER_ID"],
    ["SAVED_VIEWS", "filter_json", "FILTER_JSON"],
    ["SAVED_VIEWS", "order_by", "ORDER_BY"],
    ["SAVED_VIEWS", "group_by", "GROUP_BY"],
    ["SAVED_VIEWS", "created_at", "CREATED_AT"],
    ["SAVED_VIEWS", "updated_at", "UPDATED_AT"],
    ["SAVED_VIEWS", "archived_at", "ARCHIVED_AT"],
    ["SAVED_VIEWS", "columns_json", "COLUMNS_JSON"],
    ["SAVED_VIEWS", "workspace_id", "WORKSPACE_ID"],
    ["VIEW_PREFERENCES", "id", "ID"],
    ["VIEW_PREFERENCES", "workspace_id", "WORKSPACE_ID"],
    ["VIEW_PREFERENCES", "view_id", "VIEW_ID"],
    ["VIEW_PREFERENCES", "actor_id", "ACTOR_ID"],
    ["VIEW_PREFERENCES", "view_type", "VIEW_TYPE"],
    ["VIEW_PREFERENCES", "scope", "SCOPE"],
    ["VIEW_PREFERENCES", "layout", "LAYOUT"],
    ["VIEW_PREFERENCES", "order_by", "ORDER_BY"],
    ["VIEW_PREFERENCES", "group_by", "GROUP_BY"],
    ["VIEW_PREFERENCES", "columns_json", "COLUMNS_JSON"],
    ["VIEW_PREFERENCES", "created_at", "CREATED_AT"],
    ["VIEW_PREFERENCES", "updated_at", "UPDATED_AT"],
    ["VIEW_SUBSCRIPTIONS", "id", "ID"],
    ["VIEW_SUBSCRIPTIONS", "workspace_id", "WORKSPACE_ID"],
    ["VIEW_SUBSCRIPTIONS", "view_id", "VIEW_ID"],
    ["VIEW_SUBSCRIPTIONS", "actor_id", "ACTOR_ID"],
    ["VIEW_SUBSCRIPTIONS", "issue_changes", "ISSUE_CHANGES"],
    ["VIEW_SUBSCRIPTIONS", "slack", "SLACK"],
    ["VIEW_SUBSCRIPTIONS", "created_at", "CREATED_AT"],
    ["VIEW_SUBSCRIPTIONS", "updated_at", "UPDATED_AT"],
    ["WORKSPACE", "id", "ID"],
    ["ACTORS", "id", "ID"],
    ["TEAMS", "id", "ID"],
    ["TEAMS", "workspace_id", "WORKSPACE_ID"],
    ["PROJECTS", "id", "ID"],
    ["PROJECTS", "workspace_id", "WORKSPACE_ID"],
    ["INITIATIVES", "id", "ID"],
    ["INITIATIVES", "workspace_id", "WORKSPACE_ID"],
    ["WORKSPACE_MEMBERSHIPS", "workspace_id", "WORKSPACE_ID"],
    ["WORKSPACE_MEMBERSHIPS", "actor_id", "ACTOR_ID"],
  ];
  if (includeNotification) {
    columns.push(
      ["NOTIFICATION_PREFERENCES", "workspace_id", "WORKSPACE_ID"],
      ["NOTIFICATION_PREFERENCES", "actor_id", "ACTOR_ID"],
      ["NOTIFICATION_PREFERENCES", "category", "CATEGORY"],
      ["NOTIFICATION_PREFERENCES", "channel", "CHANNEL"],
      ["NOTIFICATION_PREFERENCES", "enabled", "ENABLED"],
      ["NOTIFICATION_PREFERENCES", "email_delivery", "EMAIL_DELIVERY"],
      ["NOTIFICATION_PREFERENCES", "created_at", "CREATED_AT"],
      ["NOTIFICATION_PREFERENCES", "updated_at", "UPDATED_AT"],
    );
  }
  for (const [table, current, next] of columns) renameTestColumn(db, table, current, next);

  db.exec(`
    CREATE UNIQUE INDEX "IDX_SAVED_VIEWS_WORKSPACE_ID"
      ON "SAVED_VIEWS"("WORKSPACE_ID", "ID");
    CREATE INDEX "IDX_SAVED_VIEWS_SCOPE" ON "SAVED_VIEWS"("SCOPE", "TEAM_ID");
    CREATE INDEX "IDX_SAVED_VIEWS_OWNER" ON "SAVED_VIEWS"("OWNER_ID");
    CREATE INDEX "IDX_SAVED_VIEWS_PROJECT" ON "SAVED_VIEWS"("WORKSPACE_ID", "PROJECT_ID");
    CREATE INDEX "IDX_SAVED_VIEWS_INITIATIVE" ON "SAVED_VIEWS"("WORKSPACE_ID", "INITIATIVE_ID");
    CREATE UNIQUE INDEX "IDX_VIEW_PREFERENCES_KEY"
      ON "VIEW_PREFERENCES"("WORKSPACE_ID", ifnull("VIEW_ID", ''), "VIEW_TYPE", ifnull("ACTOR_ID", ''));
    CREATE INDEX "IDX_VIEW_PREFERENCES_VIEW" ON "VIEW_PREFERENCES"("WORKSPACE_ID", "VIEW_ID");
    CREATE INDEX "IDX_VIEW_PREFERENCES_ACTOR" ON "VIEW_PREFERENCES"("WORKSPACE_ID", "ACTOR_ID");
    CREATE INDEX "IDX_VIEW_SUBSCRIPTIONS_VIEW" ON "VIEW_SUBSCRIPTIONS"("WORKSPACE_ID", "VIEW_ID");
    CREATE INDEX "IDX_VIEW_SUBSCRIPTIONS_ACTOR" ON "VIEW_SUBSCRIPTIONS"("WORKSPACE_ID", "ACTOR_ID");
  `);
  if (includeNotification) {
    db.exec(`
      CREATE INDEX "IDX_NOTIFICATION_PREFERENCES_ACTOR_WORKSPACE"
        ON "NOTIFICATION_PREFERENCES"("ACTOR_ID", "WORKSPACE_ID");
    `);
  }

  db.exec(`
    CREATE TRIGGER "SAVED_VIEWS_WORKSPACE_SCOPE_INSERT"
    AFTER INSERT ON "SAVED_VIEWS"
    WHEN NEW."WORKSPACE_ID" IS NULL AND (SELECT count(*) FROM "WORKSPACE") = 1
    BEGIN
      UPDATE "SAVED_VIEWS" SET "WORKSPACE_ID" = (SELECT "ID" FROM "WORKSPACE") WHERE "ID" = NEW."ID";
    END;
    CREATE TRIGGER "SAVED_VIEWS_WORKSPACE_REQUIRED_INSERT"
    BEFORE INSERT ON "SAVED_VIEWS"
    WHEN NEW."WORKSPACE_ID" IS NULL AND (SELECT count(*) FROM "WORKSPACE") > 1
    BEGIN
      SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
    END;
    CREATE TRIGGER "SAVED_VIEWS_WORKSPACE_REQUIRED_UPDATE"
    BEFORE UPDATE OF "WORKSPACE_ID" ON "SAVED_VIEWS"
    WHEN NEW."WORKSPACE_ID" IS NULL AND (SELECT count(*) FROM "WORKSPACE") > 1
    BEGIN
      SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
    END;
  `);
}

function dropSavedViewsTriggers(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS saved_views_workspace_scope_insert;
    DROP TRIGGER IF EXISTS saved_views_workspace_required_insert;
    DROP TRIGGER IF EXISTS saved_views_workspace_required_update;
  `);
}

function createLegacySavedViewsTriggers(db: Database): void {
  db.exec(`
    CREATE TRIGGER saved_views_workspace_scope_insert
    AFTER INSERT ON saved_views
    WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
    BEGIN
      UPDATE saved_views SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
    END;

    CREATE TRIGGER saved_views_workspace_required_insert
    BEFORE INSERT ON saved_views
    WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
    BEGIN
      SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
    END;

    CREATE TRIGGER saved_views_workspace_required_update
    BEFORE UPDATE OF workspace_id ON saved_views
    WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
    BEGIN
      SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
    END;
  `);
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
  createLegacySavedViewsTriggers(db);
}

function replaceLegacySavedViewsScopeCheck(db: Database, scopeCheck: string): void {
  dropSavedViewsTriggers(db);
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
  dropSavedViewsTriggers(db);
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
  dropSavedViewsTriggers(db);
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
  dropSavedViewsTriggers(db);
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
  createLegacySavedViewsTriggers(db);
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
  it("acepta la tabla e índice quoted en mayúsculas de Notifications", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      installUppercaseNotificationSchema(db);
      db.exec(`
        INSERT INTO notification_preferences
          (workspace_id, actor_id, category, channel, enabled, email_delivery, created_at, updated_at)
        SELECT workspace.id, actors.id, 'mentions', 'email', 1, 'immediate',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        FROM workspace JOIN actors ON actors.name = 'admin' LIMIT 1;
      `);
      expect(() => migrate(db)).not.toThrow();
      expect(db.query("SELECT name FROM _migrations WHERE version = 32").get()).toEqual({
        name: "notification_preferences",
      });
      expect(db.query("SELECT count(*) AS count FROM notification_preferences").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
  });

  it("valida el contrato completo de Notifications y permite reparar cada restricción", () => {
    const cases = [
      {
        description: "tipo y default de enabled",
        transform: (sql: string) =>
          sql.replace("enabled INTEGER NOT NULL DEFAULT 1", "enabled TEXT NOT NULL DEFAULT 'bad'"),
        expected: /enabled has type TEXT|enabled has default 'bad'/i,
      },
      {
        description: "NOT NULL de actor_id",
        transform: (sql: string) => sql.replace("actor_id TEXT NOT NULL", "actor_id TEXT"),
        expected: /actor_id has NOT NULL=0/i,
      },
      {
        description: "default de enabled",
        transform: (sql: string) => sql.replace("DEFAULT 1", "DEFAULT 0"),
        expected: /enabled has default 0/i,
      },
      {
        description: "orden de la PK",
        transform: (sql: string) =>
          sql.replace(
            "PRIMARY KEY (workspace_id, actor_id, category, channel)",
            "PRIMARY KEY (workspace_id, category, actor_id, channel)",
          ),
        expected: /incompatible primary key|PRIMARY KEY autoindex/i,
      },
      {
        description: "UNIQUE en lugar de PK",
        transform: (sql: string) =>
          sql.replace(
            "PRIMARY KEY (workspace_id, actor_id, category, channel)",
            "UNIQUE (workspace_id, actor_id, category, channel)",
          ),
        expected: /incompatible primary key|PRIMARY KEY autoindex/i,
      },
      {
        description: "CHECK de category",
        transform: (sql: string) => sql.replace("'reviews'", "'review'"),
        expected: /missing CHECK \(category IN/i,
      },
      {
        description: "CHECK de channel",
        transform: (sql: string) => sql.replace("'slack'", "'teams'"),
        expected: /missing CHECK \(channel IN/i,
      },
      {
        description: "CHECK de enabled",
        transform: (sql: string) => sql.replace("enabled IN (0, 1)", "enabled IN (0, 2)"),
        expected: /missing CHECK \(enabled IN/i,
      },
      {
        description: "CHECK de email_delivery",
        transform: (sql: string) =>
          sql.replace(
            "email_delivery IN ('digest', 'immediate')",
            "email_delivery IN ('digest', 'immediately')",
          ),
        expected: /missing CHECK \(email_delivery IN/i,
      },
      {
        description: "CHECK de relación entre canal y email_delivery",
        transform: (sql: string) => sql.replace("channel <> 'email'", "channel <> 'inbox'"),
        expected: /missing CHECK \(\(channel = 'email'/i,
      },
      {
        description: "FK ausente",
        transform: (sql: string) =>
          sql.replace(
            `,
  FOREIGN KEY (workspace_id, actor_id)
    REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE`,
            "",
          ),
        expected: /missing foreign keys.*workspace_id, actor_id.*workspace_memberships/i,
      },
      {
        description: "tabla destino de FK",
        transform: (sql: string) =>
          sql.replace("REFERENCES workspace_memberships", "REFERENCES actors"),
        expected: /missing foreign keys.*workspace_id, actor_id.*workspace_memberships/i,
      },
      {
        description: "columnas destino de FK",
        transform: (sql: string) =>
          sql.replace(
            "workspace_memberships(workspace_id, actor_id)",
            "workspace_memberships(actor_id, workspace_id)",
          ),
        expected: /missing foreign keys.*workspace_id, actor_id.*workspace_memberships/i,
      },
      {
        description: "orden de columnas de FK",
        transform: (sql: string) =>
          sql.replace(
            "FOREIGN KEY (workspace_id, actor_id)",
            "FOREIGN KEY (actor_id, workspace_id)",
          ),
        expected: /missing foreign keys.*workspace_id, actor_id.*workspace_memberships/i,
      },
      {
        description: "acción ON DELETE de FK",
        transform: (sql: string) => sql.replace("ON DELETE CASCADE", "ON DELETE RESTRICT"),
        expected: /missing foreign keys.*workspace_id, actor_id.*workspace_memberships/i,
      },
      {
        description: "acción ON UPDATE de FK",
        transform: (sql: string) =>
          sql.replace("ON DELETE CASCADE", "ON UPDATE CASCADE ON DELETE CASCADE"),
        expected: /missing foreign keys.*workspace_id, actor_id.*workspace_memberships/i,
      },
      {
        description: "FK inesperada",
        transform: (sql: string) =>
          sql.replace(
            `  FOREIGN KEY (workspace_id, actor_id)
    REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE`,
            `  FOREIGN KEY (workspace_id, actor_id)
    REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE,
  FOREIGN KEY (category) REFERENCES actors(id)`,
          ),
        expected: /unexpected foreign key/i,
      },
      {
        description: "columnas del índice",
        transform: (sql: string) =>
          sql.replace(
            "ON notification_preferences(actor_id, workspace_id)",
            "ON notification_preferences(workspace_id, actor_id)",
          ),
        expected: /incompatible index idx_notification_preferences_actor_workspace/i,
      },
      {
        description: "unicidad del índice",
        transform: (sql: string) =>
          sql.replace(
            "CREATE INDEX idx_notification_preferences_actor_workspace",
            "CREATE UNIQUE INDEX idx_notification_preferences_actor_workspace",
          ),
        expected: /incompatible index idx_notification_preferences_actor_workspace/i,
      },
      {
        description: "índice ausente",
        transform: (sql: string) =>
          sql.replace(
            `CREATE INDEX idx_notification_preferences_actor_workspace
  ON notification_preferences(actor_id, workspace_id);
`,
            "",
          ),
        expected: /incompatible index idx_notification_preferences_actor_workspace/i,
      },
    ];

    for (const testCase of cases) {
      const db = databaseWithMigrationsThrough(32);
      try {
        bootstrap(db);
        replaceNotificationSchema(db, testCase.transform);
        const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
        const beforeSchema = notificationSchemaSnapshot(db);
        const runMigration = () => migrate(db);

        expect(runMigration).toThrow(testCase.expected);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
        expect(notificationSchemaSnapshot(db)).toEqual(beforeSchema);
        expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();

        expect(runMigration).toThrow(testCase.expected);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
        expect(notificationSchemaSnapshot(db)).toEqual(beforeSchema);

        restoreNotificationSchema(db);
        expect(runMigration).not.toThrow();
        expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
          version: 33,
        });
        const markers = db.query("SELECT * FROM _migrations ORDER BY version").all();
        expect(runMigration).not.toThrow();
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(markers);
      } finally {
        db.close();
      }
    }
  });

  it("rechaza valores incompatibles de Notifications antes de DDL y permite reparar", () => {
    const cases = [
      {
        description: "category",
        category: "invalid-category",
        channel: "inbox",
        enabled: 1,
        emailDelivery: null,
        expected: /category has an invalid value/i,
      },
      {
        description: "channel",
        category: "comments",
        channel: "invalid-channel",
        enabled: 1,
        emailDelivery: null,
        expected: /channel has an invalid value/i,
      },
      {
        description: "enabled",
        category: "status_changes",
        channel: "desktop",
        enabled: 2,
        emailDelivery: null,
        expected: /enabled has an invalid value/i,
      },
      {
        description: "tipo de enabled",
        category: "comments",
        channel: "mobile",
        enabled: "bad",
        emailDelivery: null,
        expected: /enabled has an invalid value/i,
      },
      {
        description: "email_delivery desconocido",
        category: "reviews",
        channel: "email",
        enabled: 1,
        emailDelivery: "invalid-delivery",
        expected: /email_delivery has an invalid value/i,
      },
      {
        description: "email_delivery requerido",
        category: "project_updates",
        channel: "email",
        enabled: 1,
        emailDelivery: null,
        expected: /email_delivery does not match channel/i,
      },
      {
        description: "email_delivery ausente para canales no email",
        category: "assignments",
        channel: "inbox",
        enabled: 1,
        emailDelivery: "digest",
        expected: /email_delivery does not match channel/i,
      },
      {
        description: "Workspace y Membership",
        orphan: true,
        expected: /missing Workspace|missing Workspace Membership/i,
      },
    ];

    for (const testCase of cases) {
      const db = databaseWithMigrationsThrough(32);
      try {
        bootstrap(db);
        if ("orphan" in testCase) {
          insertOrphanNotificationRow(db);
        } else {
          insertInvalidNotificationRow(
            db,
            testCase.category,
            testCase.channel,
            testCase.enabled,
            testCase.emailDelivery,
          );
        }
        const beforeRows = db.query("SELECT * FROM notification_preferences ORDER BY rowid").all();
        const beforeSchema = notificationSchemaSnapshot(db);
        const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
        const runMigration = () => migrate(db);
        let firstError = "";
        try {
          runMigration();
        } catch (error) {
          firstError = error instanceof Error ? error.message : String(error);
        }

        expect(firstError).toMatch(testCase.expected);
        expect(db.query("SELECT * FROM notification_preferences ORDER BY rowid").all()).toEqual(
          beforeRows,
        );
        expect(notificationSchemaSnapshot(db)).toEqual(beforeSchema);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
        expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();

        let secondError = "";
        try {
          runMigration();
        } catch (error) {
          secondError = error instanceof Error ? error.message : String(error);
        }
        expect(secondError).toBe(firstError);
        expect(db.query("SELECT * FROM notification_preferences ORDER BY rowid").all()).toEqual(
          beforeRows,
        );
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

        db.query("DELETE FROM notification_preferences").run();
        expect(() => migrate(db)).not.toThrow();
        expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
          version: 33,
        });
        const markers = db.query("SELECT * FROM _migrations ORDER BY version").all();
        expect(() => migrate(db)).not.toThrow();
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(markers);
      } finally {
        db.close();
      }
    }
  });

  it("revalida los datos de Notifications cuando ya existen markers 32 y 33", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      bootstrap(db);
      migrate(db);
      insertInvalidNotificationRow(db, "mentions", "email", 1, null);
      const beforeRows = db.query("SELECT * FROM notification_preferences ORDER BY rowid").all();
      const beforeSchema = notificationSchemaSnapshot(db);
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      expect(runMigration).toThrow(/email_delivery does not match channel/i);
      expect(db.query("SELECT * FROM notification_preferences ORDER BY rowid").all()).toEqual(
        beforeRows,
      );
      expect(notificationSchemaSnapshot(db)).toEqual(beforeSchema);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(runMigration).toThrow(/email_delivery does not match channel/i);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

      db.query("DELETE FROM notification_preferences").run();
      expect(() => migrate(db)).not.toThrow();
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
    } finally {
      db.close();
    }
  });

  it("reconcilia Views con tablas, columnas, FKs, índices y triggers quoted en mayúsculas", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      seedLegacyViewsMigrationMarker(db);
      uppercaseLegacySchema(db, false);
      expect(() => migrate(db)).not.toThrow();
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      expect(db.query("SELECT count(*) AS count FROM saved_views").get()).toEqual({ count: 1 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => migrate(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("revalida un schema completo de marker33 con identificadores quoted en mayúsculas", () => {
    const db = openDatabase(":memory:");
    try {
      seedLegacyNotificationAndViewData(db);
      uppercaseLegacySchema(db, true);
      expect(() => migrate(db)).not.toThrow();
      expect(db.query("SELECT count(*) AS count FROM notification_preferences").get()).toEqual({
        count: 1,
      });
      expect(db.query("SELECT count(*) AS count FROM saved_views").get()).toEqual({ count: 1 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => migrate(db)).not.toThrow();
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

  it("resuelve una colisión cross-table del índice de Notifications antes de 0032", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec(
        'CREATE UNIQUE INDEX "IDX_NOTIFICATION_PREFERENCES_ACTOR_WORKSPACE" ON "actors"(name COLLATE NOCASE) WHERE name <> \'ignored\'',
      );

      migrate(db);

      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value, partial
             FROM pragma_index_list('actors')
             WHERE lower(name) = lower(?1)`,
          )
          .get("IDX_NOTIFICATION_PREFERENCES_ACTOR_WORKSPACE_legacy"),
      ).toEqual({
        name: "IDX_NOTIFICATION_PREFERENCES_ACTOR_WORKSPACE_legacy",
        unique_value: 1,
        partial: 1,
      });
      expect(
        db
          .query("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?1")
          .get("IDX_NOTIFICATION_PREFERENCES_ACTOR_WORKSPACE_legacy"),
      ).toEqual({ tbl_name: "actors" });
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1")
          .get("idx_notification_preferences_actor_workspace"),
      ).toEqual({ name: "idx_notification_preferences_actor_workspace" });
      expect(() =>
        db
          .query(
            `INSERT INTO actors (id, name, type, created_at, updated_at)
             VALUES ('notification-duplicate-actor', 'ADMIN', 'human', '2026-01-01', '2026-01-01')`,
          )
          .run(),
      ).toThrow();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const migrationMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      migrate(db);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(
        migrationMarkers,
      );
    } finally {
      db.close();
    }
  });

  it("renombra un índice ajeno que ocupa el nombre de la tabla de Notifications", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec('CREATE UNIQUE INDEX "NOTIFICATION_PREFERENCES" ON "actors"(name)');

      migrate(db);

      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('actors')
             WHERE lower(name) = lower(?1)`,
          )
          .get("NOTIFICATION_PREFERENCES_legacy"),
      ).toEqual({ name: "NOTIFICATION_PREFERENCES_legacy", unique_value: 1 });
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1")
          .get("notification_preferences"),
      ).toEqual({ name: "notification_preferences" });
      expect(db.query("SELECT version FROM _migrations WHERE version = 32").get()).toEqual({
        version: 32,
      });
    } finally {
      db.close();
    }
  });

  it("renombra una View ajena que ocupa el nombre de la tabla de Notifications", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec('CREATE VIEW "NOTIFICATION_PREFERENCES" AS SELECT id, name FROM "actors"');
      const beforeViewRows = db.query("SELECT id, name FROM actors ORDER BY id").all();

      migrate(db);

      expect(
        db
          .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'view' AND lower(name) = lower(?1)",
          )
          .get("notification_preferences_legacy"),
      ).toEqual({
        name: "NOTIFICATION_PREFERENCES_legacy",
        tbl_name: "NOTIFICATION_PREFERENCES_legacy",
      });
      expect(
        db.query("SELECT id, name FROM NOTIFICATION_PREFERENCES_legacy ORDER BY id").all(),
      ).toEqual(beforeViewRows);
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1")
          .get("notification_preferences"),
      ).toEqual({ name: "notification_preferences" });
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante una tabla legacy de Notifications y permite reintentar", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec("CREATE TABLE notification_preferences (legacy_id TEXT NOT NULL)");
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const beforeRows = db.query("SELECT * FROM notification_preferences").all();

      expect(() => migrate(db)).toThrow(
        /notification_preferences exists without its migration marker/i,
      );
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(db.query("SELECT * FROM notification_preferences").all()).toEqual(beforeRows);

      db.exec("DROP TABLE notification_preferences");
      migrate(db);
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante blockers TEMP de Notifications sin escribir y permite reintentar", () => {
    for (const blocker of ["table", "view"]) {
      const db = databaseWithMigrationsThrough(31);
      try {
        bootstrap(db);
        const create =
          blocker === "table"
            ? "CREATE TEMP TABLE notification_preferences (legacy_id TEXT NOT NULL)"
            : "CREATE TEMP VIEW notification_preferences AS SELECT id, name FROM actors";
        db.exec(create);
        const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
        const beforeTempSchema = db
          .query(
            "SELECT type, name, tbl_name, sql FROM sqlite_temp_master WHERE lower(name) = lower(?1)",
          )
          .all("notification_preferences");

        expect(() => migrate(db)).toThrow(/temporary (?:table|view).*global index\/table name/i);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
        expect(
          db
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1")
            .get("notification_preferences"),
        ).toBeNull();
        expect(
          db
            .query(
              "SELECT type, name, tbl_name, sql FROM sqlite_temp_master WHERE lower(name) = lower(?1)",
            )
            .all("notification_preferences"),
        ).toEqual(beforeTempSchema);

        expect(() => migrate(db)).toThrow(/temporary (?:table|view).*global index\/table name/i);
        db.exec(`DROP ${blocker === "table" ? "TABLE" : "VIEW"} notification_preferences`);
        migrate(db);
        expect(db.query("SELECT version FROM _migrations WHERE version = 32").get()).toEqual({
          version: 32,
        });
      } finally {
        db.close();
      }
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

  it("renombra una colisión cross-table antes de reconstruir Views", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      const beforeView = db
        .query(
          `SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
                  created_at, updated_at, columns_json, archived_at, workspace_id
           FROM saved_views WHERE id = 'view-legacy'`,
        )
        .get();
      const beforeFavorite = db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get();
      const beforeNotification = db
        .query("SELECT * FROM notification_preferences WHERE category = 'mentions'")
        .get();
      db.exec("CREATE UNIQUE INDEX idx_saved_views_project ON actors(name)");

      migrate(db);

      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('actors')
             WHERE name = 'idx_saved_views_project_legacy'`,
          )
          .get(),
      ).toEqual({ name: "idx_saved_views_project_legacy", unique_value: 1 });
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('saved_views')
             WHERE name = 'idx_saved_views_project'`,
          )
          .get(),
      ).toEqual({ name: "idx_saved_views_project", unique_value: 0 });
      expect(
        db
          .query(
            `SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
                    created_at, updated_at, columns_json, archived_at, workspace_id
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
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const migrationCount = db.query("SELECT count(*) AS count FROM _migrations").get();
      migrate(db);
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(migrationCount);
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'idx_saved_views_project%'",
          )
          .get(),
      ).toEqual({ count: 2 });
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

  it("reconcilia el marker legacy y renombra el índice de Notifications de forma idempotente", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      db.exec(
        'CREATE UNIQUE INDEX "IDX_NOTIFICATION_PREFERENCES_ACTOR_WORKSPACE" ON "actors"(name COLLATE NOCASE) WHERE name <> \'ignored\'',
      );
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

      migrate(db);

      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value, partial
             FROM pragma_index_list('actors')
             WHERE lower(name) = lower(?1)`,
          )
          .get("IDX_NOTIFICATION_PREFERENCES_ACTOR_WORKSPACE_legacy"),
      ).toEqual({
        name: "IDX_NOTIFICATION_PREFERENCES_ACTOR_WORKSPACE_legacy",
        unique_value: 1,
        partial: 1,
      });
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
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const migrationMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      migrate(db);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(
        migrationMarkers,
      );
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
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

  it("rechaza triggers legacy corruptos antes del rebuild de 0033", () => {
    const cases: Array<{ name: string; malformed: string; repair: string }> = [
      {
        name: "saved_views_workspace_scope_insert",
        malformed: `CREATE TRIGGER saved_views_workspace_scope_insert
          AFTER INSERT ON saved_views
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
          BEGIN
            SELECT 1;
            /* AFTER INSERT ON saved_views UPDATE saved_views SET workspace_id = (SELECT id FROM workspace) */
          END`,
        repair: `CREATE TRIGGER saved_views_workspace_scope_insert
          AFTER INSERT ON saved_views
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
          BEGIN
            UPDATE saved_views SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
          END`,
      },
      {
        name: "saved_views_workspace_required_insert",
        malformed: `CREATE TRIGGER saved_views_workspace_required_insert
          BEFORE INSERT ON saved_views
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
          BEGIN
            SELECT 'SELECT RAISE(ABORT, ''Workspace context is required for saved_views'')';
          END`,
        repair: `CREATE TRIGGER saved_views_workspace_required_insert
          BEFORE INSERT ON saved_views
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
          BEGIN
            SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
          END`,
      },
      {
        name: "saved_views_workspace_required_update",
        malformed: `CREATE TRIGGER saved_views_workspace_required_update
          BEFORE UPDATE OF workspace_id ON saved_views
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
          BEGIN
            SELECT 1;
            /* SELECT RAISE(ABORT, 'Workspace context is required for saved_views') */
          END`,
        repair: `CREATE TRIGGER saved_views_workspace_required_update
          BEFORE UPDATE OF workspace_id ON saved_views
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
          BEGIN
            SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
          END`,
      },
    ];

    for (const testCase of cases) {
      const db = databaseWithMigrationsThrough(32);
      try {
        bootstrap(db);
        replaceSavedViewsTrigger(db, testCase.name, testCase.malformed);
        const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
        const beforeSchema = db
          .query(
            `SELECT type, name, tbl_name, sql FROM sqlite_master
             WHERE tbl_name = 'saved_views'
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
        expect(firstError).toContain(testCase.name);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
        expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();
        expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
        expect(
          db
            .query(
              `SELECT type, name, tbl_name, sql FROM sqlite_master
               WHERE tbl_name = 'saved_views'
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

  it("acepta nombres de trigger sin distinguir mayúsculas en el preflight legacy", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      bootstrap(db);
      replaceSavedViewsTrigger(
        db,
        "saved_views_workspace_scope_insert",
        `CREATE TRIGGER "SAVED_VIEWS_WORKSPACE_SCOPE_INSERT"
          AFTER INSERT ON "SAVED_VIEWS"
          WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
          BEGIN
            UPDATE saved_views SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
          END`,
      );
      migrate(db);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
    } finally {
      db.close();
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

  it("renombra un índice global cross-table y conserva unicidad e idempotencia", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(
        'CREATE UNIQUE INDEX "IDX_VIEW_PREFERENCES_VIEW" ON "actors"(name COLLATE NOCASE) WHERE name <> \'ignored\'',
      );
      const beforeDefinition = db
        .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND lower(name) = lower(?1)")
        .get("idx_view_preferences_view");

      migrate(db);

      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value, partial
             FROM pragma_index_list('actors')
             WHERE name = 'IDX_VIEW_PREFERENCES_VIEW_legacy'`,
          )
          .get(),
      ).toEqual({
        name: "IDX_VIEW_PREFERENCES_VIEW_legacy",
        unique_value: 1,
        partial: 1,
      });
      expect(
        db
          .query("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?1")
          .get("IDX_VIEW_PREFERENCES_VIEW_legacy"),
      ).toEqual({ tbl_name: "actors" });
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('view_preferences')
             WHERE name = 'idx_view_preferences_view'`,
          )
          .get(),
      ).toEqual({ name: "idx_view_preferences_view", unique_value: 0 });
      expect(
        db
          .query(
            `SELECT name, coll, desc, key
             FROM pragma_index_xinfo('IDX_VIEW_PREFERENCES_VIEW_legacy')
             WHERE key = 1`,
          )
          .all(),
      ).toEqual([{ name: "name", coll: "NOCASE", desc: 0, key: 1 }]);
      expect(
        db
          .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1")
          .get("IDX_VIEW_PREFERENCES_VIEW_legacy"),
      ).toEqual({
        sql: `CREATE UNIQUE INDEX "IDX_VIEW_PREFERENCES_VIEW_legacy" ON "actors"(name COLLATE NOCASE) WHERE name <> 'ignored'`,
      });
      expect(beforeDefinition).toEqual({
        sql: `CREATE UNIQUE INDEX "IDX_VIEW_PREFERENCES_VIEW" ON "actors"(name COLLATE NOCASE) WHERE name <> 'ignored'`,
      });
      expect(() =>
        db
          .query(
            `INSERT INTO actors (id, name, type, created_at, updated_at)
             VALUES ('actor-duplicate-name', 'ADMIN', 'human', '2026-01-01', '2026-01-01')`,
          )
          .run(),
      ).toThrow();

      const migrationMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      migrate(db);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(
        migrationMarkers,
      );
      expect(
        db
          .query(
            `SELECT type, name, tbl_name
             FROM sqlite_master
             WHERE name IN ('idx_view_preferences_view', 'IDX_VIEW_PREFERENCES_VIEW_legacy')
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual([
        { type: "index", name: "IDX_VIEW_PREFERENCES_VIEW_legacy", tbl_name: "actors" },
        { type: "index", name: "idx_view_preferences_view", tbl_name: "view_preferences" },
      ]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("usa el siguiente sufijo libre de forma determinista", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(
        "CREATE INDEX idx_view_preferences_view_legacy ON actors(name); CREATE INDEX idx_view_preferences_view ON actors(id)",
      );

      migrate(db);

      expect(
        db
          .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_view_preferences_view_legacy%' ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "idx_view_preferences_view_legacy", tbl_name: "actors" },
        { name: "idx_view_preferences_view_legacy_2", tbl_name: "actors" },
      ]);
      const migrationMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      migrate(db);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(
        migrationMarkers,
      );
    } finally {
      db.close();
    }
  });

  it("renombra un trigger global cross-table y conserva WHEN, cuerpo e idempotencia", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        DROP TRIGGER saved_views_workspace_scope_insert;
        CREATE TABLE legacy_trigger_log (team_id TEXT NOT NULL, marker TEXT NOT NULL);
        CREATE TRIGGER saved_views_workspace_scope_insert
        AFTER INSERT ON teams
        WHEN NEW.name LIKE 'legacy%'
        BEGIN
          INSERT INTO legacy_trigger_log (team_id, marker) VALUES (NEW.id, 'inserted');
          UPDATE teams SET description = 'triggered' WHERE id = NEW.id;
        END;
      `);
      const beforeDefinition = db
        .query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1")
        .get("saved_views_workspace_scope_insert");

      migrate(db);

      expect(
        db
          .query(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE type = 'trigger' AND name = 'saved_views_workspace_scope_insert_legacy'`,
          )
          .get(),
      ).toEqual({
        type: "trigger",
        name: "saved_views_workspace_scope_insert_legacy",
        tbl_name: "teams",
        sql: `CREATE TRIGGER "saved_views_workspace_scope_insert_legacy"
        AFTER INSERT ON teams
        WHEN NEW.name LIKE 'legacy%'
        BEGIN
          INSERT INTO legacy_trigger_log (team_id, marker) VALUES (NEW.id, 'inserted');
          UPDATE teams SET description = 'triggered' WHERE id = NEW.id;
        END`,
      });
      expect(beforeDefinition).toEqual({
        sql: `CREATE TRIGGER saved_views_workspace_scope_insert
        AFTER INSERT ON teams
        WHEN NEW.name LIKE 'legacy%'
        BEGIN
          INSERT INTO legacy_trigger_log (team_id, marker) VALUES (NEW.id, 'inserted');
          UPDATE teams SET description = 'triggered' WHERE id = NEW.id;
        END`,
      });
      expect(
        db
          .query(
            `SELECT type, name, tbl_name
             FROM sqlite_master
             WHERE type = 'trigger' AND name = 'saved_views_workspace_scope_insert'`,
          )
          .get(),
      ).toEqual({
        type: "trigger",
        name: "saved_views_workspace_scope_insert",
        tbl_name: "saved_views",
      });

      const workspaceValue = db.query("SELECT id FROM workspace LIMIT 1").values()[0]?.[0];
      if (typeof workspaceValue !== "string") throw new Error("Missing fixture Workspace");
      db.query(
        `INSERT INTO teams
          (id, workspace_id, name, key, description, created_at, updated_at)
         VALUES ('legacy-trigger-team', ?1, 'legacy trigger team', 'TRG', NULL,
                 '2026-01-01', '2026-01-01')`,
      ).run(workspaceValue);
      expect(
        db.query("SELECT * FROM legacy_trigger_log WHERE team_id = 'legacy-trigger-team'").all(),
      ).toEqual([{ team_id: "legacy-trigger-team", marker: "inserted" }]);
      expect(
        db.query("SELECT description FROM teams WHERE id = 'legacy-trigger-team'").get(),
      ).toEqual({ description: "triggered" });

      db.query(
        `INSERT INTO teams
          (id, workspace_id, name, key, description, created_at, updated_at)
         VALUES ('ordinary-trigger-team', ?1, 'ordinary trigger team', 'TRG2', NULL,
                 '2026-01-01', '2026-01-01')`,
      ).run(workspaceValue);
      expect(
        db.query("SELECT * FROM legacy_trigger_log WHERE team_id = 'ordinary-trigger-team'").all(),
      ).toEqual([]);
      expect(
        db.query("SELECT description FROM teams WHERE id = 'ordinary-trigger-team'").get(),
      ).toEqual({ description: null });

      const migrationMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      migrate(db);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(
        migrationMarkers,
      );
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'saved_views_workspace_scope_insert%'",
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(
        db
          .query(
            "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'saved_views_workspace_scope_insert_legacy_2'",
          )
          .get(),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("resuelve una colisión de índice al reconciliar el marker legacy 0032", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      db.exec("DROP INDEX idx_saved_views_workspace_id");
      db.exec("CREATE UNIQUE INDEX idx_saved_views_workspace_id ON actors(name)");
      const beforeView = db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get();

      migrate(db);

      expect(db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get()).toEqual(
        beforeView,
      );
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('actors')
             WHERE name = 'idx_saved_views_workspace_id_legacy'`,
          )
          .get(),
      ).toEqual({ name: "idx_saved_views_workspace_id_legacy", unique_value: 1 });
      expect(
        db
          .query(
            `SELECT name, "unique" AS unique_value
             FROM pragma_index_list('saved_views')
             WHERE name = 'idx_saved_views_workspace_id'`,
          )
          .get(),
      ).toEqual({ name: "idx_saved_views_workspace_id", unique_value: 1 });
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);

      const migrationMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      migrate(db);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(
        migrationMarkers,
      );
      expect(
        db
          .query(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_saved_views_workspace_id_legacy_2'",
          )
          .get(),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("revierte el renombre cross-table si falla la validación posterior del DDL", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec("CREATE UNIQUE INDEX idx_view_preferences_view ON actors(name)");
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(`
        INSERT INTO favorites
          (id, actor_id, project_id, saved_view_id, position, created_at, workspace_id)
        SELECT 'broken-favorite', actors.id, NULL, 'missing-view', 0, '2026-01-01', workspace.id
          FROM workspace
          JOIN actors
         LIMIT 1;
      `);
      db.exec("PRAGMA foreign_keys = ON");
      const beforeFavorite = db.query("SELECT * FROM favorites WHERE id = 'broken-favorite'").get();
      const beforeSchema = db
        .query(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name IN ('idx_view_preferences_view', 'idx_view_preferences_view_legacy',
                          'view_preferences', 'view_subscriptions', '_prb390_saved_views')
           ORDER BY type, name`,
        )
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      expect(runMigration).toThrow(/foreign.?key|incompatible/i);
      expect(db.query("SELECT * FROM favorites WHERE id = 'broken-favorite'").get()).toEqual(
        beforeFavorite,
      );
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db
          .query(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE name IN ('idx_view_preferences_view', 'idx_view_preferences_view_legacy',
                            'view_preferences', 'view_subscriptions', '_prb390_saved_views')
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual(beforeSchema);
      expect(
        db
          .query(
            "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_view_preferences_view'",
          )
          .get(),
      ).toEqual({ tbl_name: "actors" });
      expect(
        db
          .query(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_view_preferences_view_legacy'",
          )
          .get(),
      ).toBeNull();

      expect(runMigration).toThrow(/foreign.?key|incompatible/i);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db
          .query(
            "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_view_preferences_view'",
          )
          .get(),
      ).toEqual({ tbl_name: "actors" });

      db.query("DELETE FROM favorites WHERE id = 'broken-favorite'").run();
      migrate(db);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(
        db
          .query(
            "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_view_preferences_view_legacy'",
          )
          .get(),
      ).toEqual({ tbl_name: "actors" });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("renombra índices ajenos que bloquean tablas temporales o finales de Views", () => {
    for (const reservedName of ["_prb390_saved_views", "view_preferences", "view_subscriptions"]) {
      const db = databaseWithMigrationsThrough(32);
      try {
        seedLegacyNotificationAndViewData(db);
        db.exec(`CREATE UNIQUE INDEX ${reservedName} ON actors(name)`);

        migrate(db);

        expect(
          db
            .query(
              "SELECT tbl_name, \"unique\" AS unique_value FROM sqlite_master JOIN pragma_index_list('actors') ON pragma_index_list.name = sqlite_master.name WHERE sqlite_master.type = 'index' AND sqlite_master.name = ?1",
            )
            .get(`${reservedName}_legacy`),
        ).toEqual({ tbl_name: "actors", unique_value: 1 });
        expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
          version: 33,
        });
        expect(
          db
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1")
            .get(reservedName === "_prb390_saved_views" ? "saved_views" : reservedName),
        ).toEqual({ name: reservedName === "_prb390_saved_views" ? "saved_views" : reservedName });
        expect(
          db
            .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1")
            .get(`${reservedName}_legacy_2`),
        ).toBeNull();
      } finally {
        db.close();
      }
    }
  });

  it("falla cerrado ante una tabla que ocupa un nombre global reservado", () => {
    for (const reservedName of [
      "idx_view_preferences_view",
      "view_preferences",
      "_prb390_saved_views",
    ]) {
      const db = databaseWithMigrationsThrough(32);
      try {
        seedLegacyNotificationAndViewData(db);
        db.exec(`CREATE TABLE "${reservedName}" (id TEXT)`);
        const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
        const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
        const beforeSchema = db
          .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
          .all();
        const runMigration = () => migrate(db);

        expect(runMigration).toThrow(/(?:global index\/table name|partially applied)/i);
        expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
        expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
        expect(
          db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
        ).toEqual(beforeSchema);
        expect(runMigration).toThrow(/(?:global index\/table name|partially applied)/i);
      } finally {
        db.close();
      }
    }
  });

  it("renombra una View legacy que bloquea una tabla final y conserva su consulta", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec('CREATE VIEW "VIEW_PREFERENCES" AS SELECT id, name FROM "actors"');

      migrate(db);

      expect(
        db
          .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'view' AND lower(name) = lower(?1)",
          )
          .get("view_preferences_legacy"),
      ).toEqual({ name: "VIEW_PREFERENCES_legacy", tbl_name: "VIEW_PREFERENCES_legacy" });
      expect(db.query("SELECT id, name FROM VIEW_PREFERENCES_legacy ORDER BY id").all()).toEqual(
        db.query("SELECT id, name FROM actors ORDER BY id").all(),
      );
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'view_preferences'",
          )
          .get(),
      ).toEqual({ name: "view_preferences" });
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
    } finally {
      db.close();
    }
  });

  it("falla cerrado si una View bloqueadora tiene dependencias preservables desconocidas", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE VIEW view_preferences AS SELECT id, name FROM actors;
        CREATE VIEW view_preferences_dependent AS SELECT id FROM view_preferences;
      `);
      const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeSchema = db
        .query(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name IN ('view_preferences', 'view_preferences_dependent',
                          'view_preferences_legacy', 'view_subscriptions', '_prb390_saved_views')
           ORDER BY type, name`,
        )
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();

      expect(() => migrate(db)).toThrow(/view view_preferences.*dependent schema objects/i);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db
          .query(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE name IN ('view_preferences', 'view_preferences_dependent',
                            'view_preferences_legacy', 'view_subscriptions', '_prb390_saved_views')
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual(beforeSchema);
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'view_preferences'",
          )
          .get(),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante un TEMP trigger en saved_views y permite reintentar", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE TEMP TRIGGER saved_views_workspace_scope_insert
        AFTER INSERT ON saved_views
        BEGIN
          SELECT 1;
        END;
      `);
      const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeTempSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      expect(runMigration).toThrow(/temporary trigger .*would be lost/i);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
      expect(
        db
          .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
          .all(),
      ).toEqual(beforeTempSchema);

      expect(runMigration).toThrow(/temporary trigger .*would be lost/i);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

      db.exec("DROP TRIGGER saved_views_workspace_scope_insert");
      migrate(db);

      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(
        db
          .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND lower(name) = lower(?1)",
          )
          .get("saved_views_workspace_scope_insert"),
      ).toEqual({ name: "saved_views_workspace_scope_insert", tbl_name: "saved_views" });
      expect(
        db
          .query("SELECT 1 FROM sqlite_temp_master WHERE type = 'trigger' AND name = ?1")
          .get("saved_views_workspace_scope_insert"),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("conserva un TEMP trigger sobre una tabla ajena durante el rebuild", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE TEMP TABLE temp_trigger_log (value TEXT NOT NULL);
        CREATE TEMP TRIGGER saved_views_workspace_scope_insert
        AFTER UPDATE OF name ON actors
        BEGIN
          INSERT INTO temp_trigger_log(value) VALUES (NEW.name);
        END;
      `);

      migrate(db);

      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(
        db
          .query("SELECT type, name, tbl_name FROM sqlite_temp_master WHERE type = 'trigger'")
          .get(),
      ).toEqual({
        type: "trigger",
        name: "saved_views_workspace_scope_insert",
        tbl_name: "actors",
      });

      db.query("UPDATE actors SET name = 'admin-after-temp-trigger' WHERE name = 'admin'").run();
      expect(db.query("SELECT value FROM temp_trigger_log").all()).toEqual([
        { value: "admin-after-temp-trigger" },
      ]);
      migrate(db);
      expect(
        db
          .query("SELECT 1 FROM sqlite_temp_master WHERE type = 'trigger' AND name = ?1")
          .get("saved_views_workspace_scope_insert"),
      ).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante una TEMP VIEW dependiente y permite reintentar de forma determinista", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE VIEW view_preferences AS SELECT id, name FROM actors;
        CREATE TEMP VIEW temp_view_preferences_dependent AS
          SELECT id, name FROM view_preferences;
      `);
      const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeTempSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
        .all();
      const beforeTempRows = db
        .query("SELECT id, name FROM temp_view_preferences_dependent ORDER BY id")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      expect(runMigration).toThrow(/view view_preferences.*dependent schema objects/i);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
      expect(
        db
          .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
          .all(),
      ).toEqual(beforeTempSchema);
      expect(
        db.query("SELECT id, name FROM temp_view_preferences_dependent ORDER BY id").all(),
      ).toEqual(beforeTempRows);

      expect(runMigration).toThrow(/view view_preferences.*dependent schema objects/i);
      expect(
        db.query("SELECT id, name FROM temp_view_preferences_dependent ORDER BY id").all(),
      ).toEqual(beforeTempRows);

      db.exec("DROP VIEW temp_view_preferences_dependent");
      migrate(db);

      expect(
        db
          .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'view' AND lower(name) = lower(?1)",
          )
          .get("view_preferences_legacy"),
      ).toEqual({ name: "view_preferences_legacy", tbl_name: "view_preferences_legacy" });
      expect(db.query("SELECT id, name FROM view_preferences_legacy ORDER BY id").all()).toEqual(
        db.query("SELECT id, name FROM actors ORDER BY id").all(),
      );
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante una TEMP VIEW que ocupa un nombre reservado y permite repararlo", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec("CREATE TEMP VIEW view_preferences AS SELECT id, name FROM actors");
      const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeTempSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
        .all();
      const beforeTempRows = db.query("SELECT id, name FROM view_preferences ORDER BY id").all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      expect(runMigration).toThrow(/temporary view view_preferences.*global index\/table name/i);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
      expect(
        db
          .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
          .all(),
      ).toEqual(beforeTempSchema);
      expect(db.query("SELECT id, name FROM view_preferences ORDER BY id").all()).toEqual(
        beforeTempRows,
      );

      expect(runMigration).toThrow(/temporary view view_preferences.*global index\/table name/i);
      expect(db.query("SELECT id, name FROM view_preferences ORDER BY id").all()).toEqual(
        beforeTempRows,
      );

      db.exec("DROP VIEW view_preferences");
      migrate(db);

      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?1)")
          .get("view_preferences"),
      ).toEqual({ name: "view_preferences" });
      expect(
        db.query("SELECT 1 FROM sqlite_temp_master WHERE name = 'view_preferences'").get(),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("protege INDEXED BY dentro de fuentes parentizadas y JOIN", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_view ON actors(name);
        CREATE VIEW dependent_actor_parenthesized AS
          SELECT id FROM (actors INDEXED BY idx_view_preferences_view);
        CREATE VIEW dependent_actor_parenthesized_join AS
          SELECT a.id
            FROM (actors INDEXED BY idx_view_preferences_view) AS a
            JOIN actors AS other ON other.id = a.id;
        CREATE VIEW dependent_actor_parenthesized_nested AS
          SELECT id FROM ((actors INDEXED BY idx_view_preferences_view));
        CREATE VIEW dependent_actor_parenthesized_subquery AS
          SELECT id FROM (SELECT id FROM actors INDEXED BY idx_view_preferences_view) AS source;
        CREATE VIEW dependent_actor_parenthesized_join_inside AS
          SELECT first.id
            FROM (actors AS first INDEXED BY idx_view_preferences_view
              JOIN actors AS other INDEXED BY idx_view_preferences_view
                ON other.id = first.id);
        CREATE VIEW dependent_actor_parenthesized_alias AS
          SELECT id FROM (actors AS source INDEXED BY idx_view_preferences_view);
      `);

      migrate(db);

      for (const view of [
        "dependent_actor_parenthesized",
        "dependent_actor_parenthesized_join",
        "dependent_actor_parenthesized_nested",
        "dependent_actor_parenthesized_subquery",
        "dependent_actor_parenthesized_alias",
      ]) {
        expect(db.query(`SELECT id FROM ${view}`).all()).toEqual(
          db.query("SELECT id FROM actors ORDER BY id").all(),
        );
      }
      expect(db.query("SELECT id FROM dependent_actor_parenthesized_join_inside").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_actor_parenthesized_join_inside'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_actor_parenthesized_join_inside AS
          SELECT first.id
            FROM (actors AS first INDEXED BY "idx_view_preferences_view_legacy"
              JOIN actors AS other INDEXED BY "idx_view_preferences_view_legacy"
                ON other.id = first.id)`,
      });
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_actor_parenthesized_join'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_actor_parenthesized_join AS
          SELECT a.id
            FROM (actors INDEXED BY "idx_view_preferences_view_legacy") AS a
            JOIN actors AS other ON other.id = a.id`,
      });
    } finally {
      db.close();
    }
  });

  it("resuelve INDEXED BY solo en fuentes de tabla con nombres keyword", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec(`
        CREATE TABLE window (id TEXT PRIMARY KEY);
        CREATE TABLE full (id TEXT PRIMARY KEY);
        CREATE TABLE natural (id TEXT PRIMARY KEY);
        CREATE TABLE left (id TEXT PRIMARY KEY);
        CREATE TABLE inner (id TEXT PRIMARY KEY);
        CREATE TABLE outer (id TEXT PRIMARY KEY);
        CREATE TABLE cross (id TEXT PRIMARY KEY);
        CREATE TABLE offset (id TEXT PRIMARY KEY);
        INSERT INTO window (id) VALUES ('window-row');
        INSERT INTO full (id) VALUES ('full-row');
        INSERT INTO natural (id) VALUES ('natural-row');
        INSERT INTO left (id) VALUES ('left-row');
        INSERT INTO inner (id) VALUES ('inner-row');
        INSERT INTO outer (id) VALUES ('outer-row');
        INSERT INTO cross (id) VALUES ('cross-row');
        INSERT INTO offset (id) VALUES ('offset-row');
        CREATE INDEX idx_notification_preferences_actor_workspace ON window(id);
        CREATE INDEX idx_view_preferences_key ON full(id);
        CREATE INDEX idx_view_preferences_view ON natural(id);
        CREATE INDEX idx_view_preferences_actor ON left(id);
        CREATE INDEX idx_view_subscriptions_view ON inner(id);
        CREATE INDEX idx_view_subscriptions_actor ON outer(id);
        CREATE INDEX idx_saved_views_project ON cross(id);
        CREATE INDEX idx_saved_views_initiative ON offset(id);
        CREATE VIEW dep_window AS SELECT id FROM main.window INDEXED BY idx_notification_preferences_actor_workspace;
        CREATE VIEW dep_full AS SELECT id FROM full INDEXED BY idx_view_preferences_key;
        CREATE VIEW dep_natural AS SELECT id FROM natural INDEXED BY idx_view_preferences_view;
        CREATE VIEW dep_left AS SELECT id FROM left INDEXED BY idx_view_preferences_actor;
        CREATE VIEW dep_inner AS SELECT id FROM inner INDEXED BY idx_view_subscriptions_view;
        CREATE VIEW dep_outer AS SELECT id FROM outer INDEXED BY idx_view_subscriptions_actor;
        CREATE VIEW dep_cross AS SELECT id FROM cross INDEXED BY idx_saved_views_project;
        CREATE VIEW dep_offset AS SELECT id FROM offset INDEXED BY idx_saved_views_initiative;
      `);

      migrate(db);

      for (const [view, id] of [
        ["dep_window", "window-row"],
        ["dep_full", "full-row"],
        ["dep_natural", "natural-row"],
        ["dep_left", "left-row"],
        ["dep_inner", "inner-row"],
        ["dep_outer", "outer-row"],
        ["dep_cross", "cross-row"],
        ["dep_offset", "offset-row"],
      ]) {
        expect(db.query(`SELECT id FROM ${view}`).all()).toEqual([{ id }]);
      }
    } finally {
      db.close();
    }
  });

  it("resuelve nombres keyword y modificadores UPDATE en INDEXED BY", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec(`
        CREATE TABLE abort (id TEXT PRIMARY KEY);
        CREATE TABLE fail (id TEXT PRIMARY KEY);
        CREATE TABLE ignore (id TEXT PRIMARY KEY);
        CREATE TABLE replace (id TEXT PRIMARY KEY);
        CREATE TABLE rollback (id TEXT PRIMARY KEY);
        INSERT INTO abort (id) VALUES ('abort-row');
        INSERT INTO fail (id) VALUES ('fail-row');
        INSERT INTO ignore (id) VALUES ('ignore-row');
        INSERT INTO replace (id) VALUES ('replace-row');
        INSERT INTO rollback (id) VALUES ('rollback-row');
        CREATE INDEX idx_view_preferences_view ON abort(id);
        CREATE INDEX idx_view_preferences_key ON fail(id);
        CREATE INDEX idx_view_preferences_actor ON ignore(id);
        CREATE INDEX idx_view_subscriptions_view ON replace(id);
        CREATE INDEX idx_view_subscriptions_actor ON rollback(id);
        CREATE VIEW dependent_abort AS
          SELECT id FROM abort INDEXED BY idx_view_preferences_view;
        CREATE VIEW dependent_fail AS
          SELECT id FROM fail AS source INDEXED BY idx_view_preferences_key;
        CREATE VIEW dependent_ignore AS
          SELECT id FROM ignore INDEXED BY idx_view_preferences_actor;
        CREATE VIEW dependent_replace AS
          SELECT id FROM replace AS source INDEXED BY idx_view_subscriptions_view;
        CREATE VIEW dependent_rollback AS
          SELECT id FROM rollback INDEXED BY idx_view_subscriptions_actor;
        CREATE TRIGGER dependent_update_keyword AFTER INSERT ON actors
        BEGIN
          UPDATE OR ABORT actors SET name = name WHERE id = NEW.id;
          SELECT id FROM abort INDEXED BY idx_view_preferences_view WHERE id = 'abort-row';
        END;
      `);

      migrate(db);

      for (const { view, id } of [
        { view: "dependent_abort", id: "abort-row" },
        { view: "dependent_fail", id: "fail-row" },
        { view: "dependent_ignore", id: "ignore-row" },
        { view: "dependent_replace", id: "replace-row" },
        { view: "dependent_rollback", id: "rollback-row" },
      ]) {
        expect(db.query(`SELECT id FROM ${view}`).all()).toEqual([{ id }]);
      }
      db.query(
        `INSERT INTO actors (id, name, type, created_at, updated_at)
         VALUES ('keyword-trigger-actor', 'keyword-trigger', 'human', '2026-01-01', '2026-01-01')`,
      ).run();
      expect(db.query("SELECT name FROM actors WHERE id = 'keyword-trigger-actor'").get()).toEqual({
        name: "keyword-trigger",
      });
    } finally {
      db.close();
    }
  });

  it("resuelve WITH como identificador de tabla o alias", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec(`
        CREATE TABLE with (id TEXT PRIMARY KEY);
        INSERT INTO with (id) VALUES ('with-row');
        CREATE INDEX idx_notification_preferences_actor_workspace ON with(id);
        CREATE VIEW dependent_with_table AS
          SELECT id FROM with INDEXED BY idx_notification_preferences_actor_workspace;
        CREATE VIEW dependent_with_alias AS
          SELECT id FROM with AS with INDEXED BY idx_notification_preferences_actor_workspace;
        CREATE VIEW dependent_with_cte AS
          WITH with AS (SELECT 'cte-row' AS id)
          SELECT id FROM with;
        CREATE VIEW dependent_with_recursive_cte AS
          WITH RECURSIVE with(id) AS (SELECT 'recursive-row' AS id)
          SELECT id FROM with;
        CREATE VIEW dependent_with_cte_list AS
          WITH helper AS (SELECT 'helper-row' AS id),
            with AS (SELECT 'list-row' AS id)
          SELECT id FROM with;
        CREATE VIEW dependent_with_column_name (with) AS
          SELECT id FROM with INDEXED BY idx_notification_preferences_actor_workspace;
        CREATE TABLE with_column (id TEXT PRIMARY KEY, with TEXT);
        INSERT INTO with_column (id, with) VALUES ('column-row', 'column-value');
        CREATE INDEX idx_view_preferences_key ON with_column(id);
        CREATE VIEW dependent_with_column AS
          SELECT with FROM with_column INDEXED BY idx_view_preferences_key;
        CREATE VIEW dependent_with_nested_cte AS
          SELECT id FROM with_column INDEXED BY idx_view_preferences_key
          WHERE id IN (
            WITH with AS (SELECT 'column-row' AS id)
            SELECT id FROM with
          );
        CREATE TRIGGER dependent_with_update AFTER INSERT ON actors
        BEGIN
          UPDATE OR ABORT with SET id = id WHERE id = 'with-row';
          SELECT id FROM with INDEXED BY idx_notification_preferences_actor_workspace;
        END;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_with_table").all()).toEqual([{ id: "with-row" }]);
      expect(db.query("SELECT id FROM dependent_with_alias").all()).toEqual([{ id: "with-row" }]);
      expect(db.query("SELECT id FROM dependent_with_cte").all()).toEqual([{ id: "cte-row" }]);
      expect(db.query("SELECT id FROM dependent_with_recursive_cte").all()).toEqual([
        { id: "recursive-row" },
      ]);
      expect(db.query("SELECT id FROM dependent_with_cte_list").all()).toEqual([
        { id: "list-row" },
      ]);
      expect(db.query("SELECT with FROM dependent_with_column_name").all()).toEqual([
        { with: "with-row" },
      ]);
      expect(db.query("SELECT with FROM dependent_with_column").all()).toEqual([
        { with: "column-value" },
      ]);
      expect(db.query("SELECT id FROM dependent_with_nested_cte").all()).toEqual([
        { id: "column-row" },
      ]);
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'dependent_with_update'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE TRIGGER dependent_with_update AFTER INSERT ON actors
        BEGIN
          UPDATE OR ABORT with SET id = id WHERE id = 'with-row';
          SELECT id FROM with INDEXED BY "idx_notification_preferences_actor_workspace_legacy";
        END`,
      });
      db.query(
        `INSERT INTO actors (id, name, type, created_at, updated_at)
         VALUES ('with-trigger-actor', 'with-trigger', 'human', '2026-01-01', '2026-01-01')`,
      ).run();
      expect(db.query("SELECT id FROM with").all()).toEqual([{ id: "with-row" }]);
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante INDEXED BY sobre una CTE sombreada y permite reparar", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_view ON actors(name);
        CREATE VIEW dependent_cte AS
          WITH actors AS (SELECT 'cte-row' AS id)
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
        CREATE VIEW dependent_cte_keyword AS
          WITH with AS (SELECT 'cte-row' AS id)
          SELECT id FROM with INDEXED BY idx_view_preferences_view;
        CREATE VIEW dependent_nested_cte AS
          SELECT id FROM actors INDEXED BY idx_view_preferences_view
          WHERE id IN (
            WITH actors AS (SELECT 'cte-row' AS id)
            SELECT id FROM actors
          );
        CREATE VIEW dependent_nested_cte_real AS
          WITH helper AS (
            SELECT id FROM actors INDEXED BY idx_view_preferences_view
          )
          SELECT id FROM actors INDEXED BY idx_view_preferences_view
          WHERE id IN (SELECT id FROM helper);
      `);

      expect(() => migrate(db)).toThrow(/CTE/i);
      expect(db.query("SELECT version FROM _migrations WHERE version = 32").get()).toBeNull();
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1")
          .get("idx_view_preferences_view"),
      ).toEqual({ name: "idx_view_preferences_view" });
      expect(
        db
          .query("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_cte'")
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_cte AS
          WITH actors AS (SELECT 'cte-row' AS id)
          SELECT id FROM actors INDEXED BY idx_view_preferences_view`,
      });

      db.exec("DROP VIEW dependent_cte");
      expect(() => migrate(db)).toThrow(/CTE/i);
      db.exec("DROP VIEW dependent_cte_keyword");
      db.exec(`
        CREATE VIEW dependent_cte AS
          WITH helper AS (SELECT 'cte-row' AS id)
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
      `);
      migrate(db);
      expect(db.query("SELECT id FROM dependent_cte").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(db.query("SELECT id FROM dependent_nested_cte").all()).toEqual([]);
      expect(db.query("SELECT id FROM dependent_nested_cte_real").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_nested_cte_real'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_nested_cte_real AS
          WITH helper AS (
            SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy"
          )
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy"
          WHERE id IN (SELECT id FROM helper)`,
      });
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante una CTE sombreada en un Trigger INDEXED BY", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_view ON actors(name);
        CREATE TRIGGER dependent_cte_trigger AFTER INSERT ON actors
        BEGIN
          WITH actors AS (SELECT NEW.id AS id)
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
        END;
      `);

      expect(() => migrate(db)).toThrow(/CTE/i);
      expect(db.query("SELECT version FROM _migrations WHERE version = 32").get()).toBeNull();
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?1")
          .get("dependent_cte_trigger"),
      ).toEqual({ name: "dependent_cte_trigger" });

      db.exec("DROP TRIGGER dependent_cte_trigger");
      migrate(db);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
    } finally {
      db.close();
    }
  });

  it("protege dependencias INDEXED BY durante el renombre de índices de 0032", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_notification_preferences_actor_workspace ON actors(name);
        CREATE VIEW dependent_notification_actor AS
          SELECT id FROM actors INDEXED BY idx_notification_preferences_actor_workspace;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_notification_actor").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_notification_actor'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_notification_actor AS
          SELECT id FROM actors INDEXED BY "idx_notification_preferences_actor_workspace_legacy"`,
      });
    } finally {
      db.close();
    }
  });

  it("protege INDEXED BY durante el reconcile del marker 0032 legacy", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_notification_preferences_actor_workspace ON actors(name);
        CREATE VIEW dependent_notification_reconcile AS
          SELECT id FROM actors INDEXED BY idx_notification_preferences_actor_workspace;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_notification_reconcile").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_notification_reconcile'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_notification_reconcile AS
          SELECT id FROM actors INDEXED BY "idx_notification_preferences_actor_workspace_legacy"`,
      });
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      const schema = db
        .query(
          "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_notification_reconcile'",
        )
        .get();
      migrate(db);
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_notification_reconcile'",
          )
          .get(),
      ).toEqual(schema);
    } finally {
      db.close();
    }
  });

  it("resuelve una colisión cross-table en una instalación fresh", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec('CREATE UNIQUE INDEX "IDX_VIEW_PREFERENCES_VIEW" ON actors(name)');

      migrate(db);

      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      expect(
        db
          .query("SELECT tbl_name FROM sqlite_master WHERE lower(name) = lower(?1)")
          .get("idx_view_preferences_view_legacy"),
      ).toEqual({ tbl_name: "actors" });
      expect(
        db
          .query("SELECT tbl_name FROM sqlite_master WHERE name = 'idx_view_preferences_view'")
          .get(),
      ).toEqual({ tbl_name: "view_preferences" });
    } finally {
      db.close();
    }
  });

  it("resuelve una View bloqueadora en una instalación fresh", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec('CREATE VIEW "VIEW_SUBSCRIPTIONS" AS SELECT id, name FROM "actors"');

      migrate(db);

      expect(
        db
          .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'view' AND lower(name) = lower(?1)",
          )
          .get("view_subscriptions_legacy"),
      ).toEqual({ name: "VIEW_SUBSCRIPTIONS_legacy", tbl_name: "VIEW_SUBSCRIPTIONS_legacy" });
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'view_subscriptions'",
          )
          .get(),
      ).toEqual({ name: "view_subscriptions" });
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante una View recursiva que no se puede renombrar solo por token", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec("CREATE VIEW view_preferences AS SELECT id, name FROM view_preferences");
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();

      expect(() => migrate(db)).toThrow(/dependent schema objects/i);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
    } finally {
      db.close();
    }
  });

  it("preserva un índice custom de la tabla fuente mientras reserva el nombre temporal", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec("CREATE UNIQUE INDEX _prb390_saved_views ON saved_views(name)");

      migrate(db);

      expect(
        db
          .query(
            "SELECT sqlite_master.type, sqlite_master.name, sqlite_master.tbl_name, indexes.\"unique\" AS unique_value FROM sqlite_master JOIN pragma_index_list('saved_views') AS indexes ON indexes.name = sqlite_master.name WHERE sqlite_master.type = 'index' AND sqlite_master.name = '_prb390_saved_views'",
          )
          .get(),
      ).toEqual({
        type: "index",
        name: "_prb390_saved_views",
        tbl_name: "saved_views",
        unique_value: 1,
      });
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name = '_prb390_saved_views_legacy'").get(),
      ).toBeNull();
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
    } finally {
      db.close();
    }
  });

  it("protege Views y Triggers main y TEMP al renombrar un índice legacy", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_view ON actors(name);
        CREATE VIEW dependent_actor_trigger_view AS
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
        CREATE TRIGGER dependent_actor_trigger
        AFTER INSERT ON actors
        BEGIN
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
        END;
        CREATE TEMP VIEW dependent_actor_temp_view AS
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
        CREATE TEMP TRIGGER dependent_actor_temp_trigger
        AFTER INSERT ON actors
        BEGIN
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
        END;
      `);

      migrate(db);

      for (const view of ["dependent_actor_trigger_view", "dependent_actor_temp_view"]) {
        expect(db.query(`SELECT id FROM ${view}`).all()).toEqual(
          db.query("SELECT id FROM actors ORDER BY id").all(),
        );
      }
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_actor_trigger_view'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_actor_trigger_view AS
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy"`,
      });
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_temp_master WHERE type = 'view' AND name = 'dependent_actor_temp_view'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_actor_temp_view AS
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy"`,
      });
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'dependent_actor_trigger'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE TRIGGER dependent_actor_trigger
        AFTER INSERT ON actors
        BEGIN
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy";
        END`,
      });
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_temp_master WHERE type = 'trigger' AND name = 'dependent_actor_temp_trigger'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE TRIGGER dependent_actor_temp_trigger
        AFTER INSERT ON actors
        BEGIN
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy";
        END`,
      });
      db.query(
        `INSERT INTO actors (id, name, type, created_at, updated_at)
         VALUES ('dependent-trigger-actor', 'dependent-trigger-actor', 'human', '2026-01-01', '2026-01-01')`,
      ).run();
      expect(db.query("SELECT 1 FROM dependent_actor_temp_view LIMIT 1").get()).toEqual({ 1: 1 });
    } finally {
      db.close();
    }
  });

  it("combina el renombre de un Trigger bloqueador con su dependencia INDEXED BY", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        DROP TRIGGER saved_views_workspace_scope_insert;
        CREATE UNIQUE INDEX idx_view_preferences_view ON actors(name);
        CREATE TRIGGER saved_views_workspace_scope_insert
        AFTER INSERT ON actors
        BEGIN
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
        END;
      `);

      migrate(db);

      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'saved_views_workspace_scope_insert_legacy'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE TRIGGER "saved_views_workspace_scope_insert_legacy"
        AFTER INSERT ON actors
        BEGIN
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy";
        END`,
      });
    } finally {
      db.close();
    }
  });

  it("combina el renombre de una View bloqueadora con su dependencia INDEXED BY", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_view ON actors(name);
        CREATE VIEW view_preferences AS
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM view_preferences_legacy").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'view_preferences_legacy'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW "view_preferences_legacy" AS
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy"`,
      });
    } finally {
      db.close();
    }
  });

  it("reescribe todas las referencias de una View una sola vez", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE INDEX idx_view_preferences_view ON actors(name);
        CREATE INDEX idx_view_preferences_actor ON actors(type);
        CREATE VIEW dependent_actor_multiple_indexes AS
          SELECT id FROM actors INDEXED BY idx_view_preferences_view
          UNION ALL
          SELECT id FROM actors INDEXED BY idx_view_preferences_actor;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_actor_multiple_indexes").all()).toEqual([
        ...db.query("SELECT id FROM actors ORDER BY id").all(),
        ...db.query("SELECT id FROM actors ORDER BY id").all(),
      ]);
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_actor_multiple_indexes'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_actor_multiple_indexes AS
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy"
          UNION ALL
          SELECT id FROM actors INDEXED BY "idx_view_preferences_actor_legacy"`,
      });
      const markers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      migrate(db);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(markers);
    } finally {
      db.close();
    }
  });

  it("resuelve INDEXED BY con casing y quoting sin falsos positivos de comentarios o literales", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE UNIQUE INDEX "IDX_VIEW_PREFERENCES_VIEW" ON actors(name);
        CREATE TABLE indexed (id TEXT PRIMARY KEY);
        INSERT INTO indexed (id) VALUES ('indexed-row');
        CREATE VIEW dependent_actor_quoted AS
          SELECT id FROM actors INDEXED BY [idx_view_preferences_view];
        CREATE VIEW dependent_actor_false_positive AS
          SELECT 'INDEXED BY IDX_VIEW_PREFERENCES_VIEW' AS value, id
            FROM actors /* INDEXED BY IDX_VIEW_PREFERENCES_VIEW */;
        CREATE VIEW dependent_actor_alias AS SELECT id FROM indexed by;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_actor_quoted").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(db.query("SELECT id FROM dependent_actor_alias").all()).toEqual([
        { id: "indexed-row" },
      ]);
      expect(
        db.query("SELECT value FROM dependent_actor_false_positive ORDER BY id").all(),
      ).toEqual(
        db
          .query("SELECT 'INDEXED BY IDX_VIEW_PREFERENCES_VIEW' AS value FROM actors ORDER BY id")
          .all(),
      );
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_actor_quoted'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_actor_quoted AS
          SELECT id FROM actors INDEXED BY "IDX_VIEW_PREFERENCES_VIEW_legacy"`,
      });
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_actor_false_positive'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_actor_false_positive AS
          SELECT 'INDEXED BY IDX_VIEW_PREFERENCES_VIEW' AS value, id
            FROM actors /* INDEXED BY IDX_VIEW_PREFERENCES_VIEW */`,
      });
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_actor_alias'",
          )
          .get(),
      ).toEqual({ sql: "CREATE VIEW dependent_actor_alias AS SELECT id FROM indexed by" });
    } finally {
      db.close();
    }
  });

  it("conserva índices partial con predicados distintos durante restore", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE INDEX partial_a ON saved_views(name) WHERE name = 'Legacy View';
        CREATE INDEX partial_b ON saved_views(name) WHERE name = 'Other View';
        CREATE VIEW dependent_saved_view_partial_a AS
          SELECT id FROM saved_views INDEXED BY partial_a WHERE name = 'Legacy View';
        CREATE VIEW dependent_saved_view_partial_b AS
          SELECT id FROM saved_views INDEXED BY partial_b WHERE name = 'Other View';
      `);

      migrate(db);

      expect(db.query("SELECT name FROM pragma_index_list('saved_views')").all()).toEqual(
        expect.arrayContaining([{ name: "partial_a" }, { name: "partial_b" }]),
      );
      expect(db.query("SELECT id FROM dependent_saved_view_partial_a").all()).toEqual([
        { id: "view-legacy" },
      ]);
      expect(db.query("SELECT id FROM dependent_saved_view_partial_b").all()).toEqual([]);
      expect(
        db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'partial_a'").get(),
      ).toEqual({ sql: "CREATE INDEX partial_a ON saved_views(name) WHERE name = 'Legacy View'" });
      expect(
        db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'partial_b'").get(),
      ).toEqual({ sql: "CREATE INDEX partial_b ON saved_views(name) WHERE name = 'Other View'" });
    } finally {
      db.close();
    }
  });

  it("reescribe dependencias de índices UNIQUE legacy materializados durante restore", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      addLegacySavedViewsNameConstraint(db);
      db.exec(`
        CREATE VIEW dependent_saved_view_unique AS
          SELECT id FROM saved_views INDEXED BY sqlite_autoindex_saved_views_3;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_saved_view_unique").all()).toEqual(
        db.query("SELECT id FROM saved_views ORDER BY id").all(),
      );
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_saved_view_unique'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_saved_view_unique AS
          SELECT id FROM saved_views INDEXED BY "idx_saved_views_legacy_unique_workspace_id_name"`,
      });
      expect(
        db
          .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_saved_views_legacy_unique_workspace_id_name'",
          )
          .get(),
      ).toEqual({
        name: "idx_saved_views_legacy_unique_workspace_id_name",
        tbl_name: "saved_views",
      });
    } finally {
      db.close();
    }
  });

  it("reescribe una TEMP View cuando restore materializa su índice legacy", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      addLegacySavedViewsNameConstraint(db);
      db.exec(`
        CREATE TEMP VIEW dependent_saved_view_temp_unique AS
          SELECT id FROM saved_views INDEXED BY sqlite_autoindex_saved_views_3;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_saved_view_temp_unique").all()).toEqual(
        db.query("SELECT id FROM saved_views ORDER BY id").all(),
      );
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_temp_master WHERE type = 'view' AND name = 'dependent_saved_view_temp_unique'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_saved_view_temp_unique AS
          SELECT id FROM saved_views INDEXED BY "idx_saved_views_legacy_unique_workspace_id_name"`,
      });
    } finally {
      db.close();
    }
  });

  it("reescribe el INDEXED BY de un Trigger renombrado cuando restore materializa un autoindex", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      addLegacySavedViewsNameConstraint(db);
      db.exec(`
        DROP TRIGGER saved_views_workspace_scope_insert;
        CREATE TRIGGER saved_views_workspace_scope_insert
        AFTER INSERT ON actors
        BEGIN
          SELECT id FROM saved_views INDEXED BY sqlite_autoindex_saved_views_3;
        END;
      `);

      expect(
        db
          .query(
            "SELECT name FROM pragma_index_list('saved_views') WHERE name = 'sqlite_autoindex_saved_views_3'",
          )
          .get(),
      ).toEqual({ name: "sqlite_autoindex_saved_views_3" });

      migrate(db);

      expect(() =>
        db
          .query(
            `INSERT INTO actors (id, name, type, created_at, updated_at)
             VALUES ('renamed-trigger-autoindex', 'renamed-trigger-autoindex', 'human', '2026-01-01', '2026-01-01')`,
          )
          .run(),
      ).not.toThrow();
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'saved_views_workspace_scope_insert_legacy'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE TRIGGER "saved_views_workspace_scope_insert_legacy"
        AFTER INSERT ON actors
        BEGIN
          SELECT id FROM saved_views INDEXED BY "idx_saved_views_legacy_unique_workspace_id_name";
        END`,
      });
    } finally {
      db.close();
    }
  });

  it("protege dependencias INDEXED BY durante la restauración de índices de saved_views", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_view ON saved_views(name);
        CREATE VIEW dependent_saved_view AS
          SELECT id FROM saved_views INDEXED BY idx_view_preferences_view;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_saved_view").all()).toEqual(
        db.query("SELECT id FROM saved_views ORDER BY id").all(),
      );
      expect(
        db
          .query(
            `SELECT sqlite_master.name, sqlite_master.tbl_name, "unique" AS unique_value FROM sqlite_master JOIN pragma_index_list('saved_views') ON pragma_index_list.name = sqlite_master.name WHERE sqlite_master.type = 'index' AND sqlite_master.name = 'idx_view_preferences_view_legacy'`,
          )
          .get(),
      ).toEqual({
        name: "idx_view_preferences_view_legacy",
        tbl_name: "saved_views",
        unique_value: 1,
      });
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_saved_view'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_saved_view AS
          SELECT id FROM saved_views INDEXED BY "idx_view_preferences_view_legacy"`,
      });
    } finally {
      db.close();
    }
  });

  it("falla cerrado antes de DDL ante un índice INDEXED BY inexistente y permite reparar", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE VIEW dependent_actor_missing_index AS
          SELECT id FROM actors INDEXED BY missing_actor_index;
      `);
      const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = () => migrate(db);

      expect(runMigration).toThrow(/missing or unrelated index missing_actor_index/i);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
      expect(runMigration).toThrow(/missing or unrelated index missing_actor_index/i);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

      db.exec("CREATE INDEX missing_actor_index ON actors(name)");
      migrate(db);

      expect(db.query("SELECT id FROM dependent_actor_missing_index").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
    } finally {
      db.close();
    }
  });

  it("falla cerrado y permite reintentar si INDEXED BY no tiene un identificador seguro", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_view ON actors(name);
        CREATE VIEW dependent_actor_invalid_index_token AS
          SELECT id FROM actors INDEXED BY 'idx_view_preferences_view';
      `);
      const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();

      expect(() => migrate(db)).toThrow(/invalid definition|INDEXED BY/i);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);

      db.exec(`
        DROP VIEW dependent_actor_invalid_index_token;
        CREATE VIEW dependent_actor_invalid_index_token AS
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view";
      `);
      migrate(db);
      expect(db.query("SELECT id FROM dependent_actor_invalid_index_token").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
    } finally {
      db.close();
    }
  });

  it("protege INDEXED BY en una instalación fresh", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_view ON actors(name);
        CREATE VIEW dependent_actor_fresh AS
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_actor_fresh").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_actor_fresh'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_actor_fresh AS
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy"`,
      });
    } finally {
      db.close();
    }
  });

  it("protege INDEXED BY al reconciliar el marker legacy de Views", () => {
    const db = databaseWithMigrationsThrough(30);
    try {
      seedLegacyViewsMigrationMarker(db);
      db.exec(`
        DROP INDEX idx_saved_views_workspace_id;
        CREATE UNIQUE INDEX idx_saved_views_workspace_id ON actors(name);
        CREATE VIEW dependent_actor_reconcile AS
          SELECT id FROM actors INDEXED BY idx_saved_views_workspace_id;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_actor_reconcile").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_actor_reconcile'",
          )
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_actor_reconcile AS
          SELECT id FROM actors INDEXED BY "idx_saved_views_workspace_id_legacy"`,
      });
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
    } finally {
      db.close();
    }
  });

  it("protege una View que usa INDEXED BY al renombrar un índice legacy", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE UNIQUE INDEX idx_view_preferences_view ON actors(name);
        CREATE VIEW dependent_actor AS
          SELECT id FROM actors INDEXED BY idx_view_preferences_view;
      `);

      migrate(db);

      expect(db.query("SELECT id FROM dependent_actor").all()).toEqual(
        db.query("SELECT id FROM actors ORDER BY id").all(),
      );
      expect(
        db
          .query("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'dependent_actor'")
          .get(),
      ).toEqual({
        sql: `CREATE VIEW dependent_actor AS
          SELECT id FROM actors INDEXED BY "idx_view_preferences_view_legacy"`,
      });
    } finally {
      db.close();
    }
  });
  it("preserva triggers MAIN custom de Views con contrato completo y orden", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      dropSavedViewsTriggers(db);
      db.exec(`
        CREATE TABLE custom_trigger_log (
          event TEXT NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TRIGGER "Custom Saved Insert"
        AFTER INSERT ON saved_views
        FOR EACH ROW
        WHEN NEW.name <> 'ignored'
        BEGIN
          INSERT INTO custom_trigger_log(event, value) VALUES ('insert', NEW.id);
          INSERT INTO custom_trigger_log(event, value) VALUES ('insert-name', NEW.name);
        END;
        CREATE TRIGGER custom_saved_update
        BEFORE UPDATE OF ID, "Name", SCOPE, team_id, owner_id, filter_json, order_by, group_by,
          created_at, updated_at, archived_at, columns_json, workspace_id ON saved_views
        WHEN OLD.name <> NEW.name AND NEW.scope = 'personal'
        BEGIN
          INSERT INTO custom_trigger_log(event, value) VALUES ('update', NEW.id);
          INSERT INTO custom_trigger_log(event, value) VALUES ('update-name', NEW.name);
        END;
      `);
      createLegacySavedViewsTriggers(db);

      const beforeRows = db
        .query(
          "SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by, " +
            "created_at, updated_at, archived_at, columns_json, workspace_id " +
            "FROM saved_views ORDER BY id",
        )
        .all();
      const beforeForeignKeys = db
        .query(
          'SELECT "table", seq, "from", "to", on_update, on_delete, match ' +
            "FROM pragma_foreign_key_list('saved_views') " +
            "WHERE \"table\" IN ('actors', 'workspace', 'teams') ORDER BY \"table\", seq",
        )
        .all();
      const beforeDefinitions = db
        .query(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND lower(name) IN ('custom saved insert', 'custom_saved_update') ORDER BY rowid",
        )
        .all();
      const beforeCanonical = db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('saved_views_workspace_scope_insert', 'saved_views_workspace_required_insert', 'saved_views_workspace_required_update') ORDER BY name",
        )
        .all();
      const beforeTriggerOrder = db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'saved_views' ORDER BY rowid",
        )
        .all();

      db.exec(`
        INSERT INTO saved_views
          (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
           created_at, updated_at, archived_at, columns_json, workspace_id)
        SELECT 'custom-before', 'Before', 'personal', NULL, actors.id, '{}', 'CREATED_DESC', 'state',
               '2026-01-01', '2026-01-01', NULL, '[]', workspace.id
          FROM workspace CROSS JOIN actors
         LIMIT 1;
        UPDATE saved_views SET name = 'After' WHERE id = 'custom-before';
      `);
      expect(db.query("SELECT event, value FROM custom_trigger_log ORDER BY rowid").all()).toEqual([
        { event: "insert", value: "custom-before" },
        { event: "insert-name", value: "Before" },
        { event: "update", value: "custom-before" },
        { event: "update-name", value: "After" },
      ]);
      db.exec(
        "DELETE FROM custom_trigger_log; DELETE FROM saved_views WHERE id = 'custom-before';",
      );

      migrate(db);

      expect(
        db
          .query(
            "SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by, " +
              "created_at, updated_at, archived_at, columns_json, workspace_id " +
              "FROM saved_views ORDER BY id",
          )
          .all(),
      ).toEqual(beforeRows);
      expect(
        db
          .query(
            'SELECT "table", seq, "from", "to", on_update, on_delete, match ' +
              "FROM pragma_foreign_key_list('saved_views') " +
              "WHERE \"table\" IN ('actors', 'workspace', 'teams') ORDER BY \"table\", seq",
          )
          .all(),
      ).toEqual(beforeForeignKeys);
      expect(
        db
          .query(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND lower(name) IN ('custom saved insert', 'custom_saved_update') ORDER BY rowid",
          )
          .all(),
      ).toEqual(beforeDefinitions);
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('saved_views_workspace_scope_insert', 'saved_views_workspace_required_insert', 'saved_views_workspace_required_update') ORDER BY name",
          )
          .all(),
      ).toEqual(beforeCanonical);
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'saved_views' ORDER BY rowid",
          )
          .all(),
      ).toEqual(beforeTriggerOrder);
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('saved_views_workspace_scope_insert', 'saved_views_workspace_required_insert', 'saved_views_workspace_required_update')",
          )
          .get(),
      ).toEqual({ count: 3 });
      expect(
        db.query("SELECT version FROM _migrations WHERE version >= 32 ORDER BY version").all(),
      ).toEqual([{ version: 32 }, { version: 33 }]);

      db.exec(`
        INSERT INTO saved_views
          (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
           created_at, updated_at, archived_at, columns_json, workspace_id)
        SELECT 'custom-after', 'Before', 'personal', NULL, actors.id, '{}', 'CREATED_DESC', 'state',
               '2026-01-01', '2026-01-01', NULL, '[]', workspace.id
          FROM workspace CROSS JOIN actors
         LIMIT 1;
        UPDATE saved_views SET name = 'After' WHERE id = 'custom-after';
      `);
      expect(db.query("SELECT event, value FROM custom_trigger_log ORDER BY rowid").all()).toEqual([
        { event: "insert", value: "custom-after" },
        { event: "insert-name", value: "Before" },
        { event: "update", value: "custom-after" },
        { event: "update-name", value: "After" },
      ]);
      db.exec("DELETE FROM custom_trigger_log; DELETE FROM saved_views WHERE id = 'custom-after';");

      migrate(db);

      expect(
        db
          .query(
            "SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by, " +
              "created_at, updated_at, archived_at, columns_json, workspace_id " +
              "FROM saved_views ORDER BY id",
          )
          .all(),
      ).toEqual(beforeRows);
      expect(
        db
          .query(
            'SELECT "table", seq, "from", "to", on_update, on_delete, match ' +
              "FROM pragma_foreign_key_list('saved_views') " +
              "WHERE \"table\" IN ('actors', 'workspace', 'teams') ORDER BY \"table\", seq",
          )
          .all(),
      ).toEqual(beforeForeignKeys);
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('saved_views_workspace_scope_insert', 'saved_views_workspace_required_insert', 'saved_views_workspace_required_update')",
          )
          .get(),
      ).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });

  it("falla antes del DDL si un trigger MAIN custom no es ejecutable", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      db.exec(`
        CREATE TRIGGER custom_saved_unexecutable
        AFTER INSERT ON saved_views
        BEGIN
          INSERT INTO missing_custom_trigger_table(value) VALUES (NEW.id);
        END;
      `);

      const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = (): string => {
        try {
          migrate(db);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "migration unexpectedly succeeded";
      };

      const firstError = runMigration();
      expect(firstError).toMatch(
        /migration 0033.*custom trigger custom_saved_unexecutable.*cannot be preserved safely/i,
      );
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);

      expect(runMigration()).toBe(firstError);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
    } finally {
      db.close();
    }
  });

  it("preserva triggers MAIN custom en una instalación fresh y sobre actors", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      bootstrap(db);
      db.exec(`
        CREATE TABLE custom_trigger_log (
          source TEXT NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TRIGGER custom_fresh_saved
        AFTER INSERT ON saved_views
        WHEN NEW.name = 'Fresh custom'
        BEGIN
          INSERT INTO custom_trigger_log(source, value) VALUES ('saved', NEW.id);
        END;
        CREATE TRIGGER custom_actor_update
        AFTER UPDATE OF name ON actors
        WHEN NEW.name <> OLD.name
        BEGIN
          INSERT INTO custom_trigger_log(source, value) VALUES ('actor', NEW.name);
        END;
      `);
      const beforeSavedTrigger = db
        .query(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_fresh_saved'",
        )
        .get();
      migrate(db);

      expect(
        db
          .query(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_fresh_saved'",
          )
          .get(),
      ).toEqual(beforeSavedTrigger);
      expect(
        db
          .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_actor_update'",
          )
          .get(),
      ).toEqual({ name: "custom_actor_update", tbl_name: "actors" });
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('saved_views_workspace_scope_insert', 'saved_views_workspace_required_insert', 'saved_views_workspace_required_update')",
          )
          .get(),
      ).toEqual({ count: 3 });
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);

      db.exec("UPDATE actors SET name = 'fresh-admin-after' WHERE name = 'admin';");
      db.exec(`
        INSERT INTO saved_views
          (id, name, scope, team_id, project_id, initiative_id, owner_id, filter_json, order_by,
           group_by, created_at, updated_at, archived_at, columns_json, workspace_id)
        SELECT 'fresh-custom-view', 'Fresh custom', 'personal', NULL, NULL, NULL, actors.id, '{}',
               'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]', workspace.id
          FROM workspace CROSS JOIN actors
         WHERE actors.name = 'fresh-admin-after'
         LIMIT 1;
      `);
      expect(db.query("SELECT source, value FROM custom_trigger_log ORDER BY rowid").all()).toEqual(
        [
          { source: "actor", value: "fresh-admin-after" },
          { source: "saved", value: "fresh-custom-view" },
        ],
      );

      migrate(db);

      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('saved_views_workspace_scope_insert', 'saved_views_workspace_required_insert', 'saved_views_workspace_required_update')",
          )
          .get(),
      ).toEqual({ count: 3 });
      expect(
        db
          .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_actor_update'",
          )
          .get(),
      ).toEqual({ name: "custom_actor_update", tbl_name: "actors" });
    } finally {
      db.close();
    }
  });

  it("conserva el trigger MAIN custom al reconciliar marker32 de Views", () => {
    const db = databaseWithMigrationsThrough(31);
    try {
      seedLegacyViewsMigrationMarker(db);
      db.exec(`
        CREATE TABLE reconcile_trigger_log (value TEXT NOT NULL);
        CREATE TRIGGER custom_reconcile_saved
        AFTER INSERT ON saved_views
        BEGIN
          INSERT INTO reconcile_trigger_log(value) VALUES (NEW.id);
        END;
      `);
      const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeDefinition = db
        .query(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_reconcile_saved'",
        )
        .get();
      const beforeCanonical = db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('saved_views_workspace_scope_insert', 'saved_views_workspace_required_insert', 'saved_views_workspace_required_update') ORDER BY name",
        )
        .all();

      migrate(db);

      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(
        db
          .query(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_reconcile_saved'",
          )
          .get(),
      ).toEqual(beforeDefinition);
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('saved_views_workspace_scope_insert', 'saved_views_workspace_required_insert', 'saved_views_workspace_required_update') ORDER BY name",
          )
          .all(),
      ).toEqual(beforeCanonical);
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);

      db.exec(`
        INSERT INTO saved_views
          (id, name, scope, team_id, project_id, initiative_id, owner_id, filter_json, order_by,
           group_by, created_at, updated_at, archived_at, columns_json, workspace_id)
        SELECT 'reconcile-custom-view', 'Reconcile custom', 'personal', NULL, NULL, NULL, actors.id,
               '{}', 'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]', workspace.id
          FROM workspace CROSS JOIN actors
         LIMIT 1;
      `);
      expect(db.query("SELECT value FROM reconcile_trigger_log").all()).toEqual([
        { value: "reconcile-custom-view" },
      ]);
      db.exec(
        "DELETE FROM saved_views WHERE id = 'reconcile-custom-view'; DELETE FROM reconcile_trigger_log;",
      );

      migrate(db);

      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_reconcile_saved'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('saved_views_workspace_scope_insert', 'saved_views_workspace_required_insert', 'saved_views_workspace_required_update')",
          )
          .get(),
      ).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });

  it("preserva triggers MAIN custom en la ruta legacy de rebuild de 0025", () => {
    const db = databaseWithMigrationsThrough(24);
    try {
      db.exec(`
        CREATE TABLE legacy_trigger_log (value TEXT NOT NULL);
        CREATE TRIGGER custom_legacy_saved
        AFTER INSERT ON saved_views
        BEGIN
          INSERT INTO legacy_trigger_log(value) VALUES (NEW.id);
        END;
      `);
      const beforeDefinition = db
        .query(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_legacy_saved'",
        )
        .get();

      migrate(db);

      expect(
        db
          .query(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_legacy_saved'",
          )
          .get(),
      ).toEqual(beforeDefinition);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });

      db.exec(`
        INSERT INTO workspace (id, name, url_key, created_at, updated_at)
        VALUES ('legacy-workspace', 'Legacy Workspace', 'legacy-workspace', '2026-01-01', '2026-01-01');
        INSERT INTO actors (id, name, type, created_at, updated_at)
        VALUES ('legacy-actor', 'Legacy Actor', 'human', '2026-01-01', '2026-01-01');
        INSERT INTO saved_views
          (id, name, scope, team_id, project_id, initiative_id, owner_id, filter_json, order_by,
           group_by, created_at, updated_at, archived_at, columns_json, workspace_id)
        VALUES ('legacy-custom-view', 'Legacy custom', 'personal', NULL, NULL, NULL, 'legacy-actor',
                '{}', 'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]', 'legacy-workspace');
      `);
      expect(db.query("SELECT value FROM legacy_trigger_log").all()).toEqual([
        { value: "legacy-custom-view" },
      ]);

      migrate(db);

      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_legacy_saved'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('saved_views_workspace_scope_insert', 'saved_views_workspace_required_insert', 'saved_views_workspace_required_update')",
          )
          .get(),
      ).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });

  it("falla cerrado ante un TEMP trigger de saved_views en el rebuild legacy de 0025", () => {
    const db = databaseWithMigrationsThrough(24);
    try {
      db.exec(`
        INSERT INTO workspace (id, name, url_key, created_at, updated_at)
        VALUES ('legacy-temp-workspace', 'Legacy Temp Workspace', 'legacy-temp-workspace', '2026-01-01', '2026-01-01');
        INSERT INTO actors (id, name, type, created_at, updated_at)
        VALUES ('legacy-temp-actor', 'Legacy Temp Actor', 'human', '2026-01-01', '2026-01-01');
        INSERT INTO saved_views
          (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
           created_at, updated_at, archived_at, columns_json, workspace_id)
        VALUES ('legacy-temp-view', 'Legacy Temp View', 'personal', NULL, 'legacy-temp-actor',
                '{}', 'CREATED_DESC', 'state', '2026-01-01', '2026-01-01', NULL, '[]',
                'legacy-temp-workspace');
        CREATE TEMP TABLE temp_legacy_trigger_log (value TEXT NOT NULL);
        CREATE TEMP TRIGGER temp_saved_views
        AFTER INSERT ON saved_views
        BEGIN
          INSERT INTO temp_legacy_trigger_log(value) VALUES (NEW.id);
        END;
      `);
      const beforeRows = db.query("SELECT * FROM saved_views ORDER BY id").all();
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeTempSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = (): string => {
        try {
          migrate(db);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "migration unexpectedly succeeded";
      };

      const firstError = runMigration();
      expect(firstError).toMatch(
        /migration 0025.*temporary trigger temp_saved_views on saved_views.*would be lost/i,
      );
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
      expect(
        db
          .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
          .all(),
      ).toEqual(beforeTempSchema);

      expect(runMigration()).toBe(firstError);
      expect(db.query("SELECT * FROM saved_views ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(
        db
          .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
          .all(),
      ).toEqual(beforeTempSchema);

      db.exec("DROP TRIGGER temp_saved_views");
      db.exec(`
        CREATE TEMP TRIGGER temp_actor_update
        AFTER UPDATE OF name ON actors
        BEGIN
          INSERT INTO temp_legacy_trigger_log(value) VALUES (NEW.name);
        END;
      `);
      migrate(db);

      expect(db.query("SELECT version FROM _migrations WHERE version = 25").get()).toEqual({
        version: 25,
      });
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(
        db.query("SELECT name, tbl_name FROM sqlite_temp_master WHERE type = 'trigger'").all(),
      ).toEqual([{ name: "temp_actor_update", tbl_name: "actors" }]);
      db.exec("UPDATE actors SET name = 'Legacy Temp Actor after' WHERE id = 'legacy-temp-actor'");
      expect(db.query("SELECT value FROM temp_legacy_trigger_log").all()).toEqual([
        { value: "Legacy Temp Actor after" },
      ]);
    } finally {
      db.close();
    }
  });

  it("preserva el contrato completo del trigger MAIN custom de teams en 0025", () => {
    const db = databaseWithMigrationsThrough(24);
    try {
      db.exec(`
        CREATE TABLE custom_teams_trigger_log (event TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TRIGGER "Custom Teams Before"
        BEFORE INSERT ON "TEAMS"
        FOR EACH ROW
        WHEN NEW.name <> 'ignored'
        BEGIN
          INSERT INTO custom_teams_trigger_log(event, value) VALUES ('before-insert', NEW.id);
        END;
        CREATE TRIGGER "Custom Teams Update"
        AFTER UPDATE OF "Name" ON "teams"
        WHEN OLD.name <> NEW.name
        BEGIN
          INSERT INTO custom_teams_trigger_log(event, value) VALUES ('after-update', NEW.name);
        END;
        CREATE TRIGGER custom_teams_delete
        AFTER DELETE ON teams
        BEGIN
          INSERT INTO custom_teams_trigger_log(event, value) VALUES ('after-delete', OLD.id);
        END;
      `);
      const beforeDefinitions = db
        .query(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND lower(name) IN ('custom teams before', 'custom teams update', 'custom_teams_delete') ORDER BY rowid",
        )
        .all();

      migrate(db);

      expect(
        db
          .query(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND lower(name) IN ('custom teams before', 'custom teams update', 'custom_teams_delete') ORDER BY rowid",
          )
          .all(),
      ).toEqual(beforeDefinitions);
      expect(
        db
          .query(
            "SELECT name, count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND lower(name) IN ('custom teams before', 'custom teams update', 'custom_teams_delete') GROUP BY lower(name) ORDER BY lower(name)",
          )
          .all(),
      ).toEqual([
        { name: "Custom Teams Before", count: 1 },
        { name: "Custom Teams Update", count: 1 },
        { name: "custom_teams_delete", count: 1 },
      ]);

      bootstrap(db);
      db.exec("DELETE FROM custom_teams_trigger_log");
      const workspaceId = String(
        db.query("SELECT id FROM workspace ORDER BY id LIMIT 1").values()[0]?.[0] ?? "",
      );
      db.query(
        "INSERT INTO teams (id, workspace_id, name, key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      ).run("custom-team-events", workspaceId, "Before", "CTE", "2026-01-01");
      db.query("UPDATE teams SET name = ?1 WHERE id = ?2").run("After", "custom-team-events");
      db.query("DELETE FROM teams WHERE id = ?1").run("custom-team-events");
      expect(
        db.query("SELECT event, value FROM custom_teams_trigger_log ORDER BY rowid").all(),
      ).toEqual([
        { event: "before-insert", value: "custom-team-events" },
        { event: "after-update", value: "After" },
        { event: "after-delete", value: "custom-team-events" },
      ]);
    } finally {
      db.close();
    }
  });

  it("falla cerrado y permite reparar un trigger MAIN custom con dependencia no preservable en 0025", () => {
    const db = databaseWithMigrationsThrough(24);
    try {
      db.exec(`
        CREATE TABLE custom_teams_trigger_log (value TEXT NOT NULL);
        CREATE TRIGGER custom_teams_unexecutable
        AFTER INSERT ON teams
        BEGIN
          INSERT INTO missing_custom_teams_table(value) VALUES (NEW.id);
        END;
      `);
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = (): string => {
        try {
          migrate(db);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "migration unexpectedly succeeded";
      };

      const firstError = runMigration();
      expect(firstError).toMatch(
        /migration 0025.*custom trigger custom_teams_unexecutable on teams.*cannot be preserved safely/i,
      );
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
      expect(runMigration()).toBe(firstError);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);

      db.exec(`
        DROP TRIGGER custom_teams_unexecutable;
        CREATE TRIGGER custom_teams_unexecutable
        AFTER INSERT ON teams
        BEGIN
          INSERT INTO custom_teams_trigger_log(value) VALUES (NEW.id);
        END;
      `);
      migrate(db);
      expect(db.query("SELECT version FROM _migrations WHERE version = 25").get()).toEqual({
        version: 25,
      });
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'custom_teams_unexecutable'",
          )
          .get(),
      ).toEqual({ name: "custom_teams_unexecutable" });
    } finally {
      db.close();
    }
  });

  it("revierte 0025 si el DDL elimina una columna usada por un trigger custom", () => {
    const db = databaseWithMigrationsThrough(24);
    try {
      db.exec(`
        ALTER TABLE teams ADD COLUMN legacy_custom_value TEXT;
        CREATE TABLE custom_teams_trigger_log (value TEXT NOT NULL);
        CREATE TRIGGER custom_teams_dropped_column
        AFTER INSERT ON teams
        BEGIN
          INSERT INTO custom_teams_trigger_log(value) VALUES (NEW.legacy_custom_value);
        END;
      `);
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = (): string => {
        try {
          migrate(db);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "migration unexpectedly succeeded";
      };

      const firstError = runMigration();
      expect(firstError).toMatch(
        /migration 0025.*custom trigger custom_teams_dropped_column on teams.*cannot be preserved safely/i,
      );
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
      expect(runMigration()).toBe(firstError);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
    } finally {
      db.close();
    }
  });

  it("falla cerrado para TEMP en cualquier tabla reconstruida y conserva TEMP sobre actors", () => {
    const db = databaseWithMigrationsThrough(24);
    try {
      db.exec(`
        CREATE TEMP TABLE temp_rebuild_trigger_log (value TEXT NOT NULL);
        CREATE TEMP TRIGGER temp_teams_insert
        AFTER INSERT ON teams
        BEGIN
          INSERT INTO temp_rebuild_trigger_log(value) VALUES (NEW.id);
        END;
      `);
      const beforeRows = db.query("SELECT * FROM teams ORDER BY id").all();
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeTempSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = (): string => {
        try {
          migrate(db);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "migration unexpectedly succeeded";
      };

      const firstError = runMigration();
      expect(firstError).toMatch(
        /migration 0025.*temporary trigger temp_teams_insert on teams.*would be lost/i,
      );
      expect(db.query("SELECT * FROM teams ORDER BY id").all()).toEqual(beforeRows);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
      expect(
        db
          .query("SELECT type, name, tbl_name, sql FROM sqlite_temp_master ORDER BY type, name")
          .all(),
      ).toEqual(beforeTempSchema);
      expect(runMigration()).toBe(firstError);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

      db.exec(`
        DROP TRIGGER temp_teams_insert;
        CREATE TEMP TRIGGER temp_actor_update
        AFTER UPDATE OF name ON actors
        BEGIN
          INSERT INTO temp_rebuild_trigger_log(value) VALUES (NEW.name);
        END;
      `);
      migrate(db);
      bootstrap(db);
      expect(
        db
          .query(
            "SELECT name, tbl_name FROM sqlite_temp_master WHERE type = 'trigger' ORDER BY rowid",
          )
          .all(),
      ).toEqual([{ name: "temp_actor_update", tbl_name: "actors" }]);
      db.query("UPDATE actors SET name = ?1 WHERE name = ?2").run("temp-actor-after", "admin");
      expect(db.query("SELECT value FROM temp_rebuild_trigger_log ORDER BY rowid").all()).toEqual([
        { value: "temp-actor-after" },
      ]);
    } finally {
      db.close();
    }
  });

  it("rechaza una colisión de nombre canónico custom antes del DDL de 0025", () => {
    const db = databaseWithMigrationsThrough(24);
    try {
      db.exec(`
        CREATE TABLE custom_canonical_trigger_log (value TEXT NOT NULL);
        DROP TRIGGER teams_workspace_scope_insert;
        CREATE TRIGGER teams_workspace_scope_insert
        AFTER INSERT ON teams
        BEGIN
          INSERT INTO custom_canonical_trigger_log(value) VALUES (NEW.id);
        END;
      `);
      const beforeSchema = db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all();
      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const runMigration = (): string => {
        try {
          migrate(db);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "migration unexpectedly succeeded";
      };
      const firstError = runMigration();
      expect(firstError).toMatch(
        /migration 0025.*canonical trigger teams_workspace_scope_insert on teams is incompatible/i,
      );
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(
        db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);
      expect(runMigration()).toBe(firstError);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);

      db.exec("DROP TRIGGER teams_workspace_scope_insert;");
      migrate(db);
      expect(db.query("SELECT version FROM _migrations WHERE version = 25").get()).toEqual({
        version: 25,
      });
    } finally {
      db.close();
    }
  });

  it("conserva el orden, las definiciones y el comportamiento de los canónicos de 0025", () => {
    const legacy = databaseWithMigrationsThrough(24);
    const fresh = openDatabase(":memory:");
    const canonicalDefinitions = (db: Database) =>
      db
        .query<{ name: string; tbl_name: string; sql: string }, SQLQueryBindings[]>(
          "SELECT name, tbl_name, sql FROM sqlite_master " +
            "WHERE type = 'trigger' AND lower(tbl_name) <> 'issue_subscribers' AND (" +
            "lower(name) LIKE '%_workspace_scope_insert' OR " +
            "lower(name) LIKE '%_workspace_required_insert' OR " +
            "lower(name) LIKE '%_workspace_required_update' OR " +
            "lower(name) LIKE 'issues_fts_%') ORDER BY rowid",
        )
        .all();
    const runCanonicalBehavior = (db: Database) => {
      bootstrap(db);
      const workspaceId = String(
        db.query("SELECT id FROM workspace ORDER BY id LIMIT 1").values()[0]?.[0] ?? "",
      );
      const teamId = String(
        db.query("SELECT id FROM teams ORDER BY id LIMIT 1").values()[0]?.[0] ?? "",
      );
      const stateId = String(
        db
          .query("SELECT id FROM workflow_states WHERE team_id = ?1 ORDER BY id LIMIT 1")
          .values(teamId)[0]?.[0] ?? "",
      );
      const actorId = String(
        db.query("SELECT id FROM actors ORDER BY id LIMIT 1").values()[0]?.[0] ?? "",
      );
      db.query(
        "INSERT INTO teams (id, workspace_id, name, key, created_at, updated_at) " +
          "VALUES (?1, NULL, ?2, ?3, ?4, ?4)",
      ).run("canonical-order-team", "Canonical Order", "COT", "2026-01-01");
      const filledWorkspaceId = String(
        db
          .query("SELECT workspace_id FROM teams WHERE id = 'canonical-order-team'")
          .values()[0]?.[0] ?? "",
      );
      db.query(
        "INSERT INTO issues (id, workspace_id, team_id, number, title, description, state_id, creator_id, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
      ).run(
        "canonical-order-issue",
        workspaceId,
        teamId,
        1,
        "Canonical title",
        "Canonical description",
        stateId,
        actorId,
        "2026-01-01",
      );
      const ftsAfterInsert = db
        .query(
          "SELECT title, description FROM issues_fts " +
            "WHERE rowid = (SELECT rowid FROM issues WHERE id = 'canonical-order-issue')",
        )
        .all();
      db.query("UPDATE issues SET title = ?1 WHERE id = ?2").run(
        "Canonical updated title",
        "canonical-order-issue",
      );
      const ftsAfterUpdate = db
        .query(
          "SELECT title, description FROM issues_fts " +
            "WHERE rowid = (SELECT rowid FROM issues WHERE id = 'canonical-order-issue')",
        )
        .all();
      return {
        teamWorkspaceMatches: filledWorkspaceId === workspaceId,
        ftsAfterInsert,
        ftsAfterUpdate,
      };
    };

    try {
      migrate(legacy);
      const legacyDefinitions = canonicalDefinitions(legacy);
      const freshDefinitions = canonicalDefinitions(fresh);
      expect(legacyDefinitions).toEqual(freshDefinitions);
      const canonicalNames = legacyDefinitions.map((definition) => definition.name.toLowerCase());
      expect(canonicalNames).toHaveLength(new Set(canonicalNames).size);
      const legacyBehavior = runCanonicalBehavior(legacy);
      const freshBehavior = runCanonicalBehavior(fresh);
      expect(legacyBehavior).toEqual(freshBehavior);
      expect(legacyBehavior.teamWorkspaceMatches).toBe(true);
      expect(legacyBehavior.ftsAfterInsert).toEqual([
        { title: "Canonical title", description: "Canonical description" },
      ]);
      expect(legacyBehavior.ftsAfterUpdate).toEqual([
        { title: "Canonical updated title", description: "Canonical description" },
      ]);
    } finally {
      legacy.close();
      fresh.close();
    }
  });

  it("preserva los triggers MAIN custom de todas las tablas reconstruidas por 0025", () => {
    const db = databaseWithMigrationsThrough(24);
    const rebuiltTables = [
      "teams",
      "workflow_states",
      "projects",
      "milestones",
      "issues",
      "labels",
      "cycles",
      "project_teams",
      "issue_labels",
      "issue_relations",
      "comments",
      "activity",
      "webhooks",
      "reviews",
      "initiatives",
      "initiative_projects",
      "initiative_teams",
      "project_updates",
      "team_memberships",
      "api_key_team_limits",
      "inbox_receipts",
      "favorites",
      "actor_invitations",
    ];
    try {
      db.exec("CREATE TABLE custom_rebuild_log (table_name TEXT NOT NULL)");
      for (const table of rebuiltTables) {
        const triggerName = `custom_rebuild_${table}`;
        db.exec(`
          CREATE TRIGGER ${quoteTestIdentifier(triggerName)}
          AFTER INSERT ON ${quoteTestIdentifier(table)}
          BEGIN
            INSERT INTO custom_rebuild_log(table_name) VALUES (${quoteTestLiteral(table)});
          END;
        `);
      }
      const beforeDefinitions = db
        .query(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'custom_rebuild_%' ORDER BY rowid",
        )
        .all();

      migrate(db);

      expect(
        db
          .query(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'custom_rebuild_%' ORDER BY rowid",
          )
          .all(),
      ).toEqual(beforeDefinitions);
      expect(
        db
          .query("SELECT version FROM _migrations WHERE version IN (25, 32, 33) ORDER BY version")
          .all(),
      ).toEqual([{ version: 25 }, { version: 32 }, { version: 33 }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      bootstrap(db);
      db.exec("DELETE FROM custom_rebuild_log");
      const workspaceId = String(
        db.query("SELECT id FROM workspace LIMIT 1").values()[0]?.[0] ?? "",
      );
      const actorId = String(
        db.query("SELECT id FROM actors ORDER BY id LIMIT 1").values()[0]?.[0] ?? "",
      );
      const teamId = String(
        db.query("SELECT id FROM teams ORDER BY id LIMIT 1").values()[0]?.[0] ?? "",
      );
      const stateId = String(
        db
          .query("SELECT id FROM workflow_states WHERE team_id = ?1 ORDER BY id LIMIT 1")
          .values(teamId)[0]?.[0] ?? "",
      );
      const apiKeyId = String(
        db.query("SELECT id FROM api_keys ORDER BY id LIMIT 1").values()[0]?.[0] ?? "",
      );

      db.query(
        "INSERT INTO teams (id, workspace_id, name, key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      ).run("custom-team", workspaceId, "Custom Team", "CTM", "2026-01-01");
      db.query(
        "INSERT INTO workflow_states (id, workspace_id, team_id, name, type, color, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
      ).run(
        "custom-state",
        workspaceId,
        teamId,
        "Custom State",
        "started",
        "#fff",
        99,
        "2026-01-01",
      );
      db.query(
        "INSERT INTO projects (id, workspace_id, name, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      ).run("custom-project", workspaceId, "Custom Project", "backlog", "2026-01-01");
      db.query(
        "INSERT INTO milestones (id, workspace_id, project_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      ).run("custom-milestone", workspaceId, "custom-project", "Custom Milestone", "2026-01-01");
      db.query(
        "INSERT INTO issues (id, workspace_id, team_id, number, title, state_id, creator_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
      ).run(
        "custom-issue-1",
        workspaceId,
        teamId,
        1,
        "Custom Issue 1",
        stateId,
        actorId,
        "2026-01-01",
      );
      db.query(
        "INSERT INTO issues (id, workspace_id, team_id, number, title, state_id, creator_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
      ).run(
        "custom-issue-2",
        workspaceId,
        teamId,
        2,
        "Custom Issue 2",
        stateId,
        actorId,
        "2026-01-01",
      );
      db.query(
        "INSERT INTO labels (id, workspace_id, name, color, team_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).run("custom-label", workspaceId, "Custom Label", "#fff", teamId, "2026-01-01");
      db.query(
        "INSERT INTO cycles (id, workspace_id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
      ).run(
        "custom-cycle",
        workspaceId,
        teamId,
        1,
        "Custom Cycle",
        "2026-01-01",
        "2026-01-02",
        "upcoming",
        "2026-01-01",
      );
      db.query(
        "INSERT INTO project_teams (project_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
      ).run("custom-project", teamId, workspaceId);
      db.query(
        "INSERT INTO issue_labels (issue_id, label_id, workspace_id) VALUES (?1, ?2, ?3)",
      ).run("custom-issue-1", "custom-label", workspaceId);
      db.query(
        "INSERT INTO issue_relations (id, issue_id, related_id, type, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).run(
        "custom-relation",
        "custom-issue-1",
        "custom-issue-2",
        "related",
        "2026-01-01",
        workspaceId,
      );
      db.query(
        "INSERT INTO comments (id, issue_id, actor_id, body, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).run(
        "custom-comment",
        "custom-issue-1",
        actorId,
        "Custom Comment",
        "2026-01-01",
        workspaceId,
      );
      db.query(
        "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).run(
        "custom-activity",
        "custom-issue-1",
        actorId,
        "custom",
        "{}",
        "2026-01-01",
        workspaceId,
      );
      db.query(
        "INSERT INTO webhooks (id, workspace_id, url, secret, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).run(
        "custom-webhook",
        workspaceId,
        "https://example.test",
        "fixture-webhook-value",
        "2026-01-01",
      );
      db.query(
        "INSERT INTO reviews (id, workspace_id, issue_id, requester_id, reviewer_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
      ).run(
        "custom-review",
        workspaceId,
        "custom-issue-1",
        actorId,
        actorId,
        "requested",
        "2026-01-01",
      );
      db.query(
        "INSERT INTO initiatives (id, workspace_id, name, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      ).run("custom-initiative", workspaceId, "Custom Initiative", "planned", "2026-01-01");
      db.query(
        "INSERT INTO initiative_projects (initiative_id, project_id, workspace_id) VALUES (?1, ?2, ?3)",
      ).run("custom-initiative", "custom-project", workspaceId);
      db.query(
        "INSERT INTO initiative_teams (initiative_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
      ).run("custom-initiative", teamId, workspaceId);
      db.query(
        "INSERT INTO project_updates (id, workspace_id, project_id, author_id, health, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
      ).run(
        "custom-update",
        workspaceId,
        "custom-project",
        actorId,
        "on_track",
        "Custom Update",
        "2026-01-01",
      );
      db.query(
        "INSERT INTO actors (id, name, type, workspace_role, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
      ).run("custom-actor", "Custom Actor", "human", "member", "active", "2026-01-01");
      db.query(
        "INSERT INTO team_memberships (id, workspace_id, team_id, actor_id, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).run("custom-membership", workspaceId, teamId, "custom-actor", "member", "2026-01-01");
      db.query(
        "INSERT INTO api_key_team_limits (api_key_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
      ).run(apiKeyId, teamId, workspaceId);
      db.query(
        "INSERT INTO inbox_receipts (activity_id, actor_id, workspace_id) VALUES (?1, ?2, ?3)",
      ).run("custom-activity", actorId, workspaceId);
      db.query(
        "INSERT INTO favorites (id, actor_id, project_id, position, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).run("custom-favorite", actorId, "custom-project", 0, "2026-01-01", workspaceId);
      db.query(
        "INSERT INTO actor_invitations (id, workspace_id, email, name, type, token_hash, status, invited_by, metadata_json, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
      ).run(
        "custom-invitation",
        workspaceId,
        "custom@example.test",
        "Custom Invitation",
        "human",
        "fixture-invitation-value",
        "pending",
        actorId,
        "{}",
        "2026-01-01",
        "2027-01-01",
      );

      expect(
        db
          .query(
            "SELECT table_name, count(*) AS count FROM custom_rebuild_log GROUP BY table_name ORDER BY table_name",
          )
          .all(),
      ).toEqual(
        rebuiltTables
          .map((table) => ({ table_name: table, count: table === "issues" ? 2 : 1 }))
          .sort((left, right) => left.table_name.localeCompare(right.table_name)),
      );
      const definitionsAfterInsert = db
        .query(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'custom_rebuild_%' ORDER BY rowid",
        )
        .all();
      expect(definitionsAfterInsert).toEqual(beforeDefinitions);

      const beforeMarkers = db.query("SELECT * FROM _migrations ORDER BY version").all();
      const beforeLog = db.query("SELECT * FROM custom_rebuild_log ORDER BY rowid").all();
      migrate(db);
      expect(db.query("SELECT * FROM _migrations ORDER BY version").all()).toEqual(beforeMarkers);
      expect(db.query("SELECT * FROM custom_rebuild_log ORDER BY rowid").all()).toEqual(beforeLog);
      expect(
        db
          .query(
            "SELECT name, count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'custom_rebuild_%' GROUP BY name ORDER BY name",
          )
          .all(),
      ).toEqual(
        rebuiltTables
          .map((table) => ({ name: `custom_rebuild_${table}`, count: 1 }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
